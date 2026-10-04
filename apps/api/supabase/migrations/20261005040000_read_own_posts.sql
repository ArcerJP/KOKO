-- Owner-only status/history, appended after upload recovery.
-- No media, moderation raw text, writes or shared cache.
BEGIN;

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
      )) AS item
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
