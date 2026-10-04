-- B1-6 completion path. Local-only until separately reviewed/applied.
BEGIN;
ALTER TABLE public.upload_sessions
  ADD COLUMN completion_parts jsonb CHECK (completion_parts IS NULL OR jsonb_typeof(completion_parts)='array'),
  ADD COLUMN completion_result jsonb CHECK (completion_result IS NULL OR (jsonb_typeof(completion_result)='object' AND completed_at IS NOT NULL));
ALTER TABLE public.media_assets
  ADD COLUMN object_etag text,
  ADD COLUMN object_version text;
COMMENT ON COLUMN public.media_assets.object_etag IS 'R2 observation, not SHA256, detected MIME, or a safety verdict.';
COMMENT ON COLUMN public.media_assets.object_version IS 'R2 version observed by HEAD; processing must recheck identity before consuming bytes.';

CREATE FUNCTION public.complete_upload(
  p_event_id uuid, p_user_id uuid, p_post_id uuid, p_upload_id uuid,
  p_action text, p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  member_row public.event_members%ROWTYPE;
  post_row public.posts%ROWTYPE;
  asset_row public.media_assets%ROWTYPE;
  session_row public.upload_sessions%ROWTYPE;
  reservation jsonb;
  parts jsonb;
  item jsonb;
  observation jsonb;
  ack jsonb;
  size_bytes bigint;
  part_size bigint;
  part_count integer;
  ordinal integer := 0;
  expected_etag text;
  observed_at timestamptz;
  inserted_id uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='complete_upload requires READ COMMITTED';
  END IF;
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_post_id IS NULL OR p_upload_id IS NULL
    OR p_action IS NULL OR p_action NOT IN ('prepare','commit')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF jsonb_typeof(p_input->'parts') IS DISTINCT FROM 'array'
    OR (p_action='prepare' AND p_input-'parts' <> '{}'::jsonb)
    OR (p_action='commit' AND (NOT (p_input ?& ARRAY['observation','post_version'])
      OR p_input-ARRAY['parts','observation','post_version'] <> '{}'::jsonb)) THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  parts := p_input->'parts';
  IF jsonb_array_length(parts)>10000 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(parts) LOOP
    ordinal := ordinal+1;
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['part_number','etag'] <> '{}'::jsonb
      OR jsonb_typeof(item->'part_number') IS DISTINCT FROM 'number'
      OR (item->>'part_number')::numeric <> ordinal
      OR jsonb_typeof(item->'etag') IS DISTINCT FROM 'string'
      OR (item->>'etag') !~ '^[0-9a-f]{32}$' THEN
      RETURN jsonb_build_object('code','INVALID_INPUT');
    END IF;
  END LOOP;

  -- Same lock order as reserve_upload. Completed retries still verify identity,
  -- membership, BAN and current consent, but do not reopen an event or enqueue work.
  SELECT * INTO event_row FROM public.events WHERE event_id=p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  PERFORM 1 FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','INTERNAL_ERROR'); END IF;
  SELECT * INTO member_row FROM public.event_members
    WHERE event_id=p_event_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  IF member_row.is_banned THEN RETURN jsonb_build_object('code','ACCOUNT_BANNED'); END IF;
  PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=p_user_id
    AND terms_version=event_row.terms_version AND btrim(event_row.terms_version)<>'' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','CONSENT_REQUIRED'); END IF;
  SELECT * INTO post_row FROM public.posts
    WHERE event_id=p_event_id AND id=p_post_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  IF post_row.ban_latched OR post_row.status='deleted' THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;

  -- No reserve_upload after completion: it intentionally accepts uploading only.
  IF post_row.status <> 'uploading' THEN
    SELECT * INTO session_row FROM public.upload_sessions
      WHERE event_id=p_event_id AND id=p_upload_id AND post_id=p_post_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
    IF session_row.completed_at IS NULL OR session_row.completion_result IS NULL THEN
      RETURN jsonb_build_object('code','STATE_CONFLICT');
    END IF;
    IF session_row.completion_parts IS DISTINCT FROM parts THEN RETURN jsonb_build_object('code','IDEMPOTENCY_CONFLICT'); END IF;
    RETURN jsonb_build_object('code','completed','post',session_row.completion_result);
  END IF;
  IF post_row.upload_request IS NULL THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
  -- Rechecks all current issuance guards, including event/theme time, under locks.
  reservation := public.reserve_upload(p_event_id,p_user_id,post_row.upload_request);
  IF reservation->>'code' <> 'reserved' THEN RETURN reservation; END IF;
  SELECT * INTO asset_row FROM public.media_assets
    WHERE event_id=p_event_id AND id=(reservation->>'asset_id')::uuid FOR UPDATE;
  SELECT * INTO session_row FROM public.upload_sessions
    WHERE event_id=p_event_id AND id=p_upload_id AND post_id=p_post_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  IF session_row.asset_id<>asset_row.id OR session_row.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('code','STATE_CONFLICT');
  END IF;
  IF session_row.provisioning_state<>'ready' THEN RETURN jsonb_build_object('code','UPLOAD_INCOMPLETE'); END IF;
  size_bytes := (post_row.upload_request->>'file_size_bytes')::bigint;
  IF size_bytes<=67108864 THEN
    IF session_row.mode<>'single' OR jsonb_array_length(parts)<>0 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  ELSE
    part_size := greatest(8,ceil(size_bytes::numeric/10000/1048576))::bigint*1048576;
    part_count := ceil(size_bytes::numeric/part_size)::integer;
    IF session_row.mode<>'multipart' OR jsonb_array_length(parts)<>part_count THEN
      RETURN jsonb_build_object('code','INVALID_INPUT');
    END IF;
    SELECT md5(decode(string_agg(value->>'etag','' ORDER BY (value->>'part_number')::integer),'hex'))
      || '-' || part_count::text INTO expected_etag FROM jsonb_array_elements(parts);
  END IF;
  IF session_row.completion_parts IS NOT NULL AND session_row.completion_parts IS DISTINCT FROM parts THEN
    RETURN jsonb_build_object('code','IDEMPOTENCY_CONFLICT');
  END IF;
  IF p_action='prepare' THEN
    IF session_row.completion_parts IS NULL THEN
      UPDATE public.upload_sessions SET completion_parts=parts WHERE id=p_upload_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Completion manifest was not recorded'; END IF;
    END IF;
    -- Expiry limits signed PUTs, not this authenticated verification. No new URL.
    RETURN jsonb_build_object('code','prepared','post_id',p_post_id,'upload_id',p_upload_id,
      'asset_id',asset_row.id,'object_key',asset_row.object_key,'mode',session_row.mode,
      'provider_upload_id',session_row.provider_upload_id,'file_size_bytes',size_bytes,
      'parts',parts,'post_version',post_row.version);
  END IF;

  IF session_row.completion_parts IS NULL OR p_input->'post_version' IS DISTINCT FROM to_jsonb(post_row.version) THEN
    RETURN jsonb_build_object('code','STATE_CONFLICT');
  END IF;
  observation := p_input->'observation';
  IF jsonb_typeof(observation) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF NOT (observation ?& ARRAY['object_key','size','etag','version'])
    OR observation-ARRAY['object_key','size','etag','version'] <> '{}'::jsonb
    OR jsonb_typeof(observation->'version') IS DISTINCT FROM 'string'
    OR char_length(observation->>'version') NOT BETWEEN 1 AND 1024
    OR (observation->>'version') !~ '^[!-~]+$'
    OR jsonb_typeof(observation->'etag') IS DISTINCT FROM 'string'
    OR (observation->>'etag') !~ '^[0-9a-f]{32}(-[1-9][0-9]{0,4})?$' THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF observation->>'object_key' IS DISTINCT FROM asset_row.object_key
    OR observation->'size' IS DISTINCT FROM to_jsonb(size_bytes)
    OR (session_row.mode='single' AND (observation->>'etag') !~ '^[0-9a-f]{32}$')
    OR (expected_etag IS NOT NULL AND observation->>'etag' <> expected_etag) THEN
    RETURN jsonb_build_object('code','UPLOAD_INCOMPLETE');
  END IF;
  -- All policy locks are retained; also reject crossing a time boundary while waiting.
  observed_at := clock_timestamp();
  IF observed_at>=event_row.ends_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
  IF post_row.theme_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.themes
    WHERE event_id=p_event_id AND id=post_row.theme_id AND observed_at>=ends_at) THEN
    RETURN jsonb_build_object('code','THEME_UNAVAILABLE');
  END IF;
  UPDATE public.media_assets SET byte_size=size_bytes,object_etag=observation->>'etag',object_version=observation->>'version'
    WHERE event_id=p_event_id AND id=asset_row.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original observation was not recorded'; END IF;
  UPDATE public.posts SET status='uploaded',original_bytes=size_bytes,version=version+1,updated_at=observed_at
    WHERE event_id=p_event_id AND id=p_post_id RETURNING * INTO post_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Post completion was not recorded'; END IF;
  ack := jsonb_build_object('id',post_row.id,'event_id',p_event_id,'status',post_row.status,
    'version',post_row.version,'created_at',post_row.created_at);
  UPDATE public.upload_sessions SET completed_at=observed_at,completion_result=ack WHERE id=p_upload_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session completion was not recorded'; END IF;
  INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload)
    VALUES(p_event_id,p_post_id,'process_media','upload:'||p_upload_id::text||':process_media',
      jsonb_build_object('asset_id',asset_row.id,'post_version',post_row.version,
        'object_version',observation->>'version','object_etag',observation->>'etag')) RETURNING id INTO inserted_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Processing job was not inserted'; END IF;
  RETURN jsonb_build_object('code','completed','post',ack);
END;
$$;
REVOKE ALL ON FUNCTION public.complete_upload(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_upload(uuid,uuid,uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.complete_upload(uuid,uuid,uuid,uuid,text,jsonb) IS 'Worker-only after Google/CSRF. prepare freezes parts; commit requires trusted HEAD observation. Atomic uploaded + outbox, not processing or publication.';
NOTIFY pgrst, 'reload schema';
COMMIT;
