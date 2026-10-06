-- Read-only provider discovery cannot certify absence of an unrecorded late create.
BEGIN;
CREATE TABLE koko_private.cleanup_orphan_observations (
 event_id uuid NOT NULL REFERENCES public.events(event_id),
 job_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 5),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','held')),
 lease_id uuid,
 locked_until timestamptz,
 due_at timestamptz NOT NULL DEFAULT now(),
 observed_at timestamptz,
 result text CHECK(result IN ('NOT_FOUND','MATCHED_CANDIDATE','DUPLICATE','MISMATCH','UNKNOWN','EXHAUSTED')),
 candidate_uid text CHECK(candidate_uid IS NULL OR candidate_uid ~ '^[a-f0-9]{32}$'),
 PRIMARY KEY(event_id,job_id,operation_id),
 FOREIGN KEY(event_id,job_id) REFERENCES public.outbox_jobs(event_id,id)
);
REVOKE ALL ON koko_private.cleanup_orphan_observations FROM PUBLIC,anon,authenticated;
GRANT ALL ON koko_private.cleanup_orphan_observations TO service_role;

CREATE FUNCTION public.reconcile_cleanup_orphans(p_event_id uuid,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.event_settings%ROWTYPE; o koko_private.cleanup_orphan_observations%ROWTYPE; candidate record;
 t timestamptz; plans jsonb:='[]'; observation_result text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='Orphan reconciliation requires READ COMMITTED'; END IF;
 IF p_event_id IS NULL OR p_action IS NULL OR p_action NOT IN ('claim','record') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 PERFORM 1 FROM public.events WHERE event_id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
 SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR UPDATE;
 t:=clock_timestamp();
 IF NOT FOUND OR NOT s.physical_deletion_enabled OR NOT koko_private.valid_deletion_policy(s.physical_deletion_policy,t) THEN RETURN jsonb_build_object('code','DISABLED'); END IF;
 IF p_action='claim' THEN
  IF p_input<>'{}'::jsonb THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  -- Only unresolved durable reservations for a logically deleted post. Never scan a bucket/account broadly.
  FOR candidate IN SELECT q.id AS job_id,p.id AS post_id,a.id AS asset_id,x.value AS entry
   FROM public.outbox_jobs q JOIN public.posts p ON p.event_id=q.event_id AND p.id=q.post_id
   JOIN public.media_assets a ON a.event_id=p.event_id AND a.post_id=p.id AND a.purpose='original'
   CROSS JOIN LATERAL jsonb_each(q.stream_state) x
   WHERE q.event_id=p_event_id AND q.kind='process_media' AND p.status='deleted' AND p.deleted_at IS NOT NULL
    AND a.deletion_requested_at IS NOT NULL AND x.key IN ('source','clip') AND x.value->'uid'='null'::jsonb
    AND x.value->>'providerJobId'=q.id::text AND x.value->'providerPostVersion'=q.payload->'post_version'
    AND q.payload->>'asset_id'=a.id::text AND q.payload->>'object_etag'=a.object_etag AND q.payload->>'object_version'=a.object_version
    AND coalesce(x.value->>'operationId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ((x.key='source' AND x.value->'sourceUid'='null'::jsonb) OR (x.key='clip' AND x.value->>'sourceUid' ~ '^[a-f0-9]{32}$'
      AND EXISTS(SELECT 1 FROM public.media_assets src WHERE src.event_id=p_event_id AND src.post_id=p.id AND src.purpose='stream_source' AND src.stream_uid=x.value->>'sourceUid')))
    AND NOT EXISTS(SELECT 1 FROM koko_private.cleanup_orphan_observations old WHERE old.event_id=p_event_id AND old.job_id=q.id AND old.operation_id::text=x.value->>'operationId')
   ORDER BY q.created_at,q.id,x.key LIMIT 3 LOOP
   INSERT INTO koko_private.cleanup_orphan_observations(event_id,job_id,operation_id,plan) VALUES(p_event_id,candidate.job_id,(candidate.entry->>'operationId')::uuid,
    jsonb_build_object('event_id',p_event_id,'post_id',candidate.post_id,'job_id',candidate.job_id,'operation_id',candidate.entry->'operationId','original_asset_id',candidate.asset_id,'post_version',candidate.entry->'providerPostVersion','source_uid',candidate.entry->'sourceUid'));
  END LOOP;
  FOR o IN SELECT * FROM koko_private.cleanup_orphan_observations WHERE event_id=p_event_id AND state IN ('pending','running') AND due_at<=t AND (locked_until IS NULL OR locked_until<=t)
   ORDER BY due_at,job_id,operation_id LIMIT 3 FOR UPDATE LOOP
   IF o.attempt>=5 THEN UPDATE koko_private.cleanup_orphan_observations SET state='held',result='EXHAUSTED',lease_id=NULL,locked_until=NULL WHERE event_id=p_event_id AND job_id=o.job_id AND operation_id=o.operation_id; CONTINUE; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.posts p JOIN public.outbox_jobs q ON q.event_id=p.event_id AND q.post_id=p.id
    WHERE q.event_id=p_event_id AND q.id=o.job_id AND p.status='deleted' AND p.deleted_at IS NOT NULL
     AND EXISTS(SELECT 1 FROM jsonb_each(q.stream_state) x WHERE x.value->'operationId'=o.plan->'operation_id' AND x.value->'uid'='null'::jsonb)) THEN
    UPDATE koko_private.cleanup_orphan_observations SET state='held',result='MISMATCH',lease_id=NULL,locked_until=NULL WHERE event_id=p_event_id AND job_id=o.job_id AND operation_id=o.operation_id; CONTINUE;
   END IF;
   UPDATE koko_private.cleanup_orphan_observations SET state='running',attempt=attempt+1,lease_id=gen_random_uuid(),locked_until=t+interval '90 seconds'
    WHERE event_id=p_event_id AND job_id=o.job_id AND operation_id=o.operation_id RETURNING * INTO o;
   plans:=plans||jsonb_build_array(jsonb_build_object('plan',o.plan,'lease_id',o.lease_id));
  END LOOP;
  RETURN jsonb_build_object('code','CLAIMED','claims',plans);
 END IF;
 IF NOT(p_input ?& ARRAY['plan','lease_id','result','candidate_uid']) OR p_input-ARRAY['plan','lease_id','result','candidate_uid']<>'{}'::jsonb
  OR jsonb_typeof(p_input->'plan') IS DISTINCT FROM 'object' OR coalesce(p_input->>'lease_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR jsonb_typeof(p_input->'result') IS DISTINCT FROM 'string' OR p_input->>'result' NOT IN ('NOT_FOUND','MATCHED_CANDIDATE','DUPLICATE','MISMATCH','UNKNOWN')
  OR (CASE WHEN p_input->>'result'='MATCHED_CANDIDATE' THEN jsonb_typeof(p_input->'candidate_uid') IS DISTINCT FROM 'string' OR p_input->>'candidate_uid' !~ '^[a-f0-9]{32}$' ELSE p_input->'candidate_uid' IS DISTINCT FROM 'null'::jsonb END) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 SELECT * INTO o FROM koko_private.cleanup_orphan_observations WHERE event_id=p_event_id AND plan=p_input->'plan' AND lease_id=(p_input->>'lease_id')::uuid AND state='running' AND locked_until>t FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 observation_result:=p_input->>'result';
 UPDATE koko_private.cleanup_orphan_observations SET state=CASE WHEN observation_result IN ('NOT_FOUND','UNKNOWN') AND attempt<5 THEN 'pending' ELSE 'held' END,
  result=observation_result,candidate_uid=p_input->>'candidate_uid',observed_at=t,due_at=t+interval '5 minutes',lease_id=NULL,locked_until=NULL
  WHERE event_id=p_event_id AND job_id=o.job_id AND operation_id=o.operation_id;
 -- A match is a REVIEW CANDIDATE, not deletion permission, immutable generation proof or physical success.
 RETURN jsonb_build_object('code','RECORDED');
END $$;
REVOKE ALL ON FUNCTION public.reconcile_cleanup_orphans(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_cleanup_orphans(uuid,text,jsonb) TO service_role;
COMMENT ON TABLE koko_private.cleanup_orphan_observations IS 'Service-only bounded observations of unknown Stream creates. Zero results never prove no late create. Matched/duplicate/unknown are review holds, never delete authorizations. Lost multipart create IDs remain WRITE_OUTCOME_UNKNOWN pending provider inventory acceptance.';
NOTIFY pgrst,'reload schema';
COMMIT;
