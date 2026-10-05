-- Read-only provider measurement. Budget/threshold approval and credentials are human gates.
BEGIN;
ALTER TABLE public.event_settings
  ADD COLUMN capacity_limit_bytes bigint CHECK (capacity_limit_bytes BETWEEN 1 AND 9007199254740991),
  ADD COLUMN capacity_limit_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN capacity_policy_version bigint NOT NULL DEFAULT 1 CHECK (capacity_policy_version>0),
  ADD COLUMN capacity_monitor_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capacity_monitor_state)='object');
COMMENT ON COLUMN public.event_settings.capacity_limit_approved IS 'Human-approved threshold only. Ordinary settings edits must never set this. Byte alerts are not billing limits or an automatic stop.';
CREATE FUNCTION koko_private.invalidate_capacity_approval() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NEW.capacity_limit_bytes IS DISTINCT FROM OLD.capacity_limit_bytes THEN
    NEW.capacity_limit_approved:=false; NEW.capacity_policy_version:=OLD.capacity_policy_version+1; NEW.capacity_monitor_state:='{}'::jsonb;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION koko_private.invalidate_capacity_approval() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER capacity_threshold_changed BEFORE UPDATE OF capacity_limit_bytes ON public.event_settings
  FOR EACH ROW EXECUTE FUNCTION koko_private.invalidate_capacity_approval();

