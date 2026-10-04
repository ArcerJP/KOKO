-- B1-6 background reconciliation. No provider calls, deployment or data deletion.
BEGIN;
ALTER TABLE public.upload_sessions ADD COLUMN recovery_after timestamptz;
CREATE INDEX upload_sessions_recovery_due ON public.upload_sessions
  (coalesce(recovery_after,created_at),id)
  WHERE completed_at IS NULL AND provisioning_state='ready';

-- Only a trusted background Worker may call this. Never accept user/parts from
-- an R2 message: derive them from the existing authenticated reservation.
CREATE FUNCTION public.recover_upload(
  p_event_id uuid, p_post_id uuid, p_asset_id uuid, p_action text, p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=''
AS $$
DECLARE
  owner_id uuid;
  session_row public.upload_sessions%ROWTYPE;
  manifest jsonb;
BEGIN
  IF p_event_id IS NULL OR p_post_id IS NULL OR p_asset_id IS NULL
    OR p_action IS NULL OR p_action NOT IN ('prepare','commit')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF (p_action='prepare' AND p_input<>'{}'::jsonb)
    OR (p_action='commit' AND (NOT (p_input ?& ARRAY['observation','post_version'])
      OR p_input-ARRAY['observation','post_version']<>'{}'::jsonb)) THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  -- Unlocked discovery only. complete_upload rechecks ownership, manifest, guards
  -- and mutable state under the canonical lock order in the SAME transaction.
  SELECT s.* INTO session_row
    FROM public.upload_sessions s
    JOIN public.posts p ON p.event_id=s.event_id AND p.id=s.post_id
    JOIN public.media_assets a ON a.event_id=s.event_id AND a.id=s.asset_id AND a.post_id=s.post_id
    WHERE s.event_id=p_event_id AND s.post_id=p_post_id AND s.asset_id=p_asset_id
      AND a.purpose='original' AND a.provider='r2_original'
      AND a.object_key='events/'||p_event_id::text||'/posts/'||p_post_id::text||'/original/'||p_asset_id::text||'.bin';
  IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_post_id;
  IF session_row.provisioning_state<>'ready' THEN RETURN jsonb_build_object('code','UPLOAD_INCOMPLETE'); END IF;
  manifest := CASE WHEN session_row.mode='single' THEN '[]'::jsonb ELSE session_row.completion_parts END;
  -- Background never invents a multipart manifest or assembles an upload.
  IF manifest IS NULL THEN RETURN jsonb_build_object('code','UPLOAD_INCOMPLETE'); END IF;
  RETURN public.complete_upload(p_event_id,owner_id,p_post_id,session_row.id,p_action,
    p_input || jsonb_build_object('parts',manifest));
END;
$$;

-- A bounded, rotating scan. A lost response delays a candidate for five minutes,
-- never marks it completed. Claim locks only session rows and does not take post
-- locks afterwards, so it cannot invert complete_upload's post -> session order.
CREATE FUNCTION public.claim_upload_recovery(p_limit integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='claim_upload_recovery requires READ COMMITTED';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT s.id FROM public.upload_sessions s
    JOIN public.posts p ON p.event_id=s.event_id AND p.id=s.post_id
    JOIN public.media_assets a ON a.event_id=s.event_id AND a.id=s.asset_id AND a.post_id=s.post_id
    WHERE s.completed_at IS NULL AND s.provisioning_state='ready'
      AND (s.mode='single' OR s.completion_parts IS NOT NULL)
      AND p.status='uploading' AND NOT p.ban_latched
      AND a.purpose='original' AND a.provider='r2_original'
      AND a.deletion_requested_at IS NULL AND a.physically_deleted_at IS NULL
      AND s.created_at<=statement_timestamp()-interval '5 minutes'
      AND (s.recovery_after IS NULL OR s.recovery_after<=statement_timestamp())
    ORDER BY coalesce(s.recovery_after,s.created_at),s.id
    LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
  ), claimed AS (
    UPDATE public.upload_sessions s SET recovery_after=statement_timestamp()+interval '5 minutes'
    FROM candidates c WHERE s.id=c.id RETURNING s.event_id,s.post_id,s.asset_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('event_id',event_id,'post_id',post_id,'asset_id',asset_id)),'[]'::jsonb)
    INTO result FROM claimed;
  RETURN jsonb_build_object('code','candidates','items',result);
END;
$$;
REVOKE ALL ON FUNCTION public.recover_upload(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_upload_recovery(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recover_upload(uuid,uuid,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_upload_recovery(integer) TO service_role;
COMMENT ON FUNCTION public.recover_upload(uuid,uuid,uuid,text,jsonb) IS 'Trusted Queue/Cron Worker only; DB-derived owner and frozen parts; same complete_upload guards/deduplication. No browser RPC.';
NOTIFY pgrst,'reload schema';
COMMIT;
