-- Queue delivery is not processing completion. No external settings are enabled here.
BEGIN;
ALTER TABLE public.outbox_jobs
  ADD COLUMN dispatch_attempt integer NOT NULL DEFAULT 0 CHECK (dispatch_attempt BETWEEN 0 AND 8),
  ADD COLUMN dispatch_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dispatch_locked_until timestamptz,
  ADD COLUMN dispatched_at timestamptz;
COMMENT ON COLUMN public.outbox_jobs.dispatched_at IS 'Queue producer acknowledgement only; never a processing/publication verdict.';
CREATE INDEX outbox_media_dispatch ON public.outbox_jobs (dispatch_available_at, created_at, id)
  WHERE kind='process_media' AND completed_at IS NULL AND dispatched_at IS NULL;

CREATE FUNCTION public.claim_media_dispatch(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  observed_at timestamptz := clock_timestamp();
  jobs jsonb;
  exhausted boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='claim_media_dispatch requires READ COMMITTED';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  WITH candidates AS (
    SELECT id FROM public.outbox_jobs
    WHERE kind='process_media' AND completed_at IS NULL AND dispatched_at IS NULL
      AND dispatch_attempt<8 AND dispatch_available_at<=observed_at
      AND (dispatch_locked_until IS NULL OR dispatch_locked_until<=observed_at)
    ORDER BY dispatch_available_at,created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.outbox_jobs j SET dispatch_attempt=dispatch_attempt+1,
      dispatch_locked_until=observed_at+interval '120 seconds'
    FROM candidates c WHERE j.id=c.id RETURNING j.*
  ) SELECT coalesce(jsonb_agg(jsonb_build_object(
      'job_id',id,'event_id',event_id,'post_id',post_id,'attempt',dispatch_attempt,
      'asset_id',CASE WHEN jsonb_typeof(payload->'asset_id')='string'
        AND (payload->>'asset_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN payload->'asset_id' ELSE 'null'::jsonb END,
      'post_version',CASE WHEN jsonb_typeof(payload->'post_version')='number' THEN
        CASE WHEN (payload->>'post_version')::numeric BETWEEN 1 AND 2147483647
          AND (payload->>'post_version')::numeric=trunc((payload->>'post_version')::numeric)
          THEN payload->'post_version' ELSE 'null'::jsonb END ELSE 'null'::jsonb END
    ) ORDER BY dispatch_available_at,created_at,id),'[]'::jsonb) INTO jobs FROM claimed;
  SELECT EXISTS(SELECT 1 FROM public.outbox_jobs
    WHERE kind='process_media' AND completed_at IS NULL AND dispatched_at IS NULL
      AND dispatch_attempt=8 AND (dispatch_locked_until IS NULL OR dispatch_locked_until<=observed_at)) INTO exhausted;
  RETURN jsonb_build_object('code','ok','jobs',jobs,'exhausted',exhausted);
END;
$$;

CREATE FUNCTION public.settle_media_dispatch(p_claims jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  item jsonb;
  row_data public.outbox_jobs%ROWTYPE;
  observed_at timestamptz;
  settled integer := 0;
  stale integer := 0;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='settle_media_dispatch requires READ COMMITTED';
  END IF;
  IF jsonb_typeof(p_claims) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF jsonb_array_length(p_claims) NOT BETWEEN 1 AND 10 THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  -- Validate the entire batch before mutations; reject duplicates and extra fields.
  FOR item IN SELECT value FROM jsonb_array_elements(p_claims) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF NOT (item ?& ARRAY['job_id','attempt','outcome']) OR item-ARRAY['job_id','attempt','outcome']<>'{}'::jsonb
      OR jsonb_typeof(item->'job_id') IS DISTINCT FROM 'string'
      OR (item->>'job_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR jsonb_typeof(item->'attempt') IS DISTINCT FROM 'number'
      OR jsonb_typeof(item->'outcome') IS DISTINCT FROM 'string'
      OR item->>'outcome' NOT IN ('sent','retry') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF (item->>'attempt')::numeric NOT BETWEEN 1 AND 8
      OR (item->>'attempt')::numeric<>trunc((item->>'attempt')::numeric) THEN
      RETURN jsonb_build_object('code','INVALID_INPUT');
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'job_id') FROM jsonb_array_elements(p_claims))<>jsonb_array_length(p_claims) THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  -- Stable lock order. Check lease after taking the lock, not before waiting for it.
  FOR item IN SELECT value FROM jsonb_array_elements(p_claims) ORDER BY value->>'job_id' LOOP
    SELECT * INTO row_data FROM public.outbox_jobs WHERE id=(item->>'job_id')::uuid FOR UPDATE;
    observed_at := clock_timestamp();
    IF NOT FOUND OR row_data.kind<>'process_media' OR row_data.completed_at IS NOT NULL OR row_data.dispatched_at IS NOT NULL
      OR row_data.dispatch_attempt<>(item->>'attempt')::integer
      OR row_data.dispatch_locked_until IS NULL OR row_data.dispatch_locked_until<=observed_at THEN
      stale := stale+1;
      CONTINUE;
    END IF;
    UPDATE public.outbox_jobs SET
      dispatched_at=CASE WHEN item->>'outcome'='sent' THEN observed_at ELSE NULL END,
      dispatch_locked_until=NULL,
      dispatch_available_at=CASE WHEN item->>'outcome'='retry'
        THEN observed_at+make_interval(secs=>least(900,15*power(2,row_data.dispatch_attempt-1))::double precision)
        ELSE dispatch_available_at END
    WHERE id=row_data.id;
    settled := settled+1;
  END LOOP;
  RETURN jsonb_build_object('code','ok','settled',settled,'stale',stale);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_media_dispatch(integer), public.settle_media_dispatch(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_media_dispatch(integer), public.settle_media_dispatch(jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
