-- Internal AI evidence and atomic publication. No provider calls, policy approval or deletion schedule.
BEGIN;
ALTER TABLE public.posts ADD COLUMN moderation_block_counted boolean NOT NULL DEFAULT false;
ALTER TABLE public.media_assets
  ADD COLUMN stream_ready_to_stream boolean NOT NULL DEFAULT false,
  ADD COLUMN stream_require_signed_urls boolean NOT NULL DEFAULT false,
  ADD COLUMN stream_processing_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN stream_source_uid text CHECK (stream_source_uid ~ '^[a-f0-9]{32}$'),
  ADD COLUMN stream_duration_seconds numeric CHECK (stream_duration_seconds>0);
COMMENT ON COLUMN public.media_assets.stream_processing_complete IS 'Service-attested Stream status.state=ready AND pctComplete=100; readyToStream alone is insufficient.';
ALTER TABLE public.outbox_jobs
  ADD CONSTRAINT outbox_event_id UNIQUE(event_id,id),
  ADD COLUMN moderation_media jsonb CHECK (moderation_media IS NULL OR jsonb_typeof(moderation_media)='object'),
  ADD COLUMN moderation_owner_id uuid REFERENCES auth.users(id),
  ADD COLUMN moderation_processing_attempt integer NOT NULL DEFAULT 0 CHECK(moderation_processing_attempt BETWEEN 0 AND 3),
  ADD COLUMN moderation_plan jsonb CHECK (moderation_plan IS NULL OR jsonb_typeof(moderation_plan)='object'),
  ADD COLUMN moderation_completed_at timestamptz,
  ADD COLUMN moderation_receipt jsonb CHECK (moderation_receipt IS NULL OR jsonb_typeof(moderation_receipt)='object'),
  ADD CONSTRAINT moderation_completion_pair CHECK ((moderation_completed_at IS NULL)=(moderation_receipt IS NULL));
ALTER TABLE public.moderation_runs
  DROP CONSTRAINT moderation_runs_event_id_post_id_attempt_engine_key,
  ADD COLUMN job_id uuid,
  ADD COLUMN frame_index integer NOT NULL DEFAULT 0 CHECK (frame_index BETWEEN 0 AND 2),
  ADD COLUMN post_version bigint,
  ADD COLUMN policy_version bigint,
  ADD COLUMN observation text CHECK (observation IN ('scores','no_text','error')),
  ADD COLUMN usage jsonb CHECK (usage IS NULL OR jsonb_typeof(usage)='object'),
  ADD CONSTRAINT moderation_job_event FOREIGN KEY(event_id,job_id) REFERENCES public.outbox_jobs(event_id,id),
  ADD CONSTRAINT moderation_job_attempt UNIQUE(event_id,job_id,frame_index,attempt,engine);
CREATE UNIQUE INDEX moderation_legacy_attempt ON public.moderation_runs(event_id,post_id,attempt,engine) WHERE job_id IS NULL;

-- Provider-wide operational counters are NOT a fifteenth application/business table.
-- They intentionally span event_id because the same provider credential/quota serves events.
-- No limits or approval are seeded: absent/unapproved configuration fails closed.
CREATE TABLE koko_private.moderation_budgets (
  provider text PRIMARY KEY CHECK(provider IN ('openai','vision')),
  approved boolean NOT NULL DEFAULT false,
  calls_per_minute integer CHECK(calls_per_minute>0),
  window_start timestamptz,
  used integer NOT NULL DEFAULT 0 CHECK(used>=0),
  CHECK(NOT approved OR calls_per_minute IS NOT NULL)
);
CREATE TABLE koko_private.moderation_calls (
  event_id uuid NOT NULL,
  job_id uuid NOT NULL,
  engine text NOT NULL CHECK(engine IN ('openai','safesearch','ocr')),
  frame_index integer NOT NULL CHECK(frame_index BETWEEN 0 AND 2),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  provider text NOT NULL CHECK(provider IN ('openai','vision')),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(event_id,job_id,engine,frame_index,attempt,provider),
  FOREIGN KEY(event_id,job_id) REFERENCES public.outbox_jobs(event_id,id),
  CHECK((engine='openai' AND provider='openai') OR (engine='safesearch' AND provider='vision') OR engine='ocr')
);
ALTER TABLE koko_private.moderation_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE koko_private.moderation_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON koko_private.moderation_budgets,koko_private.moderation_calls FROM PUBLIC,anon,authenticated;
GRANT ALL ON koko_private.moderation_budgets,koko_private.moderation_calls TO service_role;

