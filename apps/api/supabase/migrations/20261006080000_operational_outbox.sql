-- Stage 3 operational jobs. No trigger/flag here enables external IO or physical deletion.
BEGIN;
ALTER TABLE public.event_settings ADD COLUMN operational_outbox_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.outbox_jobs
  ADD COLUMN ops_state text NOT NULL DEFAULT 'pending' CHECK (ops_state IN ('pending','running','started','done','held','ambiguous')),
  ADD COLUMN ops_attempt integer NOT NULL DEFAULT 0 CHECK (ops_attempt BETWEEN 0 AND 5),
  ADD COLUMN ops_lease_id uuid,
  ADD COLUMN ops_locked_until timestamptz,
  ADD COLUMN ops_deadline timestamptz,
  ADD COLUMN ops_result text CHECK (ops_result IN ('DELIVERED','APPLICATION_GATE_CHECKED','SUPERSEDED','ALREADY_DELETED','INVALID_PAYLOAD','RETRY_EXHAUSTED','AMBIGUOUS_SEND','PROVIDER_REJECTED','RETENTION_UNKNOWN','RETENTION_PENDING','PHYSICAL_DELETION_NOT_ENABLED'));
COMMENT ON COLUMN public.outbox_jobs.ops_state IS 'started means a notification may have been sent; an expired started lease becomes ambiguous, never automatically resent. held/ambiguous are NOT completion.';
CREATE INDEX operational_outbox_due ON public.outbox_jobs(event_id,available_at,created_at,id)
  WHERE kind IN ('notify','revoke_delivery','delete_assets') AND completed_at IS NULL AND ops_state IN ('pending','running','started');

