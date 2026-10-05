-- Private Stream preparation. External creation is preceded by a durable reservation;
-- a timeout is reconciled by operation metadata, never by blindly repeating POST.
BEGIN;
ALTER TABLE public.outbox_jobs
 ADD COLUMN stream_plan jsonb CHECK (stream_plan IS NULL OR jsonb_typeof(stream_plan)='object'),
 ADD COLUMN stream_state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(stream_state)='object'),
 ADD COLUMN stream_deadline timestamptz,
 ADD COLUMN stream_poll_count integer NOT NULL DEFAULT 0 CHECK (stream_poll_count BETWEEN 0 AND 60),
 ADD COLUMN stream_prepared_at timestamptz;
ALTER TABLE public.outbox_jobs ADD COLUMN stream_initial_post_version bigint CHECK(stream_initial_post_version BETWEEN 1 AND 2147483647);

CREATE FUNCTION public.manage_stream_processing(p_event_id uuid,p_post_id uuid,p_job_id uuid,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE
 e public.events%ROWTYPE; s public.event_settings%ROWTYPE; m public.event_members%ROWTYPE;
 p public.posts%ROWTYPE; j public.outbox_jobs%ROWTYPE; a public.media_assets%ROWTYPE;
 saved public.media_assets%ROWTYPE; selected_asset public.media_assets%ROWTYPE;
 owner_id uuid; stamp timestamptz; plan jsonb; state jsonb; entry jsonb; observation jsonb; ref jsonb; action jsonb;
 wanted text; keys text[]; purpose_name text; source_uid text; observed_at timestamptz;
 duration numeric; expires_ms bigint; prior_state jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='manage_stream_processing requires READ COMMITTED'; END IF;
 IF p_event_id IS NULL OR p_post_id IS NULL OR p_job_id IS NULL OR p_action IS NULL OR p_action NOT IN ('claim','check','reserve','observe','poll','finish','hold')
  OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 keys:=CASE p_action WHEN 'claim' THEN ARRAY[]::text[] WHEN 'check' THEN ARRAY['plan','action']
  WHEN 'reserve' THEN ARRAY['plan','operation'] WHEN 'observe' THEN ARRAY['plan','operation','observation']
  WHEN 'hold' THEN ARRAY['plan','errorCode'] ELSE ARRAY['plan'] END;
 IF NOT(p_input ?& keys) OR p_input-keys<>'{}'::jsonb THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
 SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_post_id;
 SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR m.is_banned THEN RETURN jsonb_build_object('code','STALE'); END IF;
 PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id AND terms_version=e.terms_version AND btrim(e.terms_version)<>'' FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_post_id FOR UPDATE;
 IF NOT FOUND OR p.user_id<>owner_id OR p.kind<>'video' OR p.status NOT IN ('uploaded','processing') OR p.deleted_at IS NOT NULL OR p.ban_latched
  OR p.version NOT BETWEEN 1 AND 2147483646 THEN RETURN jsonb_build_object('code','STALE'); END IF;
 PERFORM 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id ORDER BY id FOR UPDATE;
 SELECT * INTO j FROM public.outbox_jobs WHERE event_id=p_event_id AND post_id=p_post_id AND id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.kind<>'process_media' OR j.completed_at IS NOT NULL THEN RETURN jsonb_build_object('code','STALE'); END IF;
 stamp:=clock_timestamp();
 IF e.status<>'live' OR stamp<e.starts_at OR stamp>=e.private_at OR s.event_id IS NULL OR s.publication_stopped OR NOT s.uploads_enabled THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose='original';
 IF NOT FOUND OR a.provider<>'r2_original' OR a.deletion_requested_at IS NOT NULL OR a.physically_deleted_at IS NOT NULL OR a.byte_size IS DISTINCT FROM p.original_bytes
  OR a.byte_size IS NULL OR a.object_version IS NULL OR a.object_etag IS NULL OR a.object_etag !~ '^[a-f0-9]{32}(-[1-9][0-9]{0,3}|-10000)?$'
  OR j.payload->'asset_id' IS DISTINCT FROM to_jsonb(a.id) OR j.payload->'post_version' IS DISTINCT FROM to_jsonb(p.version)
  OR j.payload->'object_etag' IS DISTINCT FROM to_jsonb(a.object_etag) OR j.payload->'object_version' IS DISTINCT FROM to_jsonb(a.object_version) THEN RETURN jsonb_build_object('code','STALE'); END IF;
 IF j.stream_prepared_at IS NOT NULL THEN RETURN jsonb_build_object('code','PREPARED'); END IF;
 IF p_action='claim' THEN
  IF j.stream_plan IS NOT NULL AND (j.stream_plan->'scope'->>'expiresAt')::numeric>extract(epoch FROM stamp)*1000 THEN RETURN jsonb_build_object('code','BUSY'); END IF;
  UPDATE public.outbox_jobs SET stream_initial_post_version=coalesce(stream_initial_post_version,p.version) WHERE id=j.id;
  IF p.status='uploaded' THEN
   UPDATE public.posts SET status='processing',version=version+1,updated_at=stamp WHERE id=p.id RETURNING * INTO p;
   UPDATE public.outbox_jobs SET payload=jsonb_set(payload,'{post_version}',to_jsonb(p.version)) WHERE id=j.id;
  END IF;
  -- A human-requested retry must reuse/reconcile the previous durable create, never issue a second
  -- copy merely because its owning job changed. Provenance comes only from a completed job bound
  -- to this exact immutable original. Current authorization remains this job/version/lease.
  IF j.stream_state='{}'::jsonb THEN
   SELECT old.stream_state INTO prior_state FROM public.outbox_jobs old WHERE old.event_id=p_event_id AND old.post_id=p_post_id
    AND old.id<>j.id AND old.kind='process_media' AND old.completed_at IS NOT NULL AND old.stream_state<>'{}'::jsonb
    AND old.payload->'asset_id'=to_jsonb(a.id) AND old.payload->'object_etag'=to_jsonb(a.object_etag) AND old.payload->'object_version'=to_jsonb(a.object_version)
    AND jsonb_typeof(old.payload->'post_version')='number' AND (old.payload->>'post_version')::numeric<p.version
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(old.stream_state) x WHERE x.key NOT IN ('source','clip') OR jsonb_typeof(x.value)<>'object'
      OR jsonb_typeof(x.value->'providerJobId') IS DISTINCT FROM 'string' OR x.value->>'providerJobId' !~ '^[a-f0-9-]{36}$'
      OR jsonb_typeof(x.value->'providerPostVersion') IS DISTINCT FROM 'number' OR (x.value->>'providerPostVersion')::numeric> (old.payload->>'post_version')::numeric
      OR (x.key='source' AND x.value->'sourceUid' IS DISTINCT FROM 'null'::jsonb)
      OR (x.key='clip' AND (old.stream_state->'source'->'uid' IS NULL OR old.stream_state->'source'->'uid'='null'::jsonb OR x.value->'sourceUid' IS DISTINCT FROM old.stream_state->'source'->'uid'))
      OR NOT EXISTS(SELECT 1 FROM public.outbox_jobs origin WHERE origin.id::text=x.value->>'providerJobId' AND origin.event_id=p_event_id AND origin.post_id=p_post_id
        AND origin.kind='process_media' AND origin.completed_at IS NOT NULL AND origin.payload->'asset_id'=to_jsonb(a.id)
        AND origin.payload->'object_etag'=to_jsonb(a.object_etag) AND origin.payload->'object_version'=to_jsonb(a.object_version)
        AND origin.payload->'post_version'=x.value->'providerPostVersion'
        AND origin.stream_state->x.key->'operationId'=x.value->'operationId' AND origin.stream_state->x.key->'sourceUid'=x.value->'sourceUid'
        AND (origin.stream_state->x.key->'uid'='null'::jsonb OR origin.stream_state->x.key->'uid'=x.value->'uid'))
      OR (x.value->'uid'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.media_assets current_asset WHERE current_asset.event_id=p_event_id
        AND current_asset.post_id=p_post_id AND current_asset.purpose='stream_'||x.key AND to_jsonb(current_asset.stream_uid)=x.value->'uid'
        AND coalesce(to_jsonb(current_asset.stream_source_uid),'null'::jsonb)=x.value->'sourceUid'
        AND current_asset.deletion_requested_at IS NULL AND current_asset.physically_deleted_at IS NULL)))
    ORDER BY old.created_at DESC,old.id DESC LIMIT 1;
   IF prior_state IS NOT NULL THEN
    UPDATE public.outbox_jobs SET stream_state=prior_state WHERE id=j.id RETURNING * INTO j;
   END IF;
  END IF;
  expires_ms:=floor(extract(epoch FROM least(stamp+interval '120 seconds',e.private_at))*1000)::bigint;
  plan:=jsonb_build_object('scope',jsonb_build_object('eventId',p_event_id,'postId',p_post_id,'assetId',a.id,'jobId',p_job_id,'leaseId',gen_random_uuid(),'postVersion',p.version,'expiresAt',expires_ms),
   'original',jsonb_build_object('size',a.byte_size,'etag',a.object_etag,'objectVersion',a.object_version),'originalScope',p.original_scope);
  UPDATE public.outbox_jobs SET stream_plan=plan,stream_deadline=coalesce(stream_deadline,stamp+interval '30 minutes') WHERE id=j.id RETURNING * INTO j;
  RETURN jsonb_build_object('code','CLAIMED','plan',plan,'state',j.stream_state,'pollCount',j.stream_poll_count,'deadline',floor(extract(epoch FROM j.stream_deadline)*1000)::bigint);
 END IF;
 plan:=j.stream_plan; state:=j.stream_state;
 IF plan IS NULL OR p_input->'plan' IS DISTINCT FROM plan OR (plan->'scope'->>'expiresAt')::numeric<=extract(epoch FROM stamp)*1000
  OR plan->'scope'->'postVersion' IS DISTINCT FROM to_jsonb(p.version) THEN RETURN jsonb_build_object('code','STALE'); END IF;
 IF p_action='hold' THEN
  IF p_input->>'errorCode' NOT IN ('STREAM_PROCESSING_FAILED','VIDEO_TOO_LONG','STREAM_TIMEOUT') OR jsonb_typeof(p_input->'errorCode') IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  UPDATE public.posts SET status='held',processing_error=p_input->>'errorCode',version=version+1,updated_at=stamp WHERE id=p.id;
  UPDATE public.outbox_jobs SET completed_at=stamp,locked_until=NULL WHERE id=j.id;
  INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'notify','stream-failure:'||p_job_id,jsonb_build_object('category','stream_failure','post_version',p.version+1));
  RETURN jsonb_build_object('code','HELD');
 END IF;
 IF j.stream_deadline IS NULL OR stamp>=j.stream_deadline OR j.stream_poll_count>=60 THEN RETURN jsonb_build_object('code','EXHAUSTED'); END IF;
 IF p_action='poll' THEN
  UPDATE public.outbox_jobs SET stream_poll_count=stream_poll_count+1,stream_plan=NULL WHERE id=j.id;
  RETURN jsonb_build_object('code','WAIT','pollCount',j.stream_poll_count+1);
 END IF;
 IF p_action='check' THEN
  action:=p_input->'action';
  IF jsonb_typeof(action) IS DISTINCT FROM 'object' OR NOT(action ?& ARRAY['action','operationId','uid','sourceUid']) OR action-ARRAY['action','operationId','uid','sourceUid']<>'{}'::jsonb
   OR action->>'action' NOT IN ('copy','clip','inspect','reconcile','frames') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  SELECT value INTO entry FROM jsonb_each(state) WHERE value->'operationId'=action->'operationId';
  IF entry IS NULL OR entry->'sourceUid' IS DISTINCT FROM action->'sourceUid' THEN RETURN jsonb_build_object('code','STALE'); END IF;
  IF action->>'action' IN ('copy','clip') AND (entry->'providerJobId' IS DISTINCT FROM to_jsonb(p_job_id) OR entry->'providerPostVersion' IS DISTINCT FROM to_jsonb(p.version)) THEN RETURN jsonb_build_object('code','STALE'); END IF;
  IF action->>'action'='copy' AND (entry->'sourceUid'<>'null'::jsonb OR entry->'uid'<>'null'::jsonb OR action->'uid'<>'null'::jsonb) THEN RETURN jsonb_build_object('code','STALE'); END IF;
  IF action->>'action'='clip' AND (entry->'sourceUid'='null'::jsonb OR entry->'uid'<>'null'::jsonb OR action->'uid' IS DISTINCT FROM entry->'sourceUid') THEN RETURN jsonb_build_object('code','STALE'); END IF;
  IF action->>'action' IN ('inspect','frames') AND (entry->'uid'='null'::jsonb OR entry->'uid' IS DISTINCT FROM action->'uid') THEN RETURN jsonb_build_object('code','STALE'); END IF;
  IF action->>'action'='reconcile' AND (entry->'uid'<>'null'::jsonb OR action->'uid'<>'null'::jsonb) THEN RETURN jsonb_build_object('code','STALE'); END IF;
  RETURN jsonb_build_object('code','CURRENT');
 END IF;
 IF p_action IN ('reserve','observe') THEN
  wanted:=p_input->>'operation';
  IF wanted IS NULL OR wanted NOT IN ('source','clip') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  entry:=state->wanted;
  IF p_action='reserve' THEN
   IF entry IS NOT NULL THEN RETURN jsonb_build_object('code','EXISTING','operation',entry); END IF;
   source_uid:=NULL;
   IF wanted='clip' THEN
    SELECT * INTO saved FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose='stream_source';
    IF NOT FOUND OR p.original_scope<>'full_video_fallback' OR NOT saved.stream_processing_complete OR NOT saved.stream_ready_to_stream OR NOT saved.stream_require_signed_urls
     OR saved.deletion_requested_at IS NOT NULL OR saved.physically_deleted_at IS NOT NULL THEN RETURN jsonb_build_object('code','STALE'); END IF;
    source_uid:=saved.stream_uid;
   END IF;
   IF EXISTS(SELECT 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose='stream_'||wanted) THEN RETURN jsonb_build_object('code','STALE'); END IF;
   entry:=jsonb_build_object('operationId',gen_random_uuid(),'uid',NULL,'sourceUid',source_uid,'providerJobId',p_job_id,'providerPostVersion',p.version);
   UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,ARRAY[wanted],entry) WHERE id=j.id;
   RETURN jsonb_build_object('code','RESERVED','operation',entry);
  END IF;
  observation:=p_input->'observation'; ref:=observation->'reference';
  IF entry IS NULL OR jsonb_typeof(observation) IS DISTINCT FROM 'object' OR jsonb_typeof(ref) IS DISTINCT FROM 'object'
   OR NOT(observation ?& ARRAY['reference','state','requireSignedURLs','readyToStream','processingComplete','measuredDurationSeconds','width','height','modifiedAt'])
   OR observation-ARRAY['reference','state','requireSignedURLs','readyToStream','processingComplete','measuredDurationSeconds','width','height','modifiedAt']<>'{}'::jsonb
   OR NOT(ref ?& ARRAY['operationId','uid','sourceUid']) OR ref-ARRAY['operationId','uid','sourceUid']<>'{}'::jsonb
   OR ref->'operationId' IS DISTINCT FROM entry->'operationId' OR ref->'sourceUid' IS DISTINCT FROM entry->'sourceUid'
   OR jsonb_typeof(ref->'uid') IS DISTINCT FROM 'string' OR ref->>'uid' !~ '^[a-f0-9]{32}$'
   OR (entry->'uid'<>'null'::jsonb AND entry->'uid' IS DISTINCT FROM ref->'uid')
   OR observation->'requireSignedURLs' IS DISTINCT FROM 'true'::jsonb
   OR observation->>'state' NOT IN ('pending','ready','error') OR jsonb_typeof(observation->'state') IS DISTINCT FROM 'string'
   OR jsonb_typeof(observation->'readyToStream') IS DISTINCT FROM 'boolean' OR jsonb_typeof(observation->'processingComplete') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(observation->'modifiedAt') IS DISTINCT FROM 'string'
   OR observation->>'modifiedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  BEGIN observed_at:=(observation->>'modifiedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END;
  IF NOT isfinite(observed_at) OR observed_at>stamp+interval '30 seconds' OR observed_at<e.created_at-interval '1 day' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF entry ? 'modifiedAt' AND (entry->>'modifiedAt')::timestamptz>observed_at THEN RETURN jsonb_build_object('code','OUTDATED'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(observation) kv WHERE kv.key IN ('width','height') AND (jsonb_typeof(kv.value) NOT IN ('number','null') OR (jsonb_typeof(kv.value)='number' AND (kv.value::text::numeric NOT BETWEEN 1 AND 16384 OR trunc(kv.value::text::numeric)<>kv.value::text::numeric))))
   OR jsonb_typeof(observation->'measuredDurationSeconds') NOT IN ('number','null') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  duration:=(observation->>'measuredDurationSeconds')::numeric;
  IF duration IS NOT NULL AND (duration<=0 OR duration>36000) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF (observation->>'processingComplete')::boolean AND (observation->>'state'<>'ready' OR observation->'readyToStream'<>'true'::jsonb OR duration IS NULL OR observation->'width'='null'::jsonb OR observation->'height'='null'::jsonb) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  purpose_name:='stream_'||wanted;
  SELECT * INTO saved FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose=purpose_name;
  IF FOUND AND (saved.stream_uid IS DISTINCT FROM ref->>'uid' OR saved.stream_source_uid IS DISTINCT FROM ref->>'sourceUid' OR saved.deletion_requested_at IS NOT NULL OR saved.physically_deleted_at IS NOT NULL) THEN RETURN jsonb_build_object('code','STALE'); END IF;
  -- Same-time callbacks are idempotent only when every saved evidence field agrees.
  IF entry ? 'modifiedAt' AND (entry->>'modifiedAt')::timestamptz=observed_at AND
    (entry->'state' IS DISTINCT FROM observation->'state' OR saved.stream_ready_to_stream IS DISTINCT FROM (observation->>'readyToStream')::boolean
     OR saved.stream_processing_complete IS DISTINCT FROM (observation->>'processingComplete')::boolean OR saved.stream_duration_seconds IS DISTINCT FROM duration
     OR saved.pixel_width IS DISTINCT FROM (observation->>'width')::integer OR saved.pixel_height IS DISTINCT FROM (observation->>'height')::integer)
    THEN RETURN jsonb_build_object('code','OUTDATED'); END IF;
  IF ref->>'uid'=ref->>'sourceUid' OR EXISTS(SELECT 1 FROM public.media_assets WHERE stream_uid=ref->>'uid'
    AND (event_id<>p_event_id OR post_id<>p_post_id OR purpose<>purpose_name)) THEN RETURN jsonb_build_object('code','STALE'); END IF;
  BEGIN
  INSERT INTO public.media_assets(event_id,post_id,purpose,provider,stream_uid,stream_source_uid,stream_ready_to_stream,stream_require_signed_urls,stream_processing_complete,stream_duration_seconds,pixel_width,pixel_height)
   VALUES(p_event_id,p_post_id,purpose_name,'stream',ref->>'uid',ref->>'sourceUid',(observation->>'readyToStream')::boolean,true,(observation->>'processingComplete')::boolean,duration,(observation->>'width')::integer,(observation->>'height')::integer)
   ON CONFLICT(event_id,post_id,purpose) DO UPDATE SET stream_ready_to_stream=EXCLUDED.stream_ready_to_stream,stream_require_signed_urls=true,stream_processing_complete=EXCLUDED.stream_processing_complete,stream_duration_seconds=EXCLUDED.stream_duration_seconds,pixel_width=EXCLUDED.pixel_width,pixel_height=EXCLUDED.pixel_height;
  EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('code','STALE'); END;
  UPDATE public.outbox_jobs SET stream_state=jsonb_set(stream_state,ARRAY[wanted],entry||ref||jsonb_build_object('modifiedAt',observation->'modifiedAt','state',observation->'state')) WHERE id=j.id;
  RETURN jsonb_build_object('code','OBSERVED');
 END IF;
 -- finish accepts no caller-provided duration/UID/ready flags: select the locked evidence.
 SELECT * INTO selected_asset FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id
  AND purpose=CASE WHEN p.original_scope='full_video_fallback' THEN 'stream_clip' ELSE 'stream_source' END;
 IF NOT FOUND OR NOT selected_asset.stream_processing_complete OR NOT selected_asset.stream_ready_to_stream OR NOT selected_asset.stream_require_signed_urls
  OR selected_asset.deletion_requested_at IS NOT NULL OR selected_asset.physically_deleted_at IS NOT NULL OR selected_asset.stream_duration_seconds IS NULL
  OR selected_asset.stream_duration_seconds NOT BETWEEN 0.000001 AND 4 THEN RETURN jsonb_build_object('code','NOT_READY'); END IF;
 entry:=state->CASE WHEN p.original_scope='full_video_fallback' THEN 'clip' ELSE 'source' END;
 IF entry IS NULL OR entry->'uid' IS DISTINCT FROM to_jsonb(selected_asset.stream_uid) OR entry->>'state' IS DISTINCT FROM 'ready'
   OR entry->'sourceUid' IS DISTINCT FROM coalesce(to_jsonb(selected_asset.stream_source_uid),'null'::jsonb)
   THEN RETURN jsonb_build_object('code','STALE'); END IF;
 IF p.original_scope='full_video_fallback' AND NOT EXISTS(SELECT 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose='stream_source'
  AND stream_uid=selected_asset.stream_source_uid AND stream_uid<>selected_asset.stream_uid AND deletion_requested_at IS NULL AND physically_deleted_at IS NULL) THEN RETURN jsonb_build_object('code','STALE'); END IF;
 duration:=selected_asset.stream_duration_seconds;
 UPDATE public.posts SET measured_duration_seconds=duration,updated_at=stamp WHERE id=p.id;
 UPDATE public.outbox_jobs SET stream_prepared_at=stamp,stream_plan=NULL,moderation_media=jsonb_build_object('kind','video','postVersion',p.version,'streamAssetId',selected_asset.id,
  'measuredDurationSeconds',duration,'frameTimes',jsonb_build_array(duration/10,duration/2,duration*9/10),'requireSignedURLs',true,'readyToStream',true,'processingComplete',true) WHERE id=j.id;
 RETURN jsonb_build_object('code','PREPARED');
END;
$$;
REVOKE ALL ON FUNCTION public.manage_stream_processing(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_stream_processing(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.manage_stream_processing(uuid,uuid,uuid,text,jsonb) IS 'Service-only durable Stream creation reservation, finite polling, observation and private preparation. No publication, destructive deletion or external IO.';
NOTIFY pgrst,'reload schema';
COMMIT;
