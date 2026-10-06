-- Opt-in physical cleanup. No policy, flag, provider call or retention is enabled here.
BEGIN;
ALTER TABLE public.event_settings
 ADD COLUMN physical_deletion_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN physical_deletion_policy jsonb CHECK(physical_deletion_policy IS NULL OR jsonb_typeof(physical_deletion_policy)='object');
ALTER TABLE public.outbox_jobs
 ADD COLUMN deletion_state text NOT NULL DEFAULT 'pending' CHECK(deletion_state IN ('pending','running','intent','done','held')),
 ADD COLUMN deletion_attempt integer NOT NULL DEFAULT 0 CHECK(deletion_attempt BETWEEN 0 AND 5),
 ADD COLUMN deletion_lease uuid,
 ADD COLUMN deletion_locked_until timestamptz,
 ADD COLUMN deletion_deadline timestamptz,
 ADD COLUMN deletion_due timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN deletion_plan jsonb,
 ADD COLUMN deletion_result text CHECK(deletion_result IN ('ABSENT','LOCKED','IDENTITY_MISMATCH','AMBIGUOUS','WRITE_OUTCOME_UNKNOWN','RETENTION_UNKNOWN','RETENTION_PENDING','INVALID_TARGET','EXHAUSTED'));
CREATE INDEX physical_deletion_due ON public.outbox_jobs(event_id,deletion_due,id)
 WHERE kind='delete_assets' AND completed_at IS NULL AND deletion_state IN ('pending','running','intent');

