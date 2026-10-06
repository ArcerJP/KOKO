-- Scope recovery claims to the same fixed event as dispatch and processing.
-- No provider calls or data deletion. Old unscoped callers fail closed.
BEGIN;
DROP FUNCTION public.claim_upload_recovery(integer);
CREATE FUNCTION public.claim_upload_recovery(p_event_id uuid, p_limit integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='claim_upload_recovery requires READ COMMITTED';
  END IF;
  IF p_event_id IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT s.id FROM public.upload_sessions s
    JOIN public.posts p ON p.event_id=s.event_id AND p.id=s.post_id
    JOIN public.media_assets a ON a.event_id=s.event_id AND a.id=s.asset_id AND a.post_id=s.post_id
    WHERE s.event_id=p_event_id AND s.completed_at IS NULL AND s.provisioning_state='ready'
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
    FROM candidates c WHERE s.id=c.id AND s.event_id=p_event_id
    RETURNING s.event_id,s.post_id,s.asset_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('event_id',event_id,'post_id',post_id,'asset_id',asset_id)),'[]'::jsonb)
    INTO result FROM claimed;
  RETURN jsonb_build_object('code','candidates','items',result);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_upload_recovery(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_upload_recovery(uuid,integer) TO service_role;
COMMENT ON FUNCTION public.claim_upload_recovery(uuid,integer) IS 'Fixed-event trusted recovery Worker only; bounded cooldown claims; no cross-event mutation or browser RPC.';
NOTIFY pgrst,'reload schema';
COMMIT;
