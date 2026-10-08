-- Webhooks are wake-up hints only. No provider state, moderation or publication is accepted here.
BEGIN;
ALTER TABLE public.event_settings ADD COLUMN stream_webhook_enabled boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.resolve_stream_webhook(
 p_event_id uuid,p_post_id uuid,p_asset_id uuid,p_provider_job_id uuid,p_provider_post_version bigint,
 p_operation_id uuid,p_stream_uid text,p_source_uid text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE e public.events%ROWTYPE; s public.event_settings%ROWTYPE; m public.event_members%ROWTYPE;
 p public.posts%ROWTYPE; a public.media_assets%ROWTYPE; origin public.outbox_jobs%ROWTYPE; current_job public.outbox_jobs%ROWTYPE;
 owner_id uuid; wanted text; entry jsonb; current_entry jsonb; matches integer; observed_at timestamptz;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='resolve_stream_webhook requires READ COMMITTED'; END IF;
 IF p_event_id IS NULL OR p_post_id IS NULL OR p_asset_id IS NULL OR p_provider_job_id IS NULL OR p_operation_id IS NULL
  OR p_provider_post_version IS NULL OR p_provider_post_version NOT BETWEEN 1 AND 2147483647
  OR p_stream_uid IS NULL OR p_stream_uid !~ '^[a-f0-9]{32}$'
  OR (p_source_uid IS NOT NULL AND (p_source_uid !~ '^[a-f0-9]{32}$' OR p_source_uid=p_stream_uid)) THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
 observed_at:=clock_timestamp();
 IF NOT FOUND OR NOT s.stream_webhook_enabled OR s.publication_stopped OR NOT s.uploads_enabled
  OR e.status<>'live' OR observed_at<e.starts_at OR observed_at>=e.private_at THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_post_id;
 SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=owner_id FOR SHARE;
 IF NOT FOUND OR m.is_banned THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id AND terms_version=e.terms_version AND btrim(e.terms_version)<>'' FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_post_id FOR SHARE;
 IF NOT FOUND OR p.user_id<>owner_id OR p.kind<>'video' OR p.status<>'processing' OR p.deleted_at IS NOT NULL OR p.ban_latched THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 PERFORM 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id ORDER BY id FOR SHARE;
 SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND id=p_asset_id AND purpose='original';
 IF NOT FOUND OR a.provider<>'r2_original' OR a.object_etag IS NULL OR a.object_version IS NULL OR a.byte_size IS DISTINCT FROM p.original_bytes
  OR a.deletion_requested_at IS NOT NULL OR a.physically_deleted_at IS NOT NULL THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 -- Same lock order as Stream/moderation. All job choices below refer only to this locked post.
 PERFORM 1 FROM public.outbox_jobs WHERE event_id=p_event_id AND post_id=p_post_id AND kind='process_media' ORDER BY id FOR SHARE;
 SELECT * INTO origin FROM public.outbox_jobs WHERE event_id=p_event_id AND post_id=p_post_id AND id=p_provider_job_id AND kind='process_media';
 IF NOT FOUND OR origin.payload->'asset_id' IS DISTINCT FROM to_jsonb(a.id)
  OR origin.payload->'object_etag' IS DISTINCT FROM to_jsonb(a.object_etag) OR origin.payload->'object_version' IS DISTINCT FROM to_jsonb(a.object_version)
  OR origin.payload->'post_version' IS DISTINCT FROM to_jsonb(p_provider_post_version) THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 wanted:=CASE WHEN p_source_uid IS NULL THEN 'source' ELSE 'clip' END;
 entry:=origin.stream_state->wanted;
 IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR entry->'operationId' IS DISTINCT FROM to_jsonb(p_operation_id)
  OR entry->'providerJobId' IS DISTINCT FROM to_jsonb(p_provider_job_id) OR entry->'providerPostVersion' IS DISTINCT FROM to_jsonb(p_provider_post_version)
  OR entry->'sourceUid' IS DISTINCT FROM coalesce(to_jsonb(p_source_uid),'null'::jsonb)
  OR (entry->'uid' IS DISTINCT FROM 'null'::jsonb AND entry->'uid' IS DISTINCT FROM to_jsonb(p_stream_uid))
  OR (wanted='clip' AND (p.original_scope<>'full_video_fallback' OR origin.stream_state->'source'->'uid' IS DISTINCT FROM to_jsonb(p_source_uid)))
  THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 -- A notification can arrive before observe(). A durable UID-null reservation is sufficient to
 -- wake reconciliation, never sufficient to save the supplied UID or mark the video ready.
 IF EXISTS(SELECT 1 FROM public.media_assets WHERE stream_uid=p_stream_uid
   AND (event_id<>p_event_id OR post_id<>p_post_id OR purpose<>'stream_'||wanted OR deletion_requested_at IS NOT NULL OR physically_deleted_at IS NOT NULL))
  OR (entry->'uid'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id
    AND purpose='stream_'||wanted AND stream_uid=p_stream_uid AND stream_source_uid IS NOT DISTINCT FROM p_source_uid
    AND deletion_requested_at IS NULL AND physically_deleted_at IS NULL)) THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 SELECT count(*) INTO matches FROM public.outbox_jobs j WHERE j.event_id=p_event_id AND j.post_id=p_post_id AND j.kind='process_media' AND j.completed_at IS NULL
  AND j.payload->'asset_id'=to_jsonb(a.id) AND j.payload->'object_etag'=to_jsonb(a.object_etag) AND j.payload->'object_version'=to_jsonb(a.object_version)
  AND j.payload->'post_version'=to_jsonb(p.version);
 IF matches<>1 THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 SELECT * INTO current_job FROM public.outbox_jobs j WHERE j.event_id=p_event_id AND j.post_id=p_post_id AND j.kind='process_media' AND j.completed_at IS NULL
  AND j.payload->'asset_id'=to_jsonb(a.id) AND j.payload->'object_etag'=to_jsonb(a.object_etag) AND j.payload->'object_version'=to_jsonb(a.object_version)
  AND j.payload->'post_version'=to_jsonb(p.version);
 IF current_job.moderation_completed_at IS NOT NULL THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 IF current_job.id<>origin.id THEN
  IF origin.completed_at IS NULL OR p.version<=p_provider_post_version THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
  current_entry:=current_job.stream_state->wanted;
  IF current_job.stream_state<>'{}'::jsonb AND (current_entry IS NULL OR current_entry->'operationId' IS DISTINCT FROM entry->'operationId'
   OR current_entry->'providerJobId' IS DISTINCT FROM entry->'providerJobId' OR current_entry->'providerPostVersion' IS DISTINCT FROM entry->'providerPostVersion'
   OR current_entry->'sourceUid' IS DISTINCT FROM entry->'sourceUid'
   OR (current_entry->'uid' IS DISTINCT FROM 'null'::jsonb AND current_entry->'uid' IS DISTINCT FROM to_jsonb(p_stream_uid))) THEN RETURN jsonb_build_object('code','IGNORED'); END IF;
 END IF;
 RETURN jsonb_build_object('code','READY','message',jsonb_build_object('version',1,'kind','process_media','event_id',p_event_id,'post_id',p_post_id,
  'asset_id',a.id,'job_id',current_job.id,'post_version',p.version));
END $$;
REVOKE ALL ON FUNCTION public.resolve_stream_webhook(uuid,uuid,uuid,uuid,bigint,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_stream_webhook(uuid,uuid,uuid,uuid,bigint,uuid,text,text) TO service_role;
COMMENT ON FUNCTION public.resolve_stream_webhook(uuid,uuid,uuid,uuid,bigint,uuid,text,text) IS 'Read-only service resolver: verified callback metadata only wakes an existing DB job. Duplicate delivery is expected. Consumer independently re-fetches provider state and rechecks current authorization before side effects.';
NOTIFY pgrst,'reload schema';
COMMIT;