CREATE FUNCTION koko_private.valid_deletion_policy(v jsonb,t timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE n numeric; approved timestamptz; expires timestamptz;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['version','approved_at','valid_until','original_seconds','derived_seconds','stream_seconds','blocked_seconds'])
  OR v-ARRAY['version','approved_at','valid_until','original_seconds','derived_seconds','stream_seconds','blocked_seconds']<>'{}'::jsonb
  OR jsonb_typeof(v->'version') IS DISTINCT FROM 'string' OR v->>'version' !~ '^[A-Za-z0-9_-]{1,64}$'
  OR jsonb_typeof(v->'approved_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'valid_until') IS DISTINCT FROM 'string'
  OR v->>'approved_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
  OR v->>'valid_until' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' THEN RETURN false; END IF;
 FOR n IN SELECT CASE WHEN jsonb_typeof(value)='number' THEN value::text::numeric ELSE NULL END FROM jsonb_each(v)
   WHERE key IN ('original_seconds','derived_seconds','stream_seconds','blocked_seconds') LOOP
  IF n IS NULL OR n NOT BETWEEN 0 AND 315360000 OR n<>trunc(n) THEN RETURN false; END IF;
 END LOOP;
 BEGIN approved:=(v->>'approved_at')::timestamptz; expires:=(v->>'valid_until')::timestamptz;
 EXCEPTION WHEN OTHERS THEN RETURN false; END;
 RETURN isfinite(approved) AND isfinite(expires) AND approved<=t AND expires>t AND expires>approved AND expires<=approved+interval '366 days';
END $$;
REVOKE ALL ON FUNCTION koko_private.valid_deletion_policy(jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION koko_private.valid_deletion_policy(jsonb,timestamptz) TO service_role;

CREATE FUNCTION public.manage_physical_deletion(p_event_id uuid,p_job_id uuid,p_action text,p_input jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.event_settings%ROWTYPE; j public.outbox_jobs%ROWTYPE; p public.posts%ROWTYPE; a public.media_assets%ROWTYPE;
 u public.upload_sessions%ROWTYPE; origin public.media_assets%ROWTYPE; producer public.outbox_jobs%ROWTYPE;
 t timestamptz; until_at timestamptz; seconds integer; candidate jsonb; entry jsonb; jobs jsonb:='[]'; result text; mode text;
 held integer:=0; keys text[]; target_post uuid; version_number numeric;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='Physical deletion requires READ COMMITTED'; END IF;
 IF p_event_id IS NULL OR p_action IS NULL OR p_action NOT IN ('claim','prepare','begin','settle') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  OR octet_length(p_input::text)>16384 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 keys:=CASE p_action WHEN 'claim' THEN ARRAY['limit'] WHEN 'prepare' THEN ARRAY['lease_id'] WHEN 'begin' THEN ARRAY['lease_id','plan'] ELSE ARRAY['lease_id','plan','result'] END;
 IF NOT(p_input ?& keys) OR p_input-keys<>'{}'::jsonb THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 IF p_action='claim' THEN
  IF p_job_id IS NOT NULL OR jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF (p_input->>'limit')::numeric NOT BETWEEN 1 AND 5 OR (p_input->>'limit')::numeric<>trunc((p_input->>'limit')::numeric) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 ELSE
  IF p_job_id IS NULL OR coalesce(p_input->>'lease_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF p_action='settle' AND (jsonb_typeof(p_input->'result') IS DISTINCT FROM 'string' OR p_input->>'result' NOT IN ('ABSENT','LOCKED','IDENTITY_MISMATCH','AMBIGUOUS')) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 END IF;
 -- Same event-first serialization as admission/state transitions. BAN/private/kill switch
 -- never remove a legitimate deletion request. This independent flag alone gates cleanup.
 PERFORM 1 FROM public.events WHERE event_id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
 SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR UPDATE;
 t:=clock_timestamp();
 IF NOT FOUND OR NOT s.physical_deletion_enabled OR NOT koko_private.valid_deletion_policy(s.physical_deletion_policy,t) THEN RETURN jsonb_build_object('code','DISABLED'); END IF;
 IF p_action='claim' THEN
  FOR j IN SELECT * FROM public.outbox_jobs WHERE event_id=p_event_id AND kind='delete_assets' AND completed_at IS NULL
   AND deletion_state IN ('pending','running','intent') AND deletion_due<=t AND (deletion_locked_until IS NULL OR deletion_locked_until<=t)
   ORDER BY deletion_due,id LIMIT (p_input->>'limit')::integer FOR UPDATE SKIP LOCKED LOOP
   IF j.deletion_attempt>=5 OR j.deletion_deadline<=t THEN
    UPDATE public.outbox_jobs SET deletion_state='held',deletion_result='EXHAUSTED',deletion_lease=NULL,deletion_locked_until=NULL WHERE id=j.id;
    held:=held+1; CONTINUE;
   END IF;
   -- Expired intent is reconciled against the SAME immutable target, never silently replaced.
   UPDATE public.outbox_jobs SET deletion_state='running',deletion_attempt=deletion_attempt+1,deletion_lease=gen_random_uuid(),
    deletion_locked_until=t+interval '120 seconds',deletion_deadline=coalesce(deletion_deadline,t+interval '24 hours') WHERE id=j.id RETURNING * INTO j;
   jobs:=jobs||jsonb_build_array(jsonb_build_object('event_id',p_event_id,'job_id',j.id,'lease_id',j.deletion_lease));
  END LOOP;
  RETURN jsonb_build_object('code','CLAIMED','jobs',jobs,'held',held);
 END IF;
 SELECT post_id INTO target_post FROM public.outbox_jobs WHERE event_id=p_event_id AND id=p_job_id AND kind='delete_assets';
 SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=target_post FOR UPDATE;
 PERFORM 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=target_post ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.upload_sessions WHERE event_id=p_event_id AND post_id=target_post ORDER BY id FOR UPDATE;
 SELECT * INTO j FROM public.outbox_jobs WHERE event_id=p_event_id AND id=p_job_id FOR UPDATE;
 IF j.id IS NULL OR j.kind<>'delete_assets' OR j.completed_at IS NOT NULL OR j.deletion_state NOT IN ('running','intent')
  OR j.deletion_lease IS DISTINCT FROM (p_input->>'lease_id')::uuid OR j.deletion_locked_until<=t OR j.deletion_locked_until IS NULL
  OR j.deletion_deadline<=t THEN RETURN jsonb_build_object('code','STALE'); END IF;
 result:=NULL;
 IF p.id IS NULL OR p.status<>'deleted' OR p.deleted_at IS NULL OR j.payload-ARRAY['asset_id','post_version']<>'{}'::jsonb
  OR coalesce(j.payload->>'asset_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR jsonb_typeof(j.payload->'post_version') IS DISTINCT FROM 'number' THEN result:='INVALID_TARGET';
 ELSE
  version_number:=(j.payload->>'post_version')::numeric;
  IF version_number NOT BETWEEN 1 AND p.version OR version_number<>trunc(version_number) THEN result:='INVALID_TARGET'; END IF;
  SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p.id AND id=(j.payload->>'asset_id')::uuid;
  IF a.id IS NULL OR a.deletion_requested_at IS NULL THEN result:='INVALID_TARGET'; END IF;
 END IF;
 IF result IS NULL AND a.physically_deleted_at IS NOT NULL THEN
  UPDATE public.outbox_jobs SET completed_at=t,deletion_state='done',deletion_result='ABSENT',deletion_locked_until=NULL,deletion_lease=NULL WHERE id=j.id;
  RETURN jsonb_build_object('code','DONE');
 END IF;
 IF result IS NULL THEN
  seconds:=(s.physical_deletion_policy->>CASE a.provider WHEN 'r2_original' THEN 'original_seconds' WHEN 'r2_delivery' THEN 'derived_seconds' ELSE 'stream_seconds' END)::integer;
  IF p.moderation_verdict='BLOCK' THEN seconds:=greatest(seconds,(s.physical_deletion_policy->>'blocked_seconds')::integer); END IF;
  until_at:=greatest(a.created_at+make_interval(secs=>seconds),a.retention_until);
  IF (a.provider='r2_original' AND a.retention_until IS NULL) OR NOT isfinite(until_at) THEN result:='RETENTION_UNKNOWN';
  ELSIF until_at>t THEN result:='RETENTION_PENDING'; END IF;
 END IF;
 IF result IS NULL THEN
  -- Unknown in-flight writers are not canceled by an expired lease or a deleted DB row.
  IF EXISTS(SELECT 1 FROM public.outbox_jobs q WHERE q.event_id=p_event_id AND q.post_id=p.id AND q.kind='process_media'
    AND ((q.completed_at IS NULL AND (q.image_plan IS NOT NULL OR q.stream_state<>'{}'::jsonb))
      OR (q.image_plan IS NOT NULL AND q.image_completed_at IS NULL)
      OR EXISTS(SELECT 1 FROM jsonb_each(q.stream_state) x WHERE x.value->'uid' IS NULL OR x.value->'uid'='null'::jsonb))) THEN result:='WRITE_OUTCOME_UNKNOWN';
  ELSE
   mode:='delete'; entry:=NULL;
   IF a.provider='r2_original' THEN
    SELECT * INTO u FROM public.upload_sessions WHERE event_id=p_event_id AND post_id=p.id AND asset_id=a.id;
    IF u.id IS NULL OR u.mode<>'multipart' OR u.provisioning_state<>'ready' OR u.provisioning_attempts<>1 OR cardinality(u.previous_upload_ids)<>0
      OR u.provider_upload_id IS NULL THEN result:='WRITE_OUTCOME_UNKNOWN';
    ELSIF u.completed_at IS NULL THEN
     IF u.completion_parts IS NOT NULL OR u.expires_at>t OR a.object_version IS NOT NULL OR a.object_etag IS NOT NULL THEN result:='WRITE_OUTCOME_UNKNOWN';
     ELSE mode:='abort_multipart'; END IF;
    ELSIF a.object_version IS NULL OR a.object_etag IS NULL OR a.byte_size IS NULL THEN result:='WRITE_OUTCOME_UNKNOWN'; END IF;
   ELSIF a.provider='r2_delivery' THEN
    SELECT * INTO producer FROM public.outbox_jobs q WHERE q.event_id=p_event_id AND q.post_id=p.id AND q.kind='process_media'
     AND q.image_attempt=1 AND q.image_completed_at IS NOT NULL AND q.completed_at IS NOT NULL
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.image_plan->'deliveries') d WHERE d->>'assetId'=a.id::text) ORDER BY q.created_at LIMIT 1;
    IF producer.id IS NULL OR a.sha256 IS NULL OR a.byte_size IS NULL
      OR EXISTS(SELECT 1 FROM public.outbox_jobs q WHERE q.event_id=p_event_id AND q.post_id=p.id AND q.kind='process_media' AND q.id<>producer.id AND q.image_attempt>0) THEN result:='WRITE_OUTCOME_UNKNOWN'; END IF;
   ELSE
    SELECT * INTO origin FROM public.media_assets WHERE event_id=p_event_id AND post_id=p.id AND purpose='original';
    SELECT * INTO producer FROM public.outbox_jobs q WHERE q.event_id=p_event_id AND q.post_id=p.id AND q.kind='process_media' AND q.completed_at IS NOT NULL
      AND q.stream_state->CASE a.purpose WHEN 'stream_source' THEN 'source' ELSE 'clip' END->>'uid'=a.stream_uid
      AND q.stream_state->CASE a.purpose WHEN 'stream_source' THEN 'source' ELSE 'clip' END->>'providerJobId'=q.id::text
      AND q.payload->>'asset_id'=origin.id::text AND q.payload->>'object_etag'=origin.object_etag AND q.payload->>'object_version'=origin.object_version ORDER BY q.created_at LIMIT 1;
    entry:=producer.stream_state->CASE a.purpose WHEN 'stream_source' THEN 'source' ELSE 'clip' END;
    IF producer.id IS NULL OR entry->>'operationId' IS NULL OR entry->'providerPostVersion' IS DISTINCT FROM producer.payload->'post_version'
      OR entry->>'sourceUid' IS DISTINCT FROM a.stream_source_uid THEN result:='WRITE_OUTCOME_UNKNOWN'; END IF;
   END IF;
  END IF;
 END IF;
 IF result IS NULL THEN
  candidate:=jsonb_build_object('event_id',p_event_id,'post_id',p.id,'asset_id',a.id,'provider',a.provider,'purpose',a.purpose,'mode',mode,
   'object_key',a.object_key,'stream_uid',a.stream_uid,'size',a.byte_size,'etag',a.object_etag,'object_version',a.object_version,'sha256',a.sha256,
   'upload_id',CASE WHEN mode='abort_multipart' THEN u.provider_upload_id ELSE NULL END,'policy',s.physical_deletion_policy,
   'stream',CASE WHEN a.provider='stream' THEN jsonb_build_object('operation_id',entry->'operationId','job_id',producer.id,'post_version',entry->'providerPostVersion','original_asset_id',origin.id,'source_uid',entry->'sourceUid') ELSE NULL END);
  IF j.deletion_plan IS NOT NULL AND j.deletion_plan IS DISTINCT FROM candidate THEN result:='IDENTITY_MISMATCH';
  ELSIF p_action IN ('begin','settle') AND p_input->'plan' IS DISTINCT FROM candidate THEN RETURN jsonb_build_object('code','STALE');
  ELSIF p_action='prepare' THEN
   IF j.deletion_state<>'running' THEN RETURN jsonb_build_object('code','STALE'); END IF;
   UPDATE public.outbox_jobs SET deletion_plan=candidate WHERE id=j.id;
   RETURN jsonb_build_object('code','PREPARED','plan',candidate);
  ELSIF p_action='begin' THEN
   UPDATE public.outbox_jobs SET deletion_state='intent' WHERE id=j.id;
   RETURN jsonb_build_object('code','CURRENT');
  ELSE
   IF j.deletion_state<>'intent' THEN RETURN jsonb_build_object('code','STALE'); END IF;
   result:=p_input->>'result';
  END IF;
 END IF;
 IF result='ABSENT' THEN
  UPDATE public.media_assets SET physically_deleted_at=t WHERE id=a.id;
  UPDATE public.outbox_jobs SET deletion_state='done',deletion_result=result,completed_at=t,deletion_lease=NULL,deletion_locked_until=NULL WHERE id=j.id;
 ELSIF result='RETENTION_PENDING' AND j.deletion_plan IS NULL THEN
  UPDATE public.outbox_jobs SET deletion_state='pending',deletion_result=result,deletion_attempt=0,deletion_deadline=NULL,deletion_due=until_at,deletion_lease=NULL,deletion_locked_until=NULL WHERE id=j.id;
  RETURN jsonb_build_object('code','WAIT');
 ELSIF result='AMBIGUOUS' AND j.deletion_attempt<5 AND t+interval '5 minutes'<j.deletion_deadline THEN
  UPDATE public.outbox_jobs SET deletion_state='pending',deletion_result=result,deletion_due=t+interval '5 minutes',deletion_lease=NULL,deletion_locked_until=NULL WHERE id=j.id;
  RETURN jsonb_build_object('code','RETRY');
 ELSE
  UPDATE public.outbox_jobs SET deletion_state='held',deletion_result=result,deletion_lease=NULL,deletion_locked_until=NULL WHERE id=j.id;
 END IF;
 INSERT INTO public.audit_logs(event_id,action,target_id,request_id,metadata) VALUES(p_event_id,'physical_deletion_settled',a.id,j.id,
  jsonb_build_object('result',result,'policy_version',s.physical_deletion_policy->'version'));
 RETURN jsonb_build_object('code',CASE WHEN result='ABSENT' THEN 'DONE' ELSE 'HELD' END);
END $$;
REVOKE ALL ON FUNCTION public.manage_physical_deletion(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_physical_deletion(uuid,uuid,text,jsonb) TO service_role;
COMMENT ON COLUMN public.event_settings.physical_deletion_policy IS 'No default/adopted retention. Versioned human-approved policy with approval/expiry and original/derived/stream/BLOCK retention seconds. Never bypasses provider lock or write-quiescence proof.';
COMMENT ON COLUMN public.outbox_jobs.deletion_plan IS 'Immutable tombstone target. Unknown original single-PUT writers, lost create IDs, retries and unfinished processing are held, not guessed absent. Dedicated state is independent from notification ambiguity.';
NOTIFY pgrst,'reload schema';
COMMIT;