CREATE FUNCTION koko_private.moderation_categories(p_engine text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE p_engine
  WHEN 'openai' THEN ARRAY['sexual','violence','violence/graphic','self-harm','self-harm/intent','self-harm/instructions']
  WHEN 'safesearch' THEN ARRAY['adult','spoof','medical','violence','racy']
  WHEN 'ocr' THEN ARRAY['sexual','sexual/minors','violence','violence/graphic','self-harm','self-harm/intent','self-harm/instructions','harassment','harassment/threatening','hate','hate/threatening','illicit','illicit/violent']
 END;
$$;
CREATE FUNCTION koko_private.valid_moderation_thresholds(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE t jsonb;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p_value)<>24 THEN RETURN false; END IF;
 FOR t IN SELECT value FROM jsonb_array_elements(p_value) LOOP
  IF jsonb_typeof(t) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF NOT(t ?& ARRAY['engine','category','flag','block','immediate_ban']) OR t-ARRAY['engine','category','flag','block','immediate_ban']<>'{}'::jsonb
    OR jsonb_typeof(t->'engine') IS DISTINCT FROM 'string' OR t->>'engine' NOT IN ('openai','safesearch','ocr')
    OR jsonb_typeof(t->'category') IS DISTINCT FROM 'string' OR NOT(t->>'category'=ANY(koko_private.moderation_categories(t->>'engine')))
    OR jsonb_typeof(t->'flag') IS DISTINCT FROM 'number' OR jsonb_typeof(t->'block') IS DISTINCT FROM 'number'
    OR jsonb_typeof(t->'immediate_ban') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  IF (t->>'flag')::numeric NOT BETWEEN 0 AND 1 OR (t->>'block')::numeric NOT BETWEEN 0 AND 1 OR (t->>'flag')::numeric>(t->>'block')::numeric
    OR ((t->>'immediate_ban')::boolean AND (t->>'engine'='safesearch' OR t->>'category' NOT IN ('sexual/minors','violence/graphic','illicit/violent','hate/threatening','harassment/threatening'))) THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT(value->>'engine',value->>'category'))=24 FROM jsonb_array_elements(p_value));