CREATE FUNCTION public.stage_three_outbox(p_event_id uuid,p_job_id uuid,p_action text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE
  e public.events%ROWTYPE; s public.event_settings%ROWTYPE; j public.outbox_jobs%ROWTYPE;
  p public.posts%ROWTYPE; a public.media_assets%ROWTYPE; m public.event_members%ROWTYPE;
  ap public.appeals%ROWTYPE; t timestamptz; lease uuid; jobs jsonb:='[]'::jsonb;
  category text; display_name text; target_user uuid; result text; report_count integer; capacity jsonb; n numeric; measured_at timestamptz;
  held integer:=0; version_number numeric; retry_seconds integer; invalid boolean:=false;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='stage_three_outbox requires READ COMMITTED';
  END IF;
  IF p_event_id IS NULL OR p_action IS NULL OR p_action NOT IN ('claim','prepare','settle')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  -- Same event-first order as state-changing API and media RPCs. A kill switch does not
  -- suppress safety notifications/deletion review; only this independent opt-in disables IO.
  SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND OR NOT s.operational_outbox_enabled THEN RETURN jsonb_build_object('code','DISABLED'); END IF;
  t:=clock_timestamp();
  IF p_action='claim' THEN
    IF p_job_id IS NOT NULL OR NOT(p_input ?& ARRAY['limit','notify']) OR p_input-ARRAY['limit','notify']<>'{}'::jsonb
      OR jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR jsonb_typeof(p_input->'notify') IS DISTINCT FROM 'boolean' THEN
      RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF (p_input->>'limit')::numeric NOT BETWEEN 1 AND 10 OR (p_input->>'limit')::numeric<>trunc((p_input->>'limit')::numeric) THEN
      RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    FOR j IN SELECT * FROM public.outbox_jobs WHERE event_id=p_event_id
      AND kind IN ('notify','revoke_delivery','delete_assets') AND (kind<>'notify' OR (p_input->>'notify')::boolean)
      AND completed_at IS NULL AND ops_state IN ('pending','running','started') AND available_at<=t
      AND (ops_locked_until IS NULL OR ops_locked_until<=t)
      ORDER BY available_at,created_at,id LIMIT (p_input->>'limit')::integer FOR UPDATE SKIP LOCKED LOOP
      IF j.ops_state='started' THEN result:='AMBIGUOUS_SEND';
      ELSIF j.ops_attempt>=5 OR j.ops_deadline<=t THEN result:='RETRY_EXHAUSTED'; ELSE result:=NULL; END IF;
      IF result IS NOT NULL THEN
        UPDATE public.outbox_jobs SET ops_state=CASE WHEN result='AMBIGUOUS_SEND' THEN 'ambiguous' ELSE 'held' END,
          ops_result=result,ops_lease_id=NULL,ops_locked_until=NULL WHERE id=j.id;
        INSERT INTO public.audit_logs(event_id,action,target_id,request_id,metadata)
          VALUES(p_event_id,'operational_outbox_held',j.id,j.id,jsonb_build_object('kind',j.kind,'result',result));
        held:=held+1; CONTINUE;
      END IF;
      lease:=gen_random_uuid();
      UPDATE public.outbox_jobs SET ops_state='running',ops_attempt=ops_attempt+1,ops_lease_id=lease,
        ops_locked_until=t+interval '300 seconds',ops_deadline=coalesce(ops_deadline,t+interval '24 hours'),ops_result=NULL WHERE id=j.id;
      jobs:=jobs||jsonb_build_array(jsonb_build_object('job_id',j.id,'event_id',j.event_id,'lease_id',lease,'kind',j.kind,'attempt',j.ops_attempt+1));
    END LOOP;
    RETURN jsonb_build_object('code','CLAIMED','jobs',jobs,'held',held);
  END IF;
  IF p_job_id IS NULL OR NOT(p_input ? 'lease_id') OR jsonb_typeof(p_input->'lease_id') IS DISTINCT FROM 'string'
    OR p_input->>'lease_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF (p_action='prepare' AND p_input-ARRAY['lease_id']<>'{}'::jsonb)
    OR (p_action='settle' AND (NOT(p_input ?& ARRAY['outcome','retry_seconds']) OR p_input-ARRAY['lease_id','outcome','retry_seconds']<>'{}'::jsonb
      OR jsonb_typeof(p_input->'outcome') IS DISTINCT FROM 'string' OR p_input->>'outcome' NOT IN ('delivered','retry','ambiguous','rejected')
      OR jsonb_typeof(p_input->'retry_seconds') IS DISTINCT FROM 'number')) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF p_action='settle' THEN
    IF (p_input->>'retry_seconds')::numeric NOT BETWEEN 0 AND 86400 OR (p_input->>'retry_seconds')::numeric<>trunc((p_input->>'retry_seconds')::numeric)
      OR (p_input->>'outcome'<>'retry' AND (p_input->>'retry_seconds')::numeric<>0) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  END IF;
  SELECT * INTO j FROM public.outbox_jobs WHERE event_id=p_event_id AND id=p_job_id FOR UPDATE;
  t:=clock_timestamp();
  IF NOT FOUND OR j.kind NOT IN ('notify','revoke_delivery','delete_assets') OR j.completed_at IS NOT NULL
    OR j.ops_state NOT IN ('running','started') OR j.ops_lease_id IS DISTINCT FROM (p_input->>'lease_id')::uuid
    OR j.ops_locked_until IS NULL OR j.ops_locked_until<=t OR j.ops_deadline IS NULL OR j.ops_deadline<=t
    OR j.ops_attempt NOT BETWEEN 1 AND 5 THEN RETURN jsonb_build_object('code','STALE'); END IF;
  IF p_action='settle' THEN
    IF j.kind<>'notify' OR j.ops_state<>'started' THEN RETURN jsonb_build_object('code','STALE'); END IF;
    IF p_input->>'outcome'='retry' THEN
      retry_seconds:=greatest((p_input->>'retry_seconds')::integer,least(900,15*power(2,j.ops_attempt-1))::integer);
      IF j.ops_attempt>=5 OR t+make_interval(secs=>retry_seconds)>=j.ops_deadline THEN result:='RETRY_EXHAUSTED';
      ELSE
        UPDATE public.outbox_jobs SET ops_state='pending',ops_lease_id=NULL,ops_locked_until=NULL,
          available_at=t+make_interval(secs=>retry_seconds) WHERE id=j.id;
        RETURN jsonb_build_object('code','RETRY');
      END IF;
    ELSE result:=CASE p_input->>'outcome' WHEN 'delivered' THEN 'DELIVERED' WHEN 'ambiguous' THEN 'AMBIGUOUS_SEND' ELSE 'PROVIDER_REJECTED' END; END IF;
  ELSE
    IF j.ops_state<>'running' THEN RETURN jsonb_build_object('code','STALE'); END IF;
    IF j.post_id IS NOT NULL THEN SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=j.post_id FOR UPDATE;
      IF NOT FOUND THEN invalid:=true; END IF;
    END IF;
    IF j.kind='notify' THEN
      category:=j.payload->>'category'; report_count:=NULL;
      IF category IN ('flag','block','ai_error','stream_failure','processing_error') THEN
        invalid:=invalid OR j.post_id IS NULL OR j.payload-ARRAY['category','post_version']<>'{}'::jsonb
          OR jsonb_typeof(j.payload->'post_version') IS DISTINCT FROM 'number';
        IF NOT invalid THEN
          version_number:=(j.payload->>'post_version')::numeric;
          invalid:=version_number<1 OR version_number>p.version OR version_number<>trunc(version_number);
        END IF;
        target_user:=p.user_id;
      ELSIF category='report' THEN
        invalid:=invalid OR j.post_id IS NULL OR j.payload-ARRAY['category','report_count']<>'{}'::jsonb
          OR j.payload->'report_count' NOT IN ('1'::jsonb,'2'::jsonb) OR NOT(j.payload ? 'report_count');
        IF NOT invalid THEN report_count:=(j.payload->>'report_count')::integer; invalid:=p.report_count<report_count; END IF;
        target_user:=p.user_id;
      ELSIF category='ban' THEN
        invalid:=invalid OR j.payload-ARRAY['category','user_id']<>'{}'::jsonb
          OR coalesce(j.payload->>'user_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
        IF NOT invalid THEN target_user:=(j.payload->>'user_id')::uuid; invalid:=j.post_id IS NOT NULL AND p.user_id<>target_user; END IF;
      ELSIF category='appeal' THEN
        invalid:=invalid OR j.payload-ARRAY['category','appeal_id']<>'{}'::jsonb
          OR coalesce(j.payload->>'appeal_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
        IF NOT invalid THEN
          SELECT * INTO ap FROM public.appeals WHERE event_id=p_event_id AND id=(j.payload->>'appeal_id')::uuid;
          invalid:=NOT FOUND OR ap.post_id IS DISTINCT FROM j.post_id; target_user:=ap.user_id;
        END IF;
      ELSIF category='capacity' THEN
        invalid:=j.post_id IS NOT NULL OR NOT(j.payload ?& ARRAY['category','source','epoch','policy_version','observed_bytes','limit_bytes','observed_at'])
          OR j.payload-ARRAY['category','source','epoch','policy_version','observed_bytes','limit_bytes','observed_at']<>'{}'::jsonb
          OR j.payload->>'source' IS DISTINCT FROM 'r2_storage' OR jsonb_typeof(j.payload->'epoch') IS DISTINCT FROM 'number'
          OR jsonb_typeof(j.payload->'policy_version') IS DISTINCT FROM 'number' OR jsonb_typeof(j.payload->'observed_bytes') IS DISTINCT FROM 'number'
          OR jsonb_typeof(j.payload->'limit_bytes') IS DISTINCT FROM 'number' OR jsonb_typeof(j.payload->'observed_at') IS DISTINCT FROM 'string'
          OR coalesce(j.payload->>'observed_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$';
        IF NOT invalid THEN
          FOREACH n IN ARRAY ARRAY[(j.payload->>'epoch')::numeric,(j.payload->>'policy_version')::numeric,(j.payload->>'observed_bytes')::numeric,(j.payload->>'limit_bytes')::numeric] LOOP
            invalid:=invalid OR n NOT BETWEEN 1 AND 9007199254740991 OR n<>trunc(n);
          END LOOP;
          invalid:=invalid OR (j.payload->>'observed_bytes')::numeric<(j.payload->>'limit_bytes')::numeric
            OR (j.payload->>'epoch')::numeric>floor(extract(epoch FROM t)/3600) OR (j.payload->>'epoch')::numeric<floor(extract(epoch FROM t)/3600)-744;
          BEGIN measured_at:=(j.payload->>'observed_at')::timestamptz;
          EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN invalid:=true; END;
          invalid:=invalid OR measured_at>t OR measured_at<t-interval '32 days';
          capacity:=jsonb_build_object('observed_bytes',j.payload->'observed_bytes','limit_bytes',j.payload->'limit_bytes','observed_at',j.payload->'observed_at');
          display_name:='イベント容量監視';
        END IF;
      ELSE invalid:=true; END IF;
      IF NOT invalid AND category<>'capacity' THEN
        SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=target_user;
        invalid:=NOT FOUND; display_name:=m.display_name;
      END IF;
      IF NOT invalid THEN
        -- Durable send intent: crash/timeout after this point is ambiguous, not safe to repeat.
        UPDATE public.outbox_jobs SET ops_state='started' WHERE id=j.id;
        RETURN jsonb_build_object('code','SEND','notification',jsonb_build_object('job_id',j.id,'event_id',p_event_id,
          'post_id',j.post_id,'category',category,'display_name',display_name,'report_count',report_count)||CASE WHEN category='capacity' THEN jsonb_build_object('capacity',capacity) ELSE '{}'::jsonb END);
      END IF;
    ELSE
      invalid:=invalid OR j.post_id IS NULL OR jsonb_typeof(j.payload->'post_version') IS DISTINCT FROM 'number';
      IF NOT invalid THEN
        version_number:=(j.payload->>'post_version')::numeric;
        invalid:=version_number<1 OR version_number>p.version OR version_number<>trunc(version_number);
      END IF;
      IF j.kind='revoke_delivery' THEN
        invalid:=invalid OR j.payload-ARRAY['post_version']<>'{}'::jsonb;
        IF NOT invalid THEN
          SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=p.user_id;
          IF NOT FOUND THEN invalid:=true;
          ELSIF p.status NOT IN ('published','published_flagged') OR p.ban_latched OR m.is_banned OR s.publication_stopped
            OR e.status<>'live' OR e.starts_at>t OR e.private_at<=t OR NOT EXISTS(SELECT 1 FROM public.consents WHERE event_id=p_event_id AND user_id=p.user_id AND terms_version=e.terms_version) THEN
            result:='APPLICATION_GATE_CHECKED';
          ELSIF p.version>version_number THEN result:='SUPERSEDED'; ELSE invalid:=true; END IF;
        END IF;
      ELSE
        invalid:=invalid OR j.payload-ARRAY['post_version','asset_id']<>'{}'::jsonb
          OR coalesce(j.payload->>'asset_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR p.status<>'deleted' OR p.deleted_at IS NULL;
        IF NOT invalid THEN
          SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=j.post_id AND id=(j.payload->>'asset_id')::uuid FOR UPDATE;
          invalid:=NOT FOUND OR a.deletion_requested_at IS NULL;
          IF NOT invalid THEN
            -- Never infer provider lock absence or approved retention from a nullable timestamp.
            -- Physical deletion is an independent protected integration, not Stage 3 success.
            result:=CASE WHEN a.physically_deleted_at IS NOT NULL THEN 'ALREADY_DELETED'
              WHEN a.provider='r2_original' AND a.retention_until IS NULL THEN 'RETENTION_UNKNOWN'
              WHEN a.retention_until>t THEN 'RETENTION_PENDING' ELSE 'PHYSICAL_DELETION_NOT_ENABLED' END;
          END IF;
        END IF;
      END IF;
    END IF;
    IF invalid THEN result:='INVALID_PAYLOAD'; END IF;
  END IF;
  IF result IS NULL THEN result:='INVALID_PAYLOAD'; END IF;
  UPDATE public.outbox_jobs SET ops_state=CASE WHEN result IN ('DELIVERED','APPLICATION_GATE_CHECKED','SUPERSEDED','ALREADY_DELETED') THEN 'done'
      WHEN result='AMBIGUOUS_SEND' THEN 'ambiguous' ELSE 'held' END,
    completed_at=CASE WHEN result IN ('DELIVERED','APPLICATION_GATE_CHECKED','SUPERSEDED','ALREADY_DELETED') THEN t ELSE NULL END,
    ops_result=result,ops_lease_id=NULL,ops_locked_until=NULL WHERE id=j.id;
  INSERT INTO public.audit_logs(event_id,action,target_id,request_id,metadata)
    VALUES(p_event_id,'operational_outbox_settled',j.id,j.id,jsonb_build_object('kind',j.kind,'result',result));
  RETURN jsonb_build_object('code',CASE WHEN result IN ('DELIVERED','APPLICATION_GATE_CHECKED','SUPERSEDED','ALREADY_DELETED') THEN 'DONE'
    WHEN result='AMBIGUOUS_SEND' THEN 'AMBIGUOUS' ELSE 'HELD' END,'result',result);
END $$;
REVOKE ALL ON FUNCTION public.stage_three_outbox(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stage_three_outbox(uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.stage_three_outbox(uuid,uuid,text,jsonb) IS 'Application gate checks are not evidence of revoking previously issued provider tokens. No physical deletion or lock changes are performed. Held jobs require reviewed remediation; notification ambiguity is never auto-retried.';
NOTIFY pgrst,'reload schema';
COMMIT;
