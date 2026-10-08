-- Queue hints do not authorize provider work or ACK. Re-read durable generation evidence.
BEGIN;
CREATE FUNCTION public.media_processing_status(p_event_id uuid,p_post_id uuid,p_job_id uuid,p_asset_id uuid,p_post_version bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE e public.events%ROWTYPE; s public.event_settings%ROWTYPE; m public.event_members%ROWTYPE;
 p public.posts%ROWTYPE; j public.outbox_jobs%ROWTYPE; a public.media_assets%ROWTYPE; owner_id uuid; observed_at timestamptz;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='media_processing_status requires READ COMMITTED'; END IF;
 IF p_event_id IS NULL OR p_post_id IS NULL OR p_job_id IS NULL OR p_asset_id IS NULL OR p_post_version IS NULL OR p_post_version NOT BETWEEN 1 AND 2147483647 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
 SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','DEFERRED'); END IF;
 SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_post_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
 SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=owner_id FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('code','DEFERRED'); END IF;
 -- Consistent event -> owner -> post -> assets -> job ordering with both processors.
 PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id FOR SHARE;
 SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_post_id FOR SHARE;
 IF NOT FOUND OR p.user_id<>owner_id THEN RETURN jsonb_build_object('code','DEFERRED'); END IF;
 PERFORM 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id ORDER BY id FOR SHARE;
 SELECT * INTO j FROM public.outbox_jobs WHERE event_id=p_event_id AND post_id=p_post_id AND id=p_job_id FOR SHARE;
 IF NOT FOUND OR j.kind<>'process_media' THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
 IF j.payload->'asset_id' IS DISTINCT FROM to_jsonb(p_asset_id) OR (j.payload->'post_version' IS DISTINCT FROM to_jsonb(p_post_version) AND j.stream_initial_post_version IS DISTINCT FROM p_post_version) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
 SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND id=p_asset_id AND purpose='original';
 IF NOT FOUND OR a.object_etag IS NULL OR a.object_version IS NULL OR j.payload->'object_etag' IS DISTINCT FROM to_jsonb(a.object_etag) OR j.payload->'object_version' IS DISTINCT FROM to_jsonb(a.object_version) THEN RETURN jsonb_build_object('code','DEFERRED'); END IF;
 IF j.moderation_completed_at IS NOT NULL AND j.completed_at IS NOT NULL AND j.moderation_receipt->>'decision' IN ('PASS','FLAG','BLOCK','HELD') THEN RETURN jsonb_build_object('code','TERMINAL'); END IF;
 IF p.status='deleted' AND p.deleted_at IS NOT NULL AND p.version>p_post_version THEN RETURN jsonb_build_object('code','TERMINAL'); END IF;
 IF j.completed_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.outbox_jobs newer WHERE newer.event_id=p_event_id AND newer.post_id=p_post_id AND newer.kind='process_media' AND newer.id<>j.id AND jsonb_typeof(newer.payload->'post_version')='number' AND (newer.payload->>'post_version')::numeric>p_post_version) THEN RETURN jsonb_build_object('code','SUPERSEDED'); END IF;
 IF p.status='held' AND p.version>p_post_version AND (p.moderation_verdict='HELD' OR p.processing_error IS NOT NULL) THEN RETURN jsonb_build_object('code','HELD'); END IF;
 observed_at:=clock_timestamp();
 IF j.completed_at IS NOT NULL OR p.status NOT IN ('uploaded','processing') OR p.deleted_at IS NOT NULL OR p.ban_latched OR m.is_banned OR s.publication_stopped OR NOT s.uploads_enabled
   OR e.status<>'live' OR observed_at<e.starts_at OR observed_at>=e.private_at OR a.deletion_requested_at IS NOT NULL OR a.physically_deleted_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id AND terms_version=e.terms_version AND btrim(e.terms_version)<>'') THEN RETURN jsonb_build_object('code','DEFERRED'); END IF;
 -- Initial processing increments the uploaded generation exactly once. Admin retry uses its new generation directly.
 IF p.version<>p_post_version AND NOT(p.status='processing' AND p.version=p_post_version+1) THEN RETURN jsonb_build_object('code','DEFERRED'); END IF;
 RETURN jsonb_build_object('code','READY','kind',p.kind);
END;
$$;
REVOKE ALL ON FUNCTION public.media_processing_status(uuid,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.media_processing_status(uuid,uuid,uuid,uuid,bigint) TO service_role;
COMMENT ON FUNCTION public.media_processing_status(uuid,uuid,uuid,uuid,bigint) IS 'Service-only locked Queue status proof. No mutation or provider authorization from Queue hints. READY is rechecked by each processor; HTTP success alone is never an ACK proof.';
NOTIFY pgrst,'reload schema';
COMMIT;
