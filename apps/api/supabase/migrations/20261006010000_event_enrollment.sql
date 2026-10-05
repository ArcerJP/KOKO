-- B1-4: explicit first enrollment. No event, user, consent or cloud setting is seeded.
BEGIN;

CREATE FUNCTION public.read_event_enrollment(p_event_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  settings_row public.event_settings%ROWTYPE;
  observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_event_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  SELECT * INTO event_row FROM public.events WHERE event_id=p_event_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id=p_user_id) THEN
    RETURN jsonb_build_object('code','FORBIDDEN');
  END IF;
  IF EXISTS (SELECT 1 FROM public.event_members WHERE event_id=p_event_id AND user_id=p_user_id) THEN
    RETURN jsonb_build_object('code','ok','status','enrolled','can_enroll',false);
  END IF;
  SELECT * INTO settings_row FROM public.event_settings WHERE event_id=p_event_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','INTERNAL_ERROR'); END IF;
  RETURN jsonb_build_object('code','ok','status','not_enrolled','can_enroll',
    event_row.status='live' AND observed_at>=event_row.starts_at AND observed_at<event_row.ends_at
      AND settings_row.uploads_enabled AND NOT settings_row.publication_stopped);
END;
$$;

CREATE FUNCTION public.enroll_event(p_event_id uuid, p_user_id uuid, p_display_name text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  settings_row public.event_settings%ROWTYPE;
  inserted_user uuid;
  admitted_at timestamptz;
BEGIN
  -- ON CONFLICT and the following statement must see the winning committed row.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='enroll_event requires READ COMMITTED';
  END IF;
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_display_name IS NULL
    OR char_length(p_display_name) NOT BETWEEN 1 AND 50
    OR p_display_name !~ '[^[:space:]]' OR p_display_name ~ '[[:cntrl:]]'
    -- Reject common invisible format controls too; the HTTP boundary rejects all Unicode Cc/Cf.
    OR p_display_name ~ U&'[\00AD\061C\180E\200B-\200F\202A-\202E\2060-\206F\FEFF\FFF9-\FFFB]' THEN
    RETURN 'INVALID_INPUT';
  END IF;
  -- Keep the existing event -> settings -> member policy lock order.
  SELECT * INTO event_row FROM public.events WHERE event_id=p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO settings_row FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
  PERFORM 1 FROM public.event_members WHERE event_id=p_event_id AND user_id=p_user_id FOR KEY SHARE;
  IF FOUND THEN RETURN 'enrolled'; END IF; -- Never overwrite name, role, BAN, counters or consent.
  IF settings_row.event_id IS NULL THEN RETURN 'INTERNAL_ERROR'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RETURN 'FORBIDDEN'; END IF;
  admitted_at:=clock_timestamp();
  IF event_row.status<>'live' OR admitted_at<event_row.starts_at OR admitted_at>=event_row.ends_at
    OR NOT settings_row.uploads_enabled THEN RETURN 'EVENT_CLOSED'; END IF;
  IF settings_row.publication_stopped THEN RETURN 'PUBLICATION_STOPPED'; END IF;

  INSERT INTO public.event_members(event_id,user_id,display_name,role,is_banned,block_count,published_post_count,crown)
    VALUES(p_event_id,p_user_id,p_display_name,'user',false,0,0,'none')
    ON CONFLICT (event_id,user_id) DO NOTHING RETURNING user_id INTO inserted_user;
  IF inserted_user IS NULL THEN
    PERFORM 1 FROM public.event_members WHERE event_id=p_event_id AND user_id=p_user_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='Enrollment was not inserted';
    END IF;
  END IF;
  RETURN 'enrolled';
END;
$$;

REVOKE ALL ON FUNCTION public.read_event_enrollment(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.enroll_event(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_event_enrollment(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.enroll_event(uuid,uuid,text) TO service_role;
COMMENT ON FUNCTION public.read_event_enrollment(uuid,uuid) IS 'Service-only enrollment preflight after Google identity and fixed event verification. Read only; no profile, roles or BAN disclosure.';
COMMENT ON FUNCTION public.enroll_event(uuid,uuid,text) IS 'Service-only first enrollment after Google identity, fixed event and Cookie CSRF verification. Fixed user defaults; existing members unchanged; no consent.';
NOTIFY pgrst,'reload schema';
COMMIT;
