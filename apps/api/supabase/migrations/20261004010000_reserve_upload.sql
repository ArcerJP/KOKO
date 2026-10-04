-- B1-5: local implementation; apply only after a separate DB review/approval.
BEGIN;

-- Keep initial request identity separate from mutable post metadata and measured bytes.
-- Legacy rows remain NULL: their original request must not be guessed on retry.
ALTER TABLE public.posts ADD COLUMN upload_request jsonb
  CHECK (upload_request IS NULL OR jsonb_typeof(upload_request) = 'object');
COMMENT ON COLUMN public.posts.upload_request IS 'Internal initial upload declaration for idempotency; not measured media metadata or a public response.';

CREATE FUNCTION public.reserve_upload(
  p_event_id uuid,
  p_user_id uuid,
  p_request jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  settings_row public.event_settings%ROWTYPE;
  member_row public.event_members%ROWTYPE;
  theme_row public.themes%ROWTYPE;
  post_row public.posts%ROWTYPE;
  asset_row public.media_assets%ROWTYPE;
  request_id uuid;
  requested_theme uuid;
  declared_size numeric;
  canonical_request jsonb;
  admitted_at timestamptz;
  recent_posts bigint;
  oldest_recent timestamptz;
  reused boolean := false;
  settings_found boolean;
BEGIN
  -- A snapshot taken before the per-member lock cannot safely count later commits.
  -- PostgREST uses READ COMMITTED; do not silently weaken quota under another level.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '25001', MESSAGE = 'reserve_upload requires READ COMMITTED';
  END IF;

  IF p_event_id IS NULL OR p_user_id IS NULL
    OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('code', 'INVALID_INPUT');
  END IF;
  IF NOT (p_request ?& ARRAY['client_request_id', 'kind', 'content_type', 'file_size_bytes', 'original_scope'])
    OR p_request - ARRAY['client_request_id', 'kind', 'content_type', 'file_size_bytes', 'original_scope', 'theme_id'] <> '{}'::jsonb
    OR jsonb_typeof(p_request->'client_request_id') IS DISTINCT FROM 'string'
    OR (p_request->>'client_request_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_request->'kind') IS DISTINCT FROM 'string'
    OR (p_request->>'kind') NOT IN ('photo', 'video')
    OR jsonb_typeof(p_request->'content_type') IS DISTINCT FROM 'string'
    OR char_length(p_request->>'content_type') NOT BETWEEN 1 AND 255
    OR btrim(p_request->>'content_type') = ''
    OR (p_request->>'content_type') ~ '[[:cntrl:]]'
    OR jsonb_typeof(p_request->'file_size_bytes') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_request->'original_scope') IS DISTINCT FROM 'string'
    OR NOT (
      ((p_request->>'kind') = 'photo' AND (p_request->>'original_scope') = 'photo_file')
      OR ((p_request->>'kind') = 'video' AND (p_request->>'original_scope') IN ('client_trimmed', 'full_video_fallback'))
    ) THEN
    RETURN jsonb_build_object('code', 'INVALID_INPUT');
  END IF;
  IF p_request ? 'theme_id' AND jsonb_typeof(p_request->'theme_id') <> 'null' THEN
    IF jsonb_typeof(p_request->'theme_id') IS DISTINCT FROM 'string'
      OR (p_request->>'theme_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('code', 'INVALID_INPUT');
    END IF;
    requested_theme := (p_request->>'theme_id')::uuid;
  END IF;
  declared_size := (p_request->>'file_size_bytes')::numeric;
  IF declared_size < 1 OR trunc(declared_size) <> declared_size THEN
    RETURN jsonb_build_object('code', 'INVALID_INPUT');
  END IF;
  -- R2 object limit: 5 TiB minus 5 GiB (official limits footnote, 2026-10-04).
  -- This is not the smaller single PUT limit; multipart is a separate next step.
  IF declared_size > 5492189429760 THEN
    RETURN jsonb_build_object('code', 'PROVIDER_LIMIT');
  END IF;
  request_id := (p_request->>'client_request_id')::uuid;
  canonical_request := jsonb_build_object(
    'client_request_id', request_id,
    'kind', p_request->>'kind',
    'content_type', p_request->>'content_type',
    'file_size_bytes', declared_size::bigint,
    'original_scope', p_request->>'original_scope',
    'theme_id', requested_theme
  );

  -- Lock order: event -> settings -> member -> consent -> post -> theme -> asset.
  -- Shared policy locks retain current guards without serializing different users.
  SELECT * INTO event_row FROM public.events
  WHERE event_id = p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'FORBIDDEN'); END IF;
  SELECT * INTO settings_row FROM public.event_settings
  WHERE event_id = p_event_id FOR SHARE;
  settings_found := FOUND;
  -- Serializes new IDs and retries for this event/user, and conflicts with BAN updates.
  SELECT * INTO member_row FROM public.event_members
  WHERE event_id = p_event_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'FORBIDDEN'); END IF;
  IF NOT settings_found THEN RETURN jsonb_build_object('code', 'INTERNAL_ERROR'); END IF;
  IF member_row.is_banned THEN RETURN jsonb_build_object('code', 'ACCOUNT_BANNED'); END IF;

  admitted_at := clock_timestamp();
  IF event_row.status <> 'live' OR admitted_at < event_row.starts_at OR admitted_at >= event_row.ends_at
    OR NOT settings_row.uploads_enabled THEN
    RETURN jsonb_build_object('code', 'EVENT_CLOSED');
  END IF;
  IF settings_row.publication_stopped THEN
    RETURN jsonb_build_object('code', 'PUBLICATION_STOPPED');
  END IF;
  PERFORM 1 FROM public.consents
  WHERE event_id = p_event_id AND user_id = p_user_id AND terms_version = event_row.terms_version
    AND btrim(event_row.terms_version) <> '' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'CONSENT_REQUIRED'); END IF;

  -- Compare with the immutable initial declaration before mutable theme/state checks.
  SELECT * INTO post_row FROM public.posts
  WHERE event_id = p_event_id AND user_id = p_user_id AND client_request_id = request_id FOR UPDATE;
  IF FOUND THEN
    reused := true;
    IF post_row.upload_request IS NULL THEN
      RETURN jsonb_build_object('code', 'STATE_CONFLICT');
    END IF;
    IF post_row.upload_request IS DISTINCT FROM canonical_request THEN
      RETURN jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT');
    END IF;
    IF post_row.status <> 'uploading' OR post_row.ban_latched
      OR post_row.theme_id IS DISTINCT FROM requested_theme THEN
      RETURN jsonb_build_object('code', 'STATE_CONFLICT');
    END IF;
  END IF;

  IF requested_theme IS NOT NULL THEN
    SELECT * INTO theme_row FROM public.themes
    WHERE event_id = p_event_id AND id = requested_theme FOR SHARE;
    IF NOT FOUND OR theme_row.status <> 'published'
      OR admitted_at < theme_row.starts_at OR admitted_at >= theme_row.ends_at THEN
      RETURN jsonb_build_object('code', 'THEME_UNAVAILABLE');
    END IF;
  END IF;

  -- Lock waits may cross a time boundary even while the policy rows stay locked.
  admitted_at := clock_timestamp();
  IF admitted_at < event_row.starts_at OR admitted_at >= event_row.ends_at THEN
    RETURN jsonb_build_object('code', 'EVENT_CLOSED');
  END IF;
  IF requested_theme IS NOT NULL
    AND (admitted_at < theme_row.starts_at OR admitted_at >= theme_row.ends_at) THEN
    RETURN jsonb_build_object('code', 'THEME_UNAVAILABLE');
  END IF;

  IF NOT reused THEN
    SELECT count(*), min(created_at) INTO recent_posts, oldest_recent FROM public.posts
    WHERE event_id = p_event_id AND user_id = p_user_id AND created_at > admitted_at - interval '1 minute';
    -- The requirement caps users at 10/min; operational settings may tighten it.
    IF recent_posts >= least(settings_row.posts_per_minute, 10) THEN
      RETURN jsonb_build_object('code', 'RATE_LIMITED', 'retry_after_seconds',
        greatest(1, least(60, ceil(extract(epoch FROM oldest_recent + interval '1 minute' - admitted_at))::integer)));
    END IF;
    INSERT INTO public.posts (event_id, user_id, theme_id, kind, client_request_id,
      declared_content_type, original_scope, upload_request, created_at, updated_at)
    VALUES (p_event_id, p_user_id, requested_theme, p_request->>'kind', request_id,
      p_request->>'content_type', p_request->>'original_scope', canonical_request, admitted_at, admitted_at)
    RETURNING * INTO post_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Post reservation was not inserted';
    END IF;
    asset_row.id := gen_random_uuid();
    INSERT INTO public.media_assets (event_id, id, post_id, purpose, provider, object_key, created_at)
    VALUES (p_event_id, asset_row.id, post_row.id, 'original', 'r2_original',
      'events/' || p_event_id::text || '/posts/' || post_row.id::text || '/original/' || asset_row.id::text || '.bin', admitted_at)
    RETURNING * INTO asset_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Asset reservation was not inserted';
    END IF;
  ELSE
    SELECT * INTO asset_row FROM public.media_assets
    WHERE event_id = p_event_id AND post_id = post_row.id AND purpose = 'original' FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('code', 'INTERNAL_ERROR'); END IF;
    IF asset_row.deletion_requested_at IS NOT NULL OR asset_row.physically_deleted_at IS NOT NULL THEN
      RETURN jsonb_build_object('code', 'STATE_CONFLICT');
    END IF;
  END IF;

  -- Server-only reservation, NOT an UploadTicket or proof that R2 contains an object.
  RETURN jsonb_build_object('code', 'reserved', 'reused', reused, 'post_id', post_row.id,
    'asset_id', asset_row.id, 'object_key', asset_row.object_key, 'request', canonical_request);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_upload(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_upload(uuid, uuid, jsonb) TO service_role;
COMMENT ON FUNCTION public.reserve_upload(uuid, uuid, jsonb) IS 'Worker-only admission after Google identity/CSRF verification; READ COMMITTED; reserves metadata only, never grants an R2 URL.';

NOTIFY pgrst, 'reload schema';
COMMIT;
