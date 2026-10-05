-- Owner-only status/history, appended after upload recovery.
-- No media, moderation raw text, writes or shared cache.
BEGIN;

-- Shared positive projection for owner status and authorized operator feeds.
-- Metadata is not proof of a provider lock configuration or completed physical deletion.
CREATE FUNCTION koko_private.post_state_details(p_event_id uuid,p_post_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT CASE WHEN p.status='blocked' THEN jsonb_build_object('block_category',CASE
      WHEN p.block_category IN ('openai:sexual','ocr:sexual','ocr:sexual/minors','safesearch:adult','safesearch:racy') THEN 'sexual'
      WHEN p.block_category IN ('openai:violence','openai:violence/graphic','ocr:violence','ocr:violence/graphic','safesearch:violence') THEN 'violence'
      WHEN p.block_category IN ('ocr:hate','ocr:hate/threatening') THEN 'hate'
      WHEN p.block_category IN ('ocr:harassment','ocr:harassment/threatening') THEN 'harassment'
      WHEN p.block_category IN ('openai:self-harm','openai:self-harm/intent','openai:self-harm/instructions','ocr:self-harm','ocr:self-harm/intent','ocr:self-harm/instructions') THEN 'self_harm'
      WHEN p.block_category IN ('ocr:illicit','ocr:illicit/violent') THEN 'illicit'
      ELSE 'other' END) ELSE '{}'::jsonb END
    || CASE WHEN p.status='deleted' THEN jsonb_build_object('deletion',jsonb_build_object(
      'state',CASE
        WHEN a.remaining=0 THEN 'DELETION_UNCONFIRMED'
        WHEN a.unknown_retention THEN 'RETENTION_UNKNOWN'
        WHEN a.retention_until>statement_timestamp() THEN 'RETENTION_PENDING'
        ELSE 'PHYSICAL_DELETION_NOT_ENABLED' END,
      'retention_until',CASE WHEN isfinite(a.retention_until) THEN to_char(a.retention_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE NULL END)) ELSE '{}'::jsonb END
  FROM public.posts p
  CROSS JOIN LATERAL (SELECT count(*) FILTER(WHERE physically_deleted_at IS NULL) remaining,
    coalesce(bool_or(provider='r2_original' AND (retention_until IS NULL OR NOT isfinite(retention_until))) FILTER(WHERE physically_deleted_at IS NULL),false) unknown_retention,
    max(retention_until) FILTER(WHERE physically_deleted_at IS NULL AND isfinite(retention_until)) retention_until
    FROM public.media_assets WHERE event_id=p.event_id AND post_id=p.id) a
  WHERE p.event_id=p_event_id AND p.id=p_post_id;
$$;
REVOKE ALL ON FUNCTION koko_private.post_state_details(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION koko_private.post_state_details(uuid,uuid) TO service_role;

CREATE FUNCTION public.read_own_posts(
  p_event_id uuid,
  p_user_id uuid,
  p_post_id uuid DEFAULT NULL,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  records jsonb;
BEGIN
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_limit IS NULL
     OR p_limit < 1 OR p_limit > 100
     OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
     OR (p_before_created_at IS NOT NULL AND NOT pg_catalog.isfinite(p_before_created_at))
     OR (p_post_id IS NOT NULL AND (p_before_id IS NOT NULL OR p_limit <> 1)) THEN
    RETURN jsonb_build_object('code', 'INVALID_INPUT');
  END IF;

  -- STABLE: membership and rows use the same calling statement snapshot.
  -- BAN/consent/publication gates restrict publishing, not reading one's status.
  IF NOT EXISTS (
    SELECT 1 FROM public.event_members m
    WHERE m.event_id = p_event_id AND m.user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('code', 'FORBIDDEN');
  END IF;

  SELECT coalesce(jsonb_agg(q.item ORDER BY q.created_at DESC, q.id DESC), '[]'::jsonb)
  INTO records
  FROM (
    SELECT p.created_at, p.id,
      jsonb_strip_nulls(jsonb_build_object(
        'id', p.id, 'event_id', p.event_id, 'status', p.status,
        'version', p.version,
        'created_at', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'error_code', CASE
          WHEN p.status = 'blocked' THEN 'CONTENT_BLOCKED'
          WHEN p.status IN ('held', 'upload_failed') THEN
            CASE WHEN p.processing_error IN (
              'UNSUPPORTED_MEDIA', 'VIDEO_TOO_LONG', 'PROVIDER_LIMIT',
              'UPLOAD_EXPIRED', 'UPLOAD_INCOMPLETE', 'INTERNAL_ERROR'
            ) THEN p.processing_error
            WHEN p.status = 'held' THEN 'PROCESSING_HELD'
            ELSE 'UPLOAD_INCOMPLETE' END
          ELSE NULL END
      )) || koko_private.post_state_details(p.event_id,p.id) AS item
    FROM public.posts p
    WHERE p.event_id = p_event_id AND p.user_id = p_user_id
      AND (p_post_id IS NULL OR p.id = p_post_id)
      AND (p_before_id IS NULL OR (p.created_at, p.id) < (p_before_created_at, p_before_id))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT p_limit + 1
  ) q;

  IF p_post_id IS NOT NULL AND jsonb_array_length(records) = 0 THEN
    RETURN jsonb_build_object('code', 'NOT_FOUND');
  END IF;
  RETURN jsonb_build_object(
    'code', 'ok',
    'items', (SELECT coalesce(jsonb_agg(a.item ORDER BY a.n), '[]'::jsonb)
      FROM jsonb_array_elements(records) WITH ORDINALITY AS a(item,n) WHERE a.n <= p_limit),
    'has_more', jsonb_array_length(records) > p_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.read_own_posts(uuid,uuid,uuid,timestamptz,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_own_posts(uuid,uuid,uuid,timestamptz,uuid,integer) TO service_role;
COMMENT ON FUNCTION public.read_own_posts(uuid,uuid,uuid,timestamptz,uuid,integer)
  IS 'Verified Worker identity only. Owner/event-scoped read-only status, never public feed authorization.';
NOTIFY pgrst, 'reload schema';
COMMIT;
