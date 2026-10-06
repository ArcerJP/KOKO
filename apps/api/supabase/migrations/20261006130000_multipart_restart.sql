-- Application upload UUID is the provider-generation fence. Old IDs resolve only
-- through this recovery RPC, never through parts, refresh, or complete.
BEGIN;
ALTER TABLE public.upload_sessions ADD COLUMN previous_upload_ids uuid[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(previous_upload_ids)<=2);

CREATE FUNCTION public.recover_upload_session(
  p_event_id uuid,p_user_id uuid,p_upload_id uuid,p_action text,p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=''
AS $$
DECLARE
  s public.upload_sessions%ROWTYPE;
  initial_request jsonb;
  reservation jsonb;
  result jsonb;
  attempt uuid;
  deadline timestamptz;
  target_post_id uuid;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='Recovery requires READ COMMITTED';
  END IF;
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_upload_id IS NULL
    OR p_action IS NULL OR p_action NOT IN ('inspect','restart')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_input->'attempt_id') IS DISTINCT FROM 'string'
    OR (p_input->>'attempt_id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (p_action='inspect' AND p_input-'attempt_id'<>'{}'::jsonb)
    OR (p_action='restart' AND (p_input-ARRAY['attempt_id','provider_upload_id']<>'{}'::jsonb
      OR jsonb_typeof(p_input->'provider_upload_id') IS DISTINCT FROM 'string')) THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  attempt:=(p_input->>'attempt_id')::uuid;
  -- Discovery is owner/event scoped. Recheck mutable state after admission locks.
  SELECT p.upload_request,p.id INTO initial_request,target_post_id
    FROM public.upload_sessions u JOIN public.posts p ON p.event_id=u.event_id AND p.id=u.post_id
    WHERE u.event_id=p_event_id AND p.user_id=p_user_id
      AND (u.id=p_upload_id OR p_upload_id=ANY(u.previous_upload_ids));
  IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  reservation:=public.reserve_upload(p_event_id,p_user_id,initial_request);
  IF reservation->>'code'<>'reserved' THEN RETURN reservation; END IF;
  SELECT * INTO s FROM public.upload_sessions u WHERE u.event_id=p_event_id AND u.post_id=target_post_id FOR UPDATE;
  IF s.id IS NULL OR s.mode<>'multipart' OR s.completed_at IS NOT NULL
    OR NOT(s.id=p_upload_id OR p_upload_id=ANY(s.previous_upload_ids)) THEN
    RETURN jsonb_build_object('code','STATE_CONFLICT');
  END IF;
  IF p_action='restart' THEN
    -- Worker-only after exact NoSuchUpload + absent direct HEAD. A browser never
    -- supplies this proof. Lock serializes with completion prepare and restart.
    IF s.id<>p_upload_id OR s.provisioning_state<>'ready' OR s.completion_parts IS NOT NULL
      OR s.provider_upload_id IS DISTINCT FROM p_input->>'provider_upload_id'
      OR s.provisioning_attempts NOT BETWEEN 1 AND 2
      OR EXISTS(SELECT 1 FROM public.media_assets a WHERE a.event_id=p_event_id AND a.id=s.asset_id
        AND (a.object_version IS NOT NULL OR a.object_etag IS NOT NULL)) THEN
      RETURN jsonb_build_object('code','STATE_CONFLICT');
    END IF;
    SELECT date_trunc('second',least(clock_timestamp()+interval '15 minutes',e.ends_at,t.ends_at))
      INTO deadline FROM public.events e LEFT JOIN public.themes t
      ON t.event_id=e.event_id AND t.id=(initial_request->>'theme_id')::uuid WHERE e.event_id=p_event_id;
    IF deadline<=clock_timestamp() THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
    UPDATE public.upload_sessions SET id=gen_random_uuid(),previous_upload_ids=array_append(previous_upload_ids,id),
      provider_upload_id=NULL,provisioning_state='provisioning',provisioning_attempt=attempt,
      provisioning_attempts=provisioning_attempts+1,provisioning_locked_until=least(clock_timestamp()+interval '2 minutes',deadline),
      expires_at=deadline WHERE id=s.id RETURNING * INTO s;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery claim missing'; END IF;
    result:=reservation||jsonb_build_object('code','provision','upload_id',s.id,'mode',s.mode,
      'expires_at',s.expires_at,'provider_upload_id',NULL,'provisioning_attempt',attempt,
      'provisioning_locked_until',s.provisioning_locked_until);
  ELSE
    result:=public.manage_upload_session(p_event_id,p_user_id,
      CASE WHEN s.provisioning_state='provisioning' THEN 'open' ELSE 'refresh' END,
      CASE WHEN s.provisioning_state='provisioning'
        THEN jsonb_build_object('request',initial_request,'attempt_id',attempt)
        ELSE jsonb_build_object('upload_id',s.id) END);
  END IF;
  RETURN result||jsonb_build_object('restartable',s.completion_parts IS NULL,
    'previous_upload_id',p_upload_id);
END;
$$;
REVOKE ALL ON FUNCTION public.recover_upload_session(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recover_upload_session(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.recover_upload_session(uuid,uuid,uuid,text,jsonb) IS 'Worker-only finite recovery before completion prepare. Caller must reauthenticate Google/CSRF and prove exact missing provider plus absent original before restart. Previous UUIDs are never aliases for complete or part issuance.';
NOTIFY pgrst,'reload schema';
COMMIT;