END;
$$;
REVOKE ALL ON FUNCTION koko_private.moderation_categories(text),koko_private.valid_moderation_thresholds(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION koko_private.moderation_categories(text),koko_private.valid_moderation_thresholds(jsonb) TO service_role;

CREATE FUNCTION public.manage_media_moderation(p_event_id uuid,p_post_id uuid,p_job_id uuid,p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE
 e public.events%ROWTYPE; s public.event_settings%ROWTYPE; m public.event_members%ROWTYPE;
 p public.posts%ROWTYPE; j public.outbox_jobs%ROWTYPE; a public.media_assets%ROWTYPE; stream_asset public.media_assets%ROWTYPE;
 budget koko_private.moderation_budgets%ROWTYPE;
 owner_id uuid; stamp timestamptz; policy jsonb; plan jsonb; media jsonb; starts jsonb; original_ref jsonb;
 result jsonb; runs jsonb; r jsonb; t jsonb; scores jsonb; usage_value jsonb;
 frame_count integer; frame_number integer; attempt_number integer; start_attempt integer;
 engine_name text; provider_name text; engine_decision text; run_decision text; verdict text;
 categories jsonb:='[]'; engines jsonb:='[]'; severe boolean:=false; chosen_category text;
 has_block boolean:=false; has_error boolean:=false; has_flag boolean:=false;
 last_attempt integer; expected_keys text[]; observed_code text;
 saved_post public.posts%ROWTYPE; image_evidence public.outbox_jobs%ROWTYPE;
 result_version bigint; score numeric; expires_ms bigint;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='manage_media_moderation requires READ COMMITTED'; END IF;
 IF p_event_id IS NULL OR p_post_id IS NULL OR p_job_id IS NULL OR p_action IS NULL OR p_action NOT IN ('claim','check','reserve','finish','fail')
   OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>65536 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 expected_keys:=CASE p_action WHEN 'claim' THEN ARRAY[]::text[] WHEN 'check' THEN ARRAY['plan']
  WHEN 'fail' THEN ARRAY['plan','reason']
  WHEN 'reserve' THEN ARRAY['plan','provider','engine','frame','attempt'] ELSE ARRAY['plan','result'] END;
 IF NOT(p_input ?& expected_keys) OR p_input-expected_keys<>'{}'::jsonb THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 IF p_action='fail' AND (jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string'
   OR p_input->>'reason' NOT IN ('DECODE_FAILED','ORIGINAL_MISMATCH')) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 -- Event-first exclusive operations interlock with stage_three_operation and image/upload SHARE gates.
 SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_post_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id AND terms_version=e.terms_version AND btrim(e.terms_version)<>'' FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_post_id FOR UPDATE;
 IF NOT FOUND OR p.user_id<>owner_id THEN RETURN jsonb_build_object('code','STALE'); END IF;
 PERFORM 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id ORDER BY id FOR UPDATE;
 SELECT * INTO j FROM public.outbox_jobs WHERE event_id=p_event_id AND post_id=p_post_id AND id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.kind<>'process_media' THEN RETURN jsonb_build_object('code','STALE'); END IF;
 IF j.moderation_completed_at IS NOT NULL THEN
  IF p_action='finish' AND p_input->'plan'=j.moderation_plan AND p_input->'result'=j.moderation_receipt THEN RETURN jsonb_build_object('code','RECORDED'); END IF;
  RETURN jsonb_build_object('code','DONE');
 END IF;
 stamp:=clock_timestamp();
 IF j.completed_at IS NOT NULL OR p.status<>'processing' OR p.deleted_at IS NOT NULL OR p.ban_latched OR m.is_banned
   OR p.version NOT BETWEEN 1 AND 2147483646 OR e.status<>'live' OR stamp<e.starts_at OR stamp>=e.private_at
   OR s.publication_stopped OR NOT s.uploads_enabled THEN RETURN jsonb_build_object('code','STALE'); END IF;
 SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose='original';
 IF NOT FOUND OR a.deletion_requested_at IS NOT NULL OR a.physically_deleted_at IS NOT NULL
   OR a.byte_size IS NULL OR a.byte_size IS DISTINCT FROM p.original_bytes OR a.object_etag IS NULL OR a.object_version IS NULL
   OR a.object_etag !~ '^[a-f0-9]{32}(-[1-9][0-9]{0,3}|-10000)?$'
   OR j.payload->'asset_id' IS DISTINCT FROM to_jsonb(a.id) OR j.payload->'object_etag' IS DISTINCT FROM to_jsonb(a.object_etag)
   OR j.payload->'object_version' IS DISTINCT FROM to_jsonb(a.object_version)
   OR (j.payload->'post_version' IS DISTINCT FROM to_jsonb(p.version)
    AND (j.image_plan->'postVersion' IS DISTINCT FROM to_jsonb(p.version) OR j.payload->'post_version' IS DISTINCT FROM to_jsonb(p.version-1))) THEN RETURN jsonb_build_object('code','STALE'); END IF;
 original_ref:=jsonb_strip_nulls(jsonb_build_object('eventId',p_event_id,'postId',p_post_id,'assetId',a.id,'size',a.byte_size,'etag',a.object_etag,'objectVersion',a.object_version,'sha256',a.sha256));
 IF p.kind='photo' THEN
  frame_count:=1;
  IF a.sha256 IS NULL OR a.byte_size>67108864 OR (SELECT count(*) FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id
    AND purpose LIKE 'delivery_%' AND provider='r2_delivery' AND byte_size>0 AND sha256 IS NOT NULL AND pixel_width>0 AND pixel_height>0
    AND deletion_requested_at IS NULL AND physically_deleted_at IS NULL)<>4 THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  SELECT * INTO image_evidence FROM public.outbox_jobs WHERE event_id=p_event_id AND post_id=p_post_id AND kind='process_media'
    AND image_owner_id=owner_id AND image_completed_at IS NOT NULL AND image_receipt->'originalSha256'=to_jsonb(a.sha256)
    AND payload->'asset_id'=to_jsonb(a.id) AND payload->'object_etag'=to_jsonb(a.object_etag) AND payload->'object_version'=to_jsonb(a.object_version)
    ORDER BY image_completed_at DESC,id DESC LIMIT 1;
  IF NOT FOUND OR jsonb_typeof(image_evidence.image_receipt->'deliveries') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  IF jsonb_array_length(image_evidence.image_receipt->'deliveries')<>4
    OR (SELECT count(DISTINCT x->>'assetId') FROM jsonb_array_elements(image_evidence.image_receipt->'deliveries') x)<>4
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(image_evidence.image_receipt->'deliveries') x
    LEFT JOIN public.media_assets ma ON ma.event_id=p_event_id AND ma.post_id=p_post_id AND to_jsonb(ma.id)=x->'assetId'
    WHERE ma.id IS NULL OR to_jsonb(ma.sha256) IS DISTINCT FROM x->'sha256' OR to_jsonb(ma.byte_size) IS DISTINCT FROM x->'size'
    OR to_jsonb(ma.pixel_width) IS DISTINCT FROM x->'width' OR to_jsonb(ma.pixel_height) IS DISTINCT FROM x->'height') THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  media:=jsonb_build_object('kind','photo','source','original_read_only','imageReceipt',image_evidence.image_receipt);
 ELSE
  frame_count:=3; media:=j.moderation_media;
  -- Explicit admin retry creates a new job but never a new original. Recover only
  -- previously completed or durably held, same-owner/original evidence; revalidate locked Stream assets below.
  IF media IS NULL THEN
   SELECT jsonb_set(prior.moderation_media,'{postVersion}',to_jsonb(p.version)) INTO media FROM public.outbox_jobs prior
    WHERE prior.event_id=p_event_id AND prior.post_id=p_post_id AND prior.kind='process_media' AND prior.id<>j.id
      AND prior.moderation_owner_id=owner_id AND prior.completed_at IS NOT NULL
      AND (prior.moderation_completed_at IS NOT NULL OR (prior.processing_failure_receipt->>'stage'='ai_preprocessing'
        AND prior.processing_failure_receipt->'heldVersion'=to_jsonb(p.version-1)))
      AND prior.moderation_media->>'kind'='video'
      AND prior.payload->'asset_id'=to_jsonb(a.id) AND prior.payload->'object_etag'=to_jsonb(a.object_etag) AND prior.payload->'object_version'=to_jsonb(a.object_version)
    ORDER BY prior.moderation_completed_at DESC,prior.id DESC LIMIT 1;
  END IF;
  IF jsonb_typeof(media) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  IF NOT(media ?& ARRAY['kind','postVersion','streamAssetId','measuredDurationSeconds','frameTimes','requireSignedURLs','readyToStream','processingComplete'])
    OR media-ARRAY['kind','postVersion','streamAssetId','measuredDurationSeconds','frameTimes','requireSignedURLs','readyToStream','processingComplete']<>'{}'::jsonb
    OR media->>'kind'<>'video' OR media->'postVersion' IS DISTINCT FROM to_jsonb(p.version)
    OR media->'requireSignedURLs'<>'true'::jsonb OR media->'readyToStream'<>'true'::jsonb OR media->'processingComplete'<>'true'::jsonb
    OR jsonb_typeof(media->'measuredDurationSeconds') IS DISTINCT FROM 'number' OR p.measured_duration_seconds IS NULL
    OR p.measured_duration_seconds NOT BETWEEN 0.000001 AND 4 OR media->'measuredDurationSeconds' IS DISTINCT FROM to_jsonb(p.measured_duration_seconds)
    OR jsonb_typeof(media->'frameTimes') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  IF jsonb_array_length(media->'frameTimes')<>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(media->'frameTimes') x WHERE jsonb_typeof(x)<>'number') THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  IF NOT(0<(media->'frameTimes'->>0)::numeric AND (media->'frameTimes'->>0)::numeric<(media->'frameTimes'->>1)::numeric
    AND (media->'frameTimes'->>1)::numeric<(media->'frameTimes'->>2)::numeric AND (media->'frameTimes'->>2)::numeric<p.measured_duration_seconds) THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  SELECT * INTO stream_asset FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND provider='stream'
    AND purpose=CASE WHEN p.original_scope='full_video_fallback' THEN 'stream_clip' ELSE 'stream_source' END;
  IF NOT FOUND OR media->'streamAssetId' IS DISTINCT FROM to_jsonb(stream_asset.id) OR stream_asset.deletion_requested_at IS NOT NULL OR stream_asset.physically_deleted_at IS NOT NULL
    OR NOT stream_asset.stream_ready_to_stream OR NOT stream_asset.stream_require_signed_urls OR NOT stream_asset.stream_processing_complete
    OR stream_asset.stream_duration_seconds IS DISTINCT FROM p.measured_duration_seconds OR stream_asset.stream_uid !~ '^[a-f0-9]{32}$'
    OR (p.original_scope<>'full_video_fallback' AND stream_asset.stream_source_uid IS NOT NULL)
    OR (p.original_scope='full_video_fallback' AND (stream_asset.stream_source_uid IS NULL OR NOT EXISTS(SELECT 1 FROM public.media_assets source
      WHERE source.event_id=p_event_id AND source.post_id=p_post_id AND source.purpose='stream_source' AND source.provider='stream'
      AND source.stream_uid=stream_asset.stream_source_uid AND source.stream_uid<>stream_asset.stream_uid
      AND source.deletion_requested_at IS NULL AND source.physically_deleted_at IS NULL))) THEN RETURN jsonb_build_object('code','MEDIA_NOT_READY'); END IF;
  -- Private identifiers come from locked assets, never from the prepared evidence or HTTP body.
  media:=media||jsonb_build_object('streamUid',stream_asset.stream_uid,'sourceUid',stream_asset.stream_source_uid);
 END IF;
 IF NOT s.thresholds_approved OR s.settings_version>2147483647 OR NOT koko_private.valid_moderation_thresholds(s.moderation_thresholds) THEN RETURN jsonb_build_object('code','POLICY_UNAPPROVED'); END IF;
 policy:=jsonb_build_object('approved',true,'version',s.settings_version,'safeSearchScoreVersion','likelihood-ordinal-v1','openaiModel','omni-moderation-2024-09-26','thresholds',s.moderation_thresholds);
 IF p_action='claim' THEN
  IF j.moderation_plan IS NOT NULL AND (j.moderation_plan->>'expiresAt')::numeric>extract(epoch FROM stamp)*1000 THEN RETURN jsonb_build_object('code','BUSY'); END IF;
  IF j.moderation_processing_attempt>=3 THEN
   RETURN koko_private.hold_processing_failure(p_event_id,p_post_id,p_job_id,p.version,'ai_preprocessing','RETRY_EXHAUSTED');
  END IF;
  IF (SELECT count(*) FROM public.outbox_jobs WHERE event_id=p_event_id AND moderation_completed_at IS NULL AND completed_at IS NULL
    AND moderation_plan IS NOT NULL AND (moderation_plan->>'expiresAt')::numeric>extract(epoch FROM stamp)*1000)>=s.moderation_concurrency THEN RETURN jsonb_build_object('code','BUSY'); END IF;
  SELECT jsonb_agg(jsonb_build_object('engine',eng,'frame',f,'nextAttempt',coalesce((SELECT max(attempt)+1 FROM koko_private.moderation_calls c WHERE c.event_id=p_event_id AND c.job_id=p_job_id AND c.engine=eng AND c.frame_index=f),1)) ORDER BY f,eng)
    INTO starts FROM unnest(ARRAY['openai','safesearch','ocr']) eng CROSS JOIN generate_series(0,frame_count-1) f;
  expires_ms:=least(floor(extract(epoch FROM stamp)*1000)::bigint+120000,floor(extract(epoch FROM e.private_at)*1000)::bigint);
  plan:=jsonb_build_object('jobId',j.id,'postVersion',p.version,'leaseId',gen_random_uuid(),'expiresAt',expires_ms,'policy',policy,'attemptStarts',starts,'media',media,
    'original',original_ref);
  UPDATE public.outbox_jobs SET moderation_plan=plan,moderation_owner_id=owner_id,moderation_processing_attempt=moderation_processing_attempt+1,
    moderation_media=CASE WHEN p.kind='video' THEN media-ARRAY['streamUid','sourceUid'] ELSE moderation_media END WHERE id=j.id;
  RETURN jsonb_build_object('code','CLAIMED','plan',plan);
 END IF;
 plan:=j.moderation_plan;
 IF plan IS NULL OR p_input->'plan' IS DISTINCT FROM plan OR j.moderation_owner_id IS DISTINCT FROM owner_id
   OR plan->'postVersion' IS DISTINCT FROM to_jsonb(p.version) OR plan->'policy' IS DISTINCT FROM policy OR plan->'media' IS DISTINCT FROM media
   OR plan->'original' IS DISTINCT FROM original_ref
   OR (plan->>'expiresAt')::numeric<=extract(epoch FROM stamp)*1000 THEN RETURN jsonb_build_object('code','STALE'); END IF;
 IF p_action='check' THEN RETURN jsonb_build_object('code','CURRENT'); END IF;
 IF p_action='fail' THEN
  RETURN koko_private.hold_processing_failure(p_event_id,p_post_id,p_job_id,p.version,'ai_preprocessing',p_input->>'reason');
 END IF;
 IF p_action='reserve' THEN
  engine_name:=p_input->>'engine'; provider_name:=p_input->>'provider';
  IF jsonb_typeof(p_input->'engine') IS DISTINCT FROM 'string' OR engine_name NOT IN ('openai','safesearch','ocr')
    OR jsonb_typeof(p_input->'provider') IS DISTINCT FROM 'string' OR provider_name NOT IN ('openai','vision')
    OR (engine_name='openai' AND provider_name<>'openai') OR (engine_name='safesearch' AND provider_name<>'vision')
    OR jsonb_typeof(p_input->'frame') IS DISTINCT FROM 'number' OR jsonb_typeof(p_input->'attempt') IS DISTINCT FROM 'number' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF (p_input->>'frame')::numeric NOT BETWEEN 0 AND frame_count-1 OR (p_input->>'frame')::numeric<>trunc((p_input->>'frame')::numeric)
    OR (p_input->>'attempt')::numeric NOT BETWEEN 1 AND 3 OR (p_input->>'attempt')::numeric<>trunc((p_input->>'attempt')::numeric) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  frame_number:=(p_input->>'frame')::integer; attempt_number:=(p_input->>'attempt')::integer;
  SELECT (x->>'nextAttempt')::integer INTO start_attempt FROM jsonb_array_elements(plan->'attemptStarts') x WHERE x->>'engine'=engine_name AND (x->>'frame')::integer=frame_number;
  IF attempt_number<start_attempt THEN RETURN jsonb_build_object('code','RESERVED_ALREADY','allowed',false); END IF;
  IF EXISTS(SELECT 1 FROM koko_private.moderation_calls WHERE event_id=p_event_id AND job_id=p_job_id AND engine=engine_name AND frame_index=frame_number AND attempt=attempt_number AND provider=provider_name) THEN RETURN jsonb_build_object('code','RESERVED_ALREADY','allowed',false); END IF;
  IF engine_name='ocr' AND provider_name='openai' AND NOT EXISTS(SELECT 1 FROM koko_private.moderation_calls WHERE event_id=p_event_id AND job_id=p_job_id AND engine='ocr' AND frame_index=frame_number AND attempt=attempt_number AND provider='vision') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  SELECT * INTO budget FROM koko_private.moderation_budgets WHERE provider=provider_name FOR UPDATE;
  IF NOT FOUND OR NOT budget.approved OR budget.calls_per_minute IS NULL THEN RETURN jsonb_build_object('code','QUOTA_UNCONFIGURED','allowed',false); END IF;
  stamp:=clock_timestamp();
  IF budget.window_start IS DISTINCT FROM date_trunc('minute',stamp) THEN budget.used:=0; budget.window_start:=date_trunc('minute',stamp); END IF;
  IF budget.used>=budget.calls_per_minute THEN RETURN jsonb_build_object('code','QUOTA','allowed',false,'retryAfterSeconds',greatest(1,ceil(extract(epoch FROM budget.window_start+interval '1 minute'-stamp)))); END IF;
  INSERT INTO koko_private.moderation_calls(event_id,job_id,engine,frame_index,attempt,provider) VALUES(p_event_id,p_job_id,engine_name,frame_number,attempt_number,provider_name);
  UPDATE koko_private.moderation_budgets SET used=budget.used+1,window_start=budget.window_start WHERE provider=provider_name;
  RETURN jsonb_build_object('code','RESERVED','allowed',true);
 END IF;
 -- The result is normalized again below; caller verdicts never directly authorize publication.
 result:=p_input->'result';
 IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 IF NOT(result ?& ARRAY['decision','policyVersion','engines','runs','categories','immediateBan'])
   OR result-ARRAY['decision','policyVersion','engines','runs','categories','immediateBan','errorCode']<>'{}'::jsonb
   OR result->'policyVersion' IS DISTINCT FROM to_jsonb(s.settings_version)
   OR result->>'decision' NOT IN ('PASS','FLAG','BLOCK','HELD') OR jsonb_typeof(result->'immediateBan') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(result->'runs') IS DISTINCT FROM 'array' OR jsonb_typeof(result->'engines') IS DISTINCT FROM 'array' OR jsonb_typeof(result->'categories') IS DISTINCT FROM 'array'
   OR (result ? 'errorCode' AND (jsonb_typeof(result->'errorCode') IS DISTINCT FROM 'string' OR result->>'errorCode' NOT IN ('INVALID_MEDIA','BUSY','ABORTED','TIMEOUT','QUOTA','CREDENTIALS','PROVIDER_REJECTED','PROVIDER_UNAVAILABLE','INVALID_RESPONSE','RESOURCE_LIMIT'))) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 runs:=result->'runs';
 IF jsonb_array_length(runs)>27 OR (SELECT count(DISTINCT(x->>'engine',x->>'frame',x->>'attempt')) FROM jsonb_array_elements(runs) x)<>jsonb_array_length(runs) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(runs) LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF NOT(r ?& ARRAY['engine','frame','attempt','decision','modelVersion','scores','latencyMs','usage','estimatedCostUsd','observation'])
    OR r-ARRAY['engine','frame','attempt','decision','modelVersion','scores','latencyMs','usage','estimatedCostUsd','observation','errorCode','retryAfterSeconds']<>'{}'::jsonb
    OR r->>'engine' NOT IN ('openai','safesearch','ocr') OR jsonb_typeof(r->'engine') IS DISTINCT FROM 'string'
    OR jsonb_typeof(r->'frame') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'attempt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(r->'scores') IS DISTINCT FROM 'object' OR jsonb_typeof(r->'latencyMs') IS DISTINCT FROM 'number'
    OR r->'estimatedCostUsd'<>'null'::jsonb OR jsonb_typeof(r->'usage') IS DISTINCT FROM 'object'
    OR jsonb_typeof(r->'observation') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'decision') IS DISTINCT FROM 'string'
    OR r->>'observation' NOT IN ('scores','no_text','error') OR r->>'decision' NOT IN ('PASS','FLAG','BLOCK','ERROR') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  engine_name:=r->>'engine';
  IF (r->>'frame')::numeric NOT BETWEEN 0 AND frame_count-1 OR (r->>'frame')::numeric<>trunc((r->>'frame')::numeric)
    OR (r->>'attempt')::numeric NOT BETWEEN 1 AND 3 OR (r->>'attempt')::numeric<>trunc((r->>'attempt')::numeric)
    OR (r->>'latencyMs')::numeric NOT BETWEEN 0 AND 120000 OR (r->>'latencyMs')::numeric<>trunc((r->>'latencyMs')::numeric) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  frame_number:=(r->>'frame')::integer; attempt_number:=(r->>'attempt')::integer;
  SELECT (x->>'nextAttempt')::integer INTO start_attempt FROM jsonb_array_elements(plan->'attemptStarts') x WHERE x->>'engine'=engine_name AND (x->>'frame')::integer=frame_number;
  IF attempt_number<start_attempt THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF r->>'modelVersion' IS DISTINCT FROM (CASE engine_name WHEN 'openai' THEN 'omni-moderation-2024-09-26' WHEN 'safesearch' THEN 'vision-v1/builtin-stable/unreported/likelihood-ordinal-v1' ELSE 'vision-v1/builtin-stable/unreported+omni-moderation-2024-09-26' END) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  usage_value:=r->'usage';
  IF NOT(usage_value ?& ARRAY['openaiRequests','safeSearchImages','ocrImages']) OR usage_value-ARRAY['openaiRequests','safeSearchImages','ocrImages']<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM jsonb_each(usage_value) x WHERE jsonb_typeof(value)<>'number') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each_text(usage_value) x WHERE value::numeric NOT IN (0,1))
    OR (engine_name<>'ocr' AND (usage_value->>'ocrImages')::integer<>0)
    OR (engine_name<>'safesearch' AND (usage_value->>'safeSearchImages')::integer<>0)
    OR (engine_name='safesearch' AND (usage_value->>'openaiRequests')::integer<>0) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF ((usage_value->>'openaiRequests')::integer=1 AND NOT EXISTS(SELECT 1 FROM koko_private.moderation_calls WHERE event_id=p_event_id AND job_id=p_job_id AND engine=engine_name AND frame_index=frame_number AND attempt=attempt_number AND provider='openai'))
    OR (((usage_value->>'safeSearchImages')::integer=1 OR (usage_value->>'ocrImages')::integer=1) AND NOT EXISTS(SELECT 1 FROM koko_private.moderation_calls WHERE event_id=p_event_id AND job_id=p_job_id AND engine=engine_name AND frame_index=frame_number AND attempt=attempt_number AND provider='vision')) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  scores:=r->'scores'; run_decision:='PASS';
  IF r->>'observation'='error' THEN
   IF r->>'decision'<>'ERROR' OR scores<>'{}'::jsonb OR jsonb_typeof(r->'errorCode') IS DISTINCT FROM 'string' OR r->>'errorCode' NOT IN ('INVALID_MEDIA','BUSY','ABORTED','TIMEOUT','QUOTA','CREDENTIALS','PROVIDER_REJECTED','PROVIDER_UNAVAILABLE','INVALID_RESPONSE','RESOURCE_LIMIT') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
   run_decision:='ERROR';
  ELSE
   IF r ? 'errorCode' OR r ? 'retryAfterSeconds' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
   IF r->>'observation'='no_text' THEN
    IF engine_name<>'ocr' OR scores<>'{}'::jsonb OR usage_value<>jsonb_build_object('openaiRequests',0,'safeSearchImages',0,'ocrImages',1) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
   ELSE
    IF NOT(scores ?& koko_private.moderation_categories(engine_name)) OR scores-koko_private.moderation_categories(engine_name)<>'{}'::jsonb
      OR EXISTS(SELECT 1 FROM jsonb_each(scores) x WHERE jsonb_typeof(value)<>'number') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each_text(scores) x WHERE value::numeric NOT BETWEEN 0 AND 1) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF usage_value IS DISTINCT FROM (CASE engine_name WHEN 'openai' THEN jsonb_build_object('openaiRequests',1,'safeSearchImages',0,'ocrImages',0)
       WHEN 'safesearch' THEN jsonb_build_object('openaiRequests',0,'safeSearchImages',1,'ocrImages',0) ELSE jsonb_build_object('openaiRequests',1,'safeSearchImages',0,'ocrImages',1) END) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(s.moderation_thresholds) WHERE value->>'engine'=engine_name LOOP
     score:=(scores->>(t->>'category'))::numeric;
     IF score>=(t->>'block')::numeric THEN run_decision:='BLOCK';
     ELSIF score>=(t->>'flag')::numeric AND run_decision<>'BLOCK' THEN run_decision:='FLAG'; END IF;
    END LOOP;
   END IF;
   IF r->>'decision' IS DISTINCT FROM run_decision THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  END IF;
  IF r ? 'retryAfterSeconds' AND (jsonb_typeof(r->'retryAfterSeconds') IS DISTINCT FROM 'number' OR (r->>'retryAfterSeconds')::numeric NOT BETWEEN 1 AND 3600 OR (r->>'retryAfterSeconds')::numeric<>trunc((r->>'retryAfterSeconds')::numeric)) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 END LOOP;
 -- Per engine/frame attempts must be contiguous from the durable next attempt, with only retryable preceding errors.
 FOREACH engine_name IN ARRAY ARRAY['openai','safesearch','ocr'] LOOP
  engine_decision:='PASS';
  FOR frame_number IN 0..frame_count-1 LOOP
   SELECT (x->>'nextAttempt')::integer INTO start_attempt FROM jsonb_array_elements(plan->'attemptStarts') x WHERE x->>'engine'=engine_name AND (x->>'frame')::integer=frame_number;
   last_attempt:=start_attempt-1;
   FOR r IN SELECT value FROM jsonb_array_elements(runs) WHERE value->>'engine'=engine_name AND (value->>'frame')::integer=frame_number ORDER BY (value->>'attempt')::integer LOOP
    IF (r->>'attempt')::integer<>last_attempt+1 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF last_attempt>=start_attempt AND (observed_code IS NULL OR observed_code NOT IN ('TIMEOUT','PROVIDER_UNAVAILABLE')) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    last_attempt:=(r->>'attempt')::integer; observed_code:=CASE WHEN r->>'decision'='ERROR' THEN r->>'errorCode' ELSE NULL END;
    IF r->>'decision'='BLOCK' THEN engine_decision:='BLOCK';
    ELSIF r->>'decision'='FLAG' AND engine_decision='PASS' THEN engine_decision:='FLAG'; END IF;
   END LOOP;
   IF last_attempt<start_attempt OR r->>'decision'='ERROR' THEN
    IF engine_decision<>'BLOCK' THEN engine_decision:='ERROR'; END IF;
   ELSE
    FOR t IN SELECT value FROM jsonb_array_elements(s.moderation_thresholds) WHERE value->>'engine'=engine_name LOOP
     score:=(r->'scores'->>(t->>'category'))::numeric;
     IF score>=(t->>'flag')::numeric THEN
      run_decision:=CASE WHEN score>=(t->>'block')::numeric THEN 'BLOCK' ELSE 'FLAG' END;
      IF run_decision='BLOCK' THEN severe:=severe OR (t->>'immediate_ban')::boolean; IF chosen_category IS NULL THEN chosen_category:=engine_name||':'||(t->>'category'); END IF; END IF;
      categories:=categories||jsonb_build_array(jsonb_build_object('engine',engine_name,'category',t->>'category','decision',run_decision));
     END IF;
    END LOOP;
   END IF;
  END LOOP;
  IF result->>'errorCode'='ABORTED' AND engine_decision<>'BLOCK' THEN engine_decision:='ERROR'; END IF;
  engines:=engines||jsonb_build_array(jsonb_build_object('engine',engine_name,'decision',engine_decision));
  has_block:=has_block OR engine_decision='BLOCK'; has_error:=has_error OR engine_decision='ERROR'; has_flag:=has_flag OR engine_decision='FLAG';
 END LOOP;
 -- Collapse duplicate frame categories; BLOCK wins within the same engine/category.
 SELECT coalesce(jsonb_agg(jsonb_build_object('engine',engine,'category',category,'decision',decision) ORDER BY engine,category),'[]'::jsonb) INTO categories
 FROM (SELECT x->>'engine' engine,x->>'category' category,CASE WHEN bool_or(x->>'decision'='BLOCK') THEN 'BLOCK' ELSE 'FLAG' END decision FROM jsonb_array_elements(categories) x GROUP BY x->>'engine',x->>'category') grouped;
 IF result->>'errorCode'='ABORTED' THEN has_error:=true; END IF;
 verdict:=CASE WHEN has_block THEN 'BLOCK' WHEN has_error THEN 'HELD' WHEN has_flag THEN 'FLAG' ELSE 'PASS' END;
 IF result->>'decision' IS DISTINCT FROM verdict OR result->'immediateBan' IS DISTINCT FROM to_jsonb(severe)
   OR NOT((result->'engines') @> engines AND engines @> (result->'engines') AND jsonb_array_length(result->'engines')=3)
   OR NOT((result->'categories') @> categories AND categories @> (result->'categories') AND jsonb_array_length(result->'categories')=jsonb_array_length(categories)) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(runs) LOOP
  INSERT INTO public.moderation_runs(event_id,post_id,job_id,frame_index,attempt,engine,post_version,policy_version,model_version,decision,scores,latency_ms,estimated_cost_usd,error_code,observation,usage)
  VALUES(p_event_id,p_post_id,p_job_id,(r->>'frame')::integer,(r->>'attempt')::integer,r->>'engine',p.version,s.settings_version,r->>'modelVersion',r->>'decision',r->'scores',(r->>'latencyMs')::integer,NULL,r->>'errorCode',r->>'observation',r->'usage');
 END LOOP;
 stamp:=clock_timestamp();
 IF (plan->>'expiresAt')::numeric<=extract(epoch FROM stamp)*1000 OR stamp>=e.private_at THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Moderation lease expired while committing'; END IF;
 UPDATE public.posts SET status=(CASE verdict WHEN 'PASS' THEN 'published' WHEN 'FLAG' THEN 'published_flagged' WHEN 'BLOCK' THEN 'blocked' ELSE 'held' END)::public.post_status,
   moderation_verdict=verdict,block_category=CASE WHEN verdict='BLOCK' THEN chosen_category ELSE NULL END,
   processing_error=CASE WHEN verdict='HELD' THEN 'MODERATION_ERROR' ELSE NULL END,
   published_at=CASE WHEN verdict IN ('PASS','FLAG') THEN coalesce(published_at,stamp) ELSE published_at END,
   previous_public_status=NULL,hidden_reason=NULL,version=version+1,updated_at=stamp,
   moderation_block_counted=moderation_block_counted OR verdict='BLOCK' WHERE id=p.id RETURNING version INTO result_version;
 IF verdict='BLOCK' AND NOT p.moderation_block_counted THEN
  UPDATE public.event_members SET block_count=block_count+1 WHERE event_id=p_event_id AND user_id=owner_id RETURNING * INTO m;
 END IF;
 IF verdict='BLOCK' AND (severe OR m.block_count>=3) THEN
  UPDATE public.event_members SET is_banned=true,banned_at=coalesce(banned_at,stamp) WHERE event_id=p_event_id AND user_id=owner_id;
  FOR saved_post IN SELECT * FROM public.posts WHERE event_id=p_event_id AND user_id=owner_id AND status<>'deleted' AND NOT ban_latched ORDER BY id FOR UPDATE LOOP
   UPDATE public.posts SET ban_latched=true,previous_public_status=CASE WHEN status IN ('published','published_flagged') THEN status ELSE previous_public_status END,
    hidden_reason=CASE WHEN status IN ('published','published_flagged','hidden') THEN 'ban' ELSE hidden_reason END,
    status=CASE WHEN status IN ('published','published_flagged') THEN 'hidden'::public.post_status ELSE status END,version=version+1,updated_at=stamp WHERE id=saved_post.id;
   INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,saved_post.id,'revoke_delivery','ai-ban:'||p_job_id||':'||saved_post.id,jsonb_build_object('post_version',saved_post.version+1));
  END LOOP;
  INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'notify','ai-ban-notify:'||p_job_id,jsonb_build_object('category','ban','user_id',owner_id));
 END IF;
 -- Auto-BAN also versions the current blocked post; notify against its final committed generation.
 SELECT version INTO result_version FROM public.posts WHERE id=p.id;
 UPDATE public.event_members SET published_post_count=(SELECT count(*) FROM public.posts WHERE event_id=p_event_id AND user_id=owner_id AND status IN ('published','published_flagged')) WHERE event_id=p_event_id AND user_id=owner_id;
 IF verdict<>'PASS' THEN
  INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'notify','moderation:'||p_job_id,jsonb_build_object('category',CASE verdict WHEN 'FLAG' THEN 'flag' WHEN 'BLOCK' THEN 'block' ELSE 'ai_error' END,'post_version',result_version));
 END IF;
 -- Retention days have not been approved: BLOCK/HELD still commit, but never guess or enqueue physical deletion.
 UPDATE public.outbox_jobs SET moderation_completed_at=stamp,moderation_receipt=result,completed_at=stamp,locked_until=NULL WHERE id=j.id;
 RETURN jsonb_build_object('code','RECORDED');
END;
$$;
REVOKE ALL ON FUNCTION public.manage_media_moderation(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_media_moderation(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.manage_media_moderation(uuid,uuid,uuid,text,jsonb) IS 'Service-only claim/check/reserve/finish. Snapshot approved policy, consume shared provider quota and finite job slots, verify normalized run evidence, atomically publish/BLOCK/HELD/BAN. No external IO or deletion scheduling.';
NOTIFY pgrst,'reload schema';
COMMIT;