CREATE FUNCTION public.manage_capacity_monitor(p_event_id uuid,p_action text,p_input jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.event_settings%ROWTYPE; e public.events%ROWTYPE; state jsonb; t timestamptz; epoch bigint;
  attempt integer; lease uuid; samples jsonb; sample jsonb; total numeric:=0; bytes numeric; ts timestamptz;
  oldest timestamptz; seen text[]:=ARRAY[]::text[]; body jsonb; plan jsonb; alert_id uuid;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='manage_capacity_monitor requires READ COMMITTED'; END IF;
  IF p_event_id IS NULL OR p_action IS NULL OR p_action NOT IN ('claim','finish','fail') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND OR NOT s.operational_outbox_enabled OR NOT s.capacity_limit_approved OR s.capacity_limit_bytes IS NULL
    THEN RETURN jsonb_build_object('code','DISABLED'); END IF;
  t:=clock_timestamp(); epoch:=floor(extract(epoch FROM t)/3600)::bigint; state:=s.capacity_monitor_state;
  IF p_action='claim' THEN
    IF NOT(p_input ? 'account_id') OR p_input-ARRAY['account_id']<>'{}'::jsonb OR jsonb_typeof(p_input->'account_id') IS DISTINCT FROM 'string'
      OR p_input->>'account_id' !~ '^[0-9a-f]{32}$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    -- One durable epoch per event. Bounded retries do not carry an endless backlog forward.
    IF state->>'epoch'=epoch::text AND state->>'policy_version'=s.capacity_policy_version::text THEN
      IF state->>'status'='unknown' THEN RETURN jsonb_build_object('code','UNKNOWN'); END IF;
      IF state->>'status' IN ('observed','alerted') THEN RETURN jsonb_build_object('code','DONE'); END IF;
      IF (state->>'locked_until')::timestamptz>t OR (state->>'available_at')::timestamptz>t THEN RETURN jsonb_build_object('code','WAIT'); END IF;
      attempt:=coalesce((state->>'attempt')::integer,0);
      IF attempt>=3 THEN
        UPDATE public.event_settings SET capacity_monitor_state=state||jsonb_build_object('status','unknown','lease_id',NULL,'locked_until',NULL,'result','MEASUREMENT_UNAVAILABLE') WHERE event_id=p_event_id;
        RETURN jsonb_build_object('code','UNKNOWN');
      END IF;
    ELSE attempt:=0; END IF;
    lease:=gen_random_uuid();
    plan:=jsonb_build_object('event_id',p_event_id,'account_id',p_input->>'account_id','epoch',epoch,'policy_version',s.capacity_policy_version,
      'limit_bytes',s.capacity_limit_bytes,'lease_id',lease,'window_start',to_char((t-interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'window_end',to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    UPDATE public.event_settings SET capacity_monitor_state=jsonb_build_object('epoch',epoch,'policy_version',s.capacity_policy_version,'status','running',
      'attempt',attempt+1,'lease_id',lease,'locked_until',t+interval '120 seconds','plan',plan) WHERE event_id=p_event_id;
    RETURN jsonb_build_object('code','CLAIMED','plan',plan);
  END IF;
  IF NOT(p_input ? 'plan') OR jsonb_typeof(p_input->'plan') IS DISTINCT FROM 'object' OR p_input->'plan' IS DISTINCT FROM state->'plan'
    OR state->>'status'<>'running' OR state->>'epoch' IS DISTINCT FROM epoch::text OR state->>'policy_version' IS DISTINCT FROM s.capacity_policy_version::text
    OR (state->>'locked_until')::timestamptz IS NULL OR (state->>'locked_until')::timestamptz<=t THEN RETURN jsonb_build_object('code','STALE'); END IF;
  plan:=state->'plan';
  IF p_action='fail' THEN
    IF p_input-ARRAY['plan']<>'{}'::jsonb THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    attempt:=(state->>'attempt')::integer;
    UPDATE public.event_settings SET capacity_monitor_state=state||jsonb_build_object('status',CASE WHEN attempt>=3 THEN 'unknown' ELSE 'retry' END,
      'result','MEASUREMENT_UNAVAILABLE','lease_id',NULL,'locked_until',NULL,'available_at',t+make_interval(secs=>300*attempt)) WHERE event_id=p_event_id;
    RETURN jsonb_build_object('code',CASE WHEN attempt>=3 THEN 'UNKNOWN' ELSE 'RETRY' END);
  END IF;
  IF NOT(p_input ? 'samples') OR p_input-ARRAY['plan','samples']<>'{}'::jsonb OR jsonb_typeof(p_input->'samples') IS DISTINCT FROM 'array'
    THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  samples:=p_input->'samples';
  IF jsonb_array_length(samples)<>2 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  FOR sample IN SELECT value FROM jsonb_array_elements(samples) LOOP
    IF jsonb_typeof(sample) IS DISTINCT FROM 'object' OR NOT(sample ?& ARRAY['bucket','observed_at','payload_bytes','metadata_bytes','object_count'])
      OR sample-ARRAY['bucket','observed_at','payload_bytes','metadata_bytes','object_count']<>'{}'::jsonb
      OR jsonb_typeof(sample->'bucket') IS DISTINCT FROM 'string' OR sample->>'bucket' NOT IN ('koko-dev-originals','koko-dev-derived')
      OR sample->>'bucket'=ANY(seen) OR jsonb_typeof(sample->'observed_at') IS DISTINCT FROM 'string'
      OR sample->>'observed_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$'
      OR jsonb_typeof(sample->'payload_bytes') IS DISTINCT FROM 'number' OR jsonb_typeof(sample->'metadata_bytes') IS DISTINCT FROM 'number'
      OR jsonb_typeof(sample->'object_count') IS DISTINCT FROM 'number' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    FOREACH bytes IN ARRAY ARRAY[(sample->>'payload_bytes')::numeric,(sample->>'metadata_bytes')::numeric,(sample->>'object_count')::numeric] LOOP
      IF bytes NOT BETWEEN 0 AND 9007199254740991 OR bytes<>trunc(bytes) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    END LOOP;
    BEGIN ts:=(sample->>'observed_at')::timestamptz; EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END;
    -- Freshness is our conservative acceptance gate, not a provider update-latency guarantee.
    IF ts<(plan->>'window_end')::timestamptz-interval '2 hours' OR ts>(plan->>'window_end')::timestamptz THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    oldest:=least(oldest,ts); seen:=array_append(seen,sample->>'bucket'); total:=total+(sample->>'payload_bytes')::numeric+(sample->>'metadata_bytes')::numeric;
  END LOOP;
  IF total>9007199254740991 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF total>=s.capacity_limit_bytes THEN
    body:=jsonb_build_object('category','capacity','source','r2_storage','epoch',epoch,'policy_version',s.capacity_policy_version,
      'observed_bytes',total,'limit_bytes',s.capacity_limit_bytes,'observed_at',to_char(oldest AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    INSERT INTO public.outbox_jobs(event_id,kind,deduplication_key,payload) VALUES(p_event_id,'notify','capacity:'||s.capacity_policy_version||':'||epoch,body)
      ON CONFLICT(event_id,deduplication_key) DO NOTHING RETURNING id INTO alert_id;
  END IF;
  UPDATE public.event_settings SET capacity_monitor_state=state||jsonb_build_object('status',CASE WHEN total>=s.capacity_limit_bytes THEN 'alerted' ELSE 'observed' END,
    'lease_id',NULL,'locked_until',NULL,'samples',samples,'observed_bytes',total,'observed_at',oldest,'result','OBSERVED') WHERE event_id=p_event_id;
  INSERT INTO public.audit_logs(event_id,action,request_id,metadata) VALUES(p_event_id,'capacity_observed',(plan->>'lease_id')::uuid,
    jsonb_build_object('epoch',epoch,'policy_version',s.capacity_policy_version,'threshold_reached',total>=s.capacity_limit_bytes));
  RETURN jsonb_build_object('code',CASE WHEN total>=s.capacity_limit_bytes THEN 'ALERTED' ELSE 'OBSERVED' END);
END $$;
REVOKE ALL ON FUNCTION public.manage_capacity_monitor(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_capacity_monitor(uuid,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
