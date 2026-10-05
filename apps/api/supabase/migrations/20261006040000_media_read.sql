-- Read-side policy and audited individual original retrieval. No bucket/public-access changes.
BEGIN;

CREATE FUNCTION koko_private.public_post_projection(p_event_id uuid,p_post_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT jsonb_build_object('id',p.id,'event_id',p.event_id,'kind',p.kind,'display_name',m.display_name,'crown','none',
    'theme_id',p.theme_id,'theme_name',t.title,'created_at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'like_count',0,
    'media',CASE WHEN p.kind='photo' THEN jsonb_build_object('kind','photo',
      'webp_600','/media/'||p.event_id||'/'||p.id||'/webp-600','jpg_600','/media/'||p.event_id||'/'||p.id||'/jpg-600',
      'webp_1600','/media/'||p.event_id||'/'||p.id||'/webp-1600','jpg_1600','/media/'||p.event_id||'/'||p.id||'/jpg-1600')
      ELSE jsonb_build_object('kind','video','hls_url','/media/'||p.event_id||'/'||p.id||'/hls',
        'thumbnail_url','/media/'||p.event_id||'/'||p.id||'/thumbnail','duration_seconds',p.measured_duration_seconds) END)
  FROM public.posts p JOIN public.event_members m ON m.event_id=p.event_id AND m.user_id=p.user_id
  JOIN public.events e ON e.event_id=p.event_id
  LEFT JOIN public.themes t ON t.event_id=p.event_id AND t.id=p.theme_id AND t.status IN ('published','ended')
  WHERE p.event_id=p_event_id AND p.id=p_post_id AND p.status IN ('published','published_flagged')
    AND p.moderation_verdict IN ('PASS','FLAG') AND NOT p.ban_latched AND p.deleted_at IS NULL AND NOT m.is_banned
    AND EXISTS(SELECT 1 FROM public.consents c WHERE c.event_id=p.event_id AND c.user_id=p.user_id AND c.terms_version=e.terms_version)
    AND (CASE WHEN p.kind='photo' THEN (SELECT count(*) FROM public.media_assets a WHERE a.event_id=p.event_id AND a.post_id=p.id
        AND a.purpose LIKE 'delivery_%' AND a.provider='r2_delivery' AND a.byte_size>0 AND a.sha256 IS NOT NULL
        AND a.pixel_width>0 AND a.pixel_height>0 AND a.deletion_requested_at IS NULL AND a.physically_deleted_at IS NULL)=4
      ELSE p.measured_duration_seconds>0 AND p.measured_duration_seconds<=4 AND EXISTS(SELECT 1 FROM public.media_assets a WHERE a.event_id=p.event_id AND a.post_id=p.id
        AND a.provider='stream' AND a.purpose=CASE WHEN p.original_scope='full_video_fallback' THEN 'stream_clip' ELSE 'stream_source' END
        AND a.stream_ready_to_stream AND a.stream_processing_complete AND a.stream_require_signed_urls
        AND a.stream_duration_seconds=p.measured_duration_seconds AND a.deletion_requested_at IS NULL AND a.physically_deleted_at IS NULL) END);
$$;
REVOKE ALL ON FUNCTION koko_private.public_post_projection(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION koko_private.public_post_projection(uuid,uuid) TO service_role;

CREATE FUNCTION public.read_media(
  p_event_id uuid,p_user_id uuid,p_action text,p_post_id uuid,p_resource text,p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE
  e public.events%ROWTYPE;
  s public.event_settings%ROWTYPE;
  m public.event_members%ROWTYPE;
  p public.posts%ROWTYPE;
  a public.media_assets%ROWTYPE;
  item jsonb;
  projected jsonb;
  items jsonb;
  cache_entries jsonb;
  cache_valid boolean;
  page_limit integer;
  before_at timestamptz;
  before_id uuid;
  requested_theme_id uuid;
  purpose_name text;
  observed_at timestamptz;
  has_more boolean;
  owner_id uuid;
  owner_banned boolean;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='read_media requires READ COMMITTED'; END IF;
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_action IS NULL OR p_action NOT IN ('feed','post','asset','original')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>32768 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF (p_action='feed') IS DISTINCT FROM (p_post_id IS NULL) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF (p_action='asset') IS DISTINCT FROM (p_resource IS NOT NULL) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF p_action='feed' THEN
    IF NOT p_input ? 'limit' OR p_input-ARRAY['limit','theme_id','before_at','before_id','cache']<>'{}'::jsonb
      OR jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR (p_input->>'limit')::numeric NOT BETWEEN 1 AND 100
      OR (p_input->>'limit')::numeric<>trunc((p_input->>'limit')::numeric) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    page_limit:=(p_input->>'limit')::integer;
    IF p_input ? 'theme_id' THEN
      IF jsonb_typeof(p_input->'theme_id') IS DISTINCT FROM 'string' OR (p_input->>'theme_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      requested_theme_id:=(p_input->>'theme_id')::uuid;
    END IF;
    IF p_input ?| ARRAY['before_at','before_id'] THEN
      IF NOT(p_input ?& ARRAY['before_at','before_id']) OR jsonb_typeof(p_input->'before_at') IS DISTINCT FROM 'string'
        OR jsonb_typeof(p_input->'before_id') IS DISTINCT FROM 'string' OR (p_input->>'before_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR (p_input->>'before_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      before_at:=(p_input->>'before_at')::timestamptz; before_id:=(p_input->>'before_id')::uuid;
      IF NOT isfinite(before_at) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    END IF;
  ELSIF p_action='original' THEN
    IF NOT (p_input ?& ARRAY['expected_version','request_id']) OR p_input-ARRAY['expected_version','request_id']<>'{}'::jsonb
      OR jsonb_typeof(p_input->'expected_version') IS DISTINCT FROM 'number' OR (p_input->>'expected_version')::numeric NOT BETWEEN 1 AND 2147483647
      OR (p_input->>'expected_version')::numeric<>trunc((p_input->>'expected_version')::numeric)
      OR jsonb_typeof(p_input->'request_id') IS DISTINCT FROM 'string' OR (p_input->>'request_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  ELSIF p_action='asset' AND p_resource='hls-child' THEN
    IF NOT p_input ? 'expected_version' OR p_input-'expected_version'<>'{}'::jsonb OR jsonb_typeof(p_input->'expected_version') IS DISTINCT FROM 'number'
      OR (p_input->>'expected_version')::numeric NOT BETWEEN 1 AND 2147483647 OR (p_input->>'expected_version')::numeric<>trunc((p_input->>'expected_version')::numeric) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  ELSIF p_input<>'{}'::jsonb THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','INTERNAL_ERROR'); END IF;
  SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=p_user_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  IF m.is_banned THEN RETURN jsonb_build_object('code','ACCOUNT_BANNED'); END IF;
  PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=p_user_id AND terms_version=e.terms_version AND btrim(e.terms_version)<>'' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','CONSENT_REQUIRED'); END IF;
  observed_at:=clock_timestamp();
  IF p_action='original' OR (p_action='asset' AND p_resource LIKE 'review-%') THEN
    IF m.role NOT IN ('moderator','admin') THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  ELSE
    IF s.publication_stopped THEN RETURN jsonb_build_object('code','PUBLICATION_STOPPED'); END IF;
    IF e.status NOT IN ('live','archive') OR observed_at<e.starts_at OR observed_at>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
  END IF;
  IF p_action='feed' THEN
    -- The Worker may reuse a 10s common DTO only after EVERY cached ID/fingerprint is rechecked.
    -- New arrivals may wait until cache expiry; hidden/deleted/BAN/theme/name changes invalidate immediately.
    IF p_input ? 'cache' THEN
      IF jsonb_typeof(p_input->'cache') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      IF jsonb_array_length(p_input->'cache')>page_limit THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      cache_valid:=true;
      FOR item IN SELECT value FROM jsonb_array_elements(p_input->'cache') LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT(item ?& ARRAY['id','fingerprint']) OR item-ARRAY['id','fingerprint']<>'{}'::jsonb THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
        IF jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR (item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR jsonb_typeof(item->'fingerprint') IS DISTINCT FROM 'string' OR (item->>'fingerprint') !~ '^[a-f0-9]{32}$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
        SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=(item->>'id')::uuid;
        IF NOT FOUND OR (requested_theme_id IS NOT NULL AND p.theme_id IS DISTINCT FROM requested_theme_id) OR (before_id IS NOT NULL AND (p.created_at,p.id)>=(before_at,before_id)) THEN cache_valid:=false; EXIT; END IF;
        projected:=koko_private.public_post_projection(p_event_id,p.id);
        IF projected IS NULL OR md5(projected::text)<>item->>'fingerprint' THEN cache_valid:=false; EXIT; END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_input->'cache'))<>jsonb_array_length(p_input->'cache') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      IF clock_timestamp()>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
      IF cache_valid THEN RETURN jsonb_build_object('code','ok','cache_valid',true); END IF;
    END IF;
    WITH candidates AS (
      SELECT post_row.id,post_row.created_at,koko_private.public_post_projection(post_row.event_id,post_row.id) dto FROM public.posts post_row
      WHERE post_row.event_id=p_event_id AND (requested_theme_id IS NULL OR post_row.theme_id=requested_theme_id) AND (before_id IS NULL OR (post_row.created_at,post_row.id)<(before_at,before_id))
        AND post_row.status IN ('published','published_flagged')
    ), page AS (SELECT * FROM candidates WHERE dto IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT page_limit+1)
    SELECT coalesce(jsonb_agg(dto ORDER BY created_at DESC,id DESC),'[]'::jsonb),
      coalesce(jsonb_agg(jsonb_build_object('id',id,'fingerprint',md5(dto::text)) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO items,cache_entries FROM page;
    has_more:=jsonb_array_length(items)>page_limit;
    IF has_more THEN items:=items-page_limit; cache_entries:=cache_entries-page_limit; END IF;
    IF clock_timestamp()>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
    RETURN jsonb_build_object('code','ok','cache_valid',false,'items',items,'cache',cache_entries,'has_more',has_more);
  END IF;
  SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_post_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  SELECT is_banned INTO owner_banned FROM public.event_members WHERE event_id=p_event_id AND user_id=owner_id FOR SHARE;
  IF NOT FOUND OR owner_banned THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_post_id FOR SHARE;
  IF p_resource='hls-child' AND p.version<>(p_input->>'expected_version')::bigint THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  IF p_action='original' OR (p_action='asset' AND p_resource LIKE 'review-%') THEN
    IF p.status IN ('deleted','blocked') OR p.deleted_at IS NOT NULL OR p.moderation_verdict='BLOCK' THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  ELSE
    projected:=koko_private.public_post_projection(p_event_id,p_post_id);
    IF projected IS NULL THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  END IF;
  IF p_action='post' THEN RETURN jsonb_build_object('code','ok','post',projected); END IF;
  IF p_action='original' THEN
    IF p.version<>(p_input->>'expected_version')::bigint THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
    purpose_name:='original';
  ELSIF p_resource IN ('webp-600','jpg-600','webp-1600','jpg-1600','review-webp-600','review-jpg-600','review-webp-1600','review-jpg-1600') THEN
    IF p.kind<>'photo' THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
    purpose_name:='delivery_'||split_part(replace(p_resource,'review-',''),'-',2)||'_'||split_part(replace(p_resource,'review-',''),'-',1);
  ELSIF p_resource IN ('hls','thumbnail','review-thumbnail','mp4','hls-child') THEN
    IF p.kind<>'video' THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
    purpose_name:=CASE WHEN p.original_scope='full_video_fallback' THEN 'stream_clip' ELSE 'stream_source' END;
  ELSE RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose=purpose_name FOR SHARE;
  IF NOT FOUND OR a.deletion_requested_at IS NOT NULL OR a.physically_deleted_at IS NOT NULL THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  IF a.provider='stream' THEN
    IF NOT a.stream_ready_to_stream OR NOT a.stream_processing_complete OR NOT a.stream_require_signed_urls
      OR a.stream_duration_seconds IS NULL OR a.stream_duration_seconds<=0 OR a.stream_duration_seconds>4
      OR a.stream_duration_seconds IS DISTINCT FROM p.measured_duration_seconds THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  ELSIF a.byte_size IS NULL OR a.byte_size<=0 OR (a.provider='r2_delivery' AND (a.sha256 IS NULL OR a.pixel_width IS NULL OR a.pixel_height IS NULL))
    OR (a.provider='r2_original' AND (a.object_version IS NULL OR a.object_etag IS NULL OR a.byte_size IS DISTINCT FROM p.original_bytes)) THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  IF p_action='original' THEN
    INSERT INTO public.audit_logs(event_id,actor_id,action,target_id,request_id,metadata)
      SELECT p_event_id,p_user_id,'read_original',p_post_id,(p_input->>'request_id')::uuid,jsonb_build_object('post_version',p.version,'asset_id',a.id)
      WHERE NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE event_id=p_event_id AND actor_id=p_user_id AND action='read_original'
        AND target_id=p_post_id AND request_id=(p_input->>'request_id')::uuid);
  ELSIF p_resource NOT LIKE 'review-%' AND clock_timestamp()>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
  RETURN jsonb_build_object('code','ok','asset',jsonb_build_object('event_id',p_event_id,'post_id',p_post_id,'post_version',p.version,
    'asset_id',a.id,'provider',a.provider,'purpose',a.purpose,'object_key',a.object_key,'stream_uid',a.stream_uid,
    'byte_size',a.byte_size,'object_version',a.object_version,'object_etag',a.object_etag,'sha256',a.sha256,
    'duration_seconds',a.stream_duration_seconds));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN jsonb_build_object('code','INVALID_INPUT');
END;
$$;
REVOKE ALL ON FUNCTION public.read_media(uuid,uuid,text,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_media(uuid,uuid,text,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.read_media(uuid,uuid,text,uuid,text,jsonb) IS 'Fresh API authorization before cache or bytes. Original/Stream identifiers remain server-only. Original read audit is authorization, not download completion evidence.';
NOTIFY pgrst,'reload schema';
COMMIT;
