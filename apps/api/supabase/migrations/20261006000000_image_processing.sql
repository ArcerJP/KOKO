-- B2-1 internal image phase only. No Queue/HTTP registration or publication.
BEGIN;
ALTER TABLE public.outbox_jobs
  ADD COLUMN image_attempt integer NOT NULL DEFAULT 0 CHECK (image_attempt BETWEEN 0 AND 3),
  ADD COLUMN image_owner_id uuid REFERENCES auth.users(id),
  ADD COLUMN image_plan jsonb CHECK (image_plan IS NULL OR jsonb_typeof(image_plan)='object'),
  ADD COLUMN image_completed_at timestamptz,
  ADD COLUMN image_receipt jsonb CHECK (image_receipt IS NULL OR jsonb_typeof(image_receipt)='object'),
  ADD CONSTRAINT image_completion_pair CHECK ((image_completed_at IS NULL)=(image_receipt IS NULL));
ALTER TABLE public.media_assets
  ADD COLUMN pixel_width integer CHECK (pixel_width>0),
  ADD COLUMN pixel_height integer CHECK (pixel_height>0);
COMMENT ON COLUMN public.outbox_jobs.image_completed_at IS 'Private derivative metadata recorded; NOT AI verdict, process_media completion or publication.';

CREATE FUNCTION public.manage_image_processing(
  p_event_id uuid, p_post_id uuid, p_job_id uuid, p_action text, p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  e public.events%ROWTYPE;
  s public.event_settings%ROWTYPE;
  m public.event_members%ROWTYPE;
  p public.posts%ROWTYPE;
  j public.outbox_jobs%ROWTYPE;
  a public.media_assets%ROWTYPE;
  owner_id uuid;
  observed_at timestamptz;
  original jsonb;
  refs jsonb;
  plan jsonb;
  item jsonb;
  receipt jsonb;
  purpose_name text;
  asset_id uuid;
  expires_ms bigint;
  expected_size numeric;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='manage_image_processing requires READ COMMITTED';
  END IF;
  IF p_event_id IS NULL OR p_post_id IS NULL OR p_job_id IS NULL
    OR p_action IS NULL OR p_action NOT IN ('claim','check','finish')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF octet_length(p_input::text)>16384
    OR (p_action='claim' AND p_input<>'{}'::jsonb)
    OR (p_action='check' AND (NOT p_input ? 'plan' OR p_input-'plan'<>'{}'::jsonb))
    OR (p_action='finish' AND (NOT (p_input ?& ARRAY['plan','originalSha256','deliveries'])
      OR p_input-ARRAY['plan','originalSha256','deliveries']<>'{}'::jsonb)) THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;

  -- Same policy-first lock order as upload completion; hints never authorize work.
  SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
  SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
  SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_post_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
  SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=owner_id FOR SHARE;
  IF NOT FOUND OR m.is_banned THEN RETURN jsonb_build_object('code','STALE'); END IF;
  PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id
    AND terms_version=e.terms_version AND btrim(e.terms_version)<>'' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','STALE'); END IF;
  SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_post_id FOR UPDATE;
  IF NOT FOUND OR p.user_id<>owner_id OR p.kind<>'photo' OR p.original_scope<>'photo_file'
    OR p.ban_latched OR p.deleted_at IS NOT NULL OR p.status NOT IN ('uploaded','processing')
    OR p.version NOT BETWEEN 1 AND 2147483647 THEN
    RETURN jsonb_build_object('code','STALE');
  END IF;
  PERFORM id FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id ORDER BY id FOR UPDATE;
  SELECT * INTO j FROM public.outbox_jobs WHERE event_id=p_event_id AND post_id=p_post_id AND id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.kind<>'process_media' OR j.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('code','STALE');
  END IF;
  observed_at := clock_timestamp();
  -- Accepted work can finish after the upload window, but not in archive/private mode.
  IF e.status<>'live' OR observed_at<e.starts_at OR observed_at>=e.private_at
    OR s.publication_stopped OR NOT s.uploads_enabled THEN
    RETURN jsonb_build_object('code','STALE');
  END IF;
  SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose='original';
  IF NOT FOUND OR a.provider<>'r2_original' OR a.deletion_requested_at IS NOT NULL OR a.physically_deleted_at IS NOT NULL
    OR a.byte_size IS NULL OR a.byte_size IS DISTINCT FROM p.original_bytes
    OR a.object_etag IS NULL OR a.object_etag !~ '^[a-f0-9]{32}(-[1-9][0-9]{0,3}|-10000)?$'
    OR a.object_version IS NULL
    OR j.payload->'asset_id' IS DISTINCT FROM to_jsonb(a.id)
    OR j.payload->'object_etag' IS DISTINCT FROM to_jsonb(a.object_etag)
    OR j.payload->'object_version' IS DISTINCT FROM to_jsonb(a.object_version) THEN
    RETURN jsonb_build_object('code','STALE');
  END IF;
  IF a.byte_size>67108864 THEN RETURN jsonb_build_object('code','RESOURCE_LIMIT'); END IF;
  original := jsonb_build_object('eventId',p_event_id,'postId',p_post_id,'assetId',a.id,'size',a.byte_size,'etag',a.object_etag);

  IF j.image_plan IS NOT NULL THEN
    plan := j.image_plan;
    IF p.status<>'processing' OR j.image_owner_id IS DISTINCT FROM p.user_id OR plan->'jobId' IS DISTINCT FROM to_jsonb(j.id)
      OR plan->'postVersion' IS DISTINCT FROM to_jsonb(p.version)
      OR j.payload->'post_version' IS DISTINCT FROM to_jsonb(p.version-1)
      OR (plan->'original')-'sha256' IS DISTINCT FROM original
      OR (plan->'original' ? 'sha256' AND plan->'original'->'sha256' IS DISTINCT FROM to_jsonb(a.sha256))
      OR jsonb_typeof(plan->'expiresAt') IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('code','STALE');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',event_id,'assetId',id,
      'variant',split_part(purpose,'_',2),'format',split_part(purpose,'_',3)) ORDER BY purpose),'[]'::jsonb)
      INTO refs FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose LIKE 'delivery_%';
    IF jsonb_array_length(refs)<>4 OR plan->'deliveries' IS DISTINCT FROM refs
      OR EXISTS(SELECT 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose LIKE 'delivery_%'
        AND (deletion_requested_at IS NOT NULL OR physically_deleted_at IS NOT NULL
          OR (j.image_completed_at IS NULL AND (byte_size IS NOT NULL OR sha256 IS NOT NULL OR pixel_width IS NOT NULL OR pixel_height IS NOT NULL)))) THEN
      RETURN jsonb_build_object('code','STALE');
    END IF;
  ELSIF p.status<>'uploaded' OR j.image_attempt<>0 OR j.image_owner_id IS NOT NULL OR j.image_completed_at IS NOT NULL
    OR j.payload->'post_version' IS DISTINCT FROM to_jsonb(p.version)
    OR EXISTS(SELECT 1 FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose LIKE 'delivery_%') THEN
    RETURN jsonb_build_object('code','STALE');
  END IF;

  IF p_action='claim' THEN
    IF j.image_completed_at IS NOT NULL THEN RETURN jsonb_build_object('code','IMAGE_SAVED'); END IF;
    IF plan IS NOT NULL AND (plan->>'expiresAt')::numeric>extract(epoch FROM clock_timestamp())*1000 THEN
      RETURN jsonb_build_object('code','BUSY');
    END IF;
    IF j.image_attempt>=3 THEN RETURN jsonb_build_object('code','EXHAUSTED'); END IF;
    IF plan IS NULL THEN
      IF p.version=2147483647 THEN RETURN jsonb_build_object('code','STALE'); END IF;
      FOREACH purpose_name IN ARRAY ARRAY['delivery_1600_jpg','delivery_1600_webp','delivery_600_jpg','delivery_600_webp'] LOOP
        asset_id := gen_random_uuid();
        INSERT INTO public.media_assets(event_id,id,post_id,purpose,provider,object_key)
          VALUES(p_event_id,asset_id,p_post_id,purpose_name,'r2_delivery',
            'events/'||p_event_id::text||'/delivery/'||asset_id::text||'/'||split_part(purpose_name,'_',2)||'.'||split_part(purpose_name,'_',3));
      END LOOP;
      SELECT jsonb_agg(jsonb_build_object('eventId',event_id,'assetId',id,
        'variant',split_part(purpose,'_',2),'format',split_part(purpose,'_',3)) ORDER BY purpose)
        INTO refs FROM public.media_assets WHERE event_id=p_event_id AND post_id=p_post_id AND purpose LIKE 'delivery_%';
      UPDATE public.posts SET status='processing',version=version+1,updated_at=clock_timestamp()
        WHERE event_id=p_event_id AND id=p_post_id RETURNING * INTO p;
      IF a.sha256 IS NOT NULL THEN original := original||jsonb_build_object('sha256',a.sha256); END IF;
      plan := jsonb_build_object('jobId',j.id,'postVersion',p.version,'original',original,'deliveries',refs);
    END IF;
    observed_at := clock_timestamp();
    -- Millisecond precision is shared with the JS pipeline; no caller-supplied TTL.
    expires_ms := least(floor(extract(epoch FROM observed_at)*1000)::bigint+120000,
      floor(extract(epoch FROM e.private_at)*1000)::bigint);
    plan := plan||jsonb_build_object('leaseId',gen_random_uuid(),'expiresAt',expires_ms);
    UPDATE public.outbox_jobs SET image_attempt=image_attempt+1,image_plan=plan,image_owner_id=owner_id WHERE id=j.id;
    RETURN jsonb_build_object('code','CLAIMED','plan',plan);
  END IF;

  IF plan IS NULL OR p_input->'plan' IS DISTINCT FROM plan THEN RETURN jsonb_build_object('code','STALE'); END IF;
  IF p_action='check' THEN
    IF j.image_completed_at IS NOT NULL OR (plan->>'expiresAt')::numeric<=extract(epoch FROM clock_timestamp())*1000 THEN
      RETURN jsonb_build_object('code','STALE');
    END IF;
    RETURN jsonb_build_object('code','CURRENT');
  END IF;

  IF jsonb_typeof(p_input->'originalSha256') IS DISTINCT FROM 'string'
    OR (p_input->>'originalSha256') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_input->'deliveries') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF jsonb_array_length(p_input->'deliveries')<>4 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF a.sha256 IS NOT NULL AND a.sha256<>p_input->>'originalSha256' THEN RETURN jsonb_build_object('code','CONFLICT'); END IF;
  -- Validate EVERY receipt before updating any asset. Never accept raw URLs/bytes.
  FOR item IN SELECT value FROM jsonb_array_elements(p_input->'deliveries') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF NOT (item ?& ARRAY['eventId','assetId','variant','format','outcome','sha256','size','width','height'])
      OR item-ARRAY['eventId','assetId','variant','format','outcome','sha256','size','width','height']<>'{}'::jsonb
      OR jsonb_typeof(item->'sha256') IS DISTINCT FROM 'string' OR (item->>'sha256') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(item->'outcome') IS DISTINCT FROM 'string' OR item->>'outcome' NOT IN ('stored','already_stored')
      OR jsonb_typeof(item->'size') IS DISTINCT FROM 'number'
      OR jsonb_typeof(item->'width') IS DISTINCT FROM 'number'
      OR jsonb_typeof(item->'height') IS DISTINCT FROM 'number'
      OR NOT refs @> jsonb_build_array(item-ARRAY['outcome','sha256','size','width','height']) THEN
      RETURN jsonb_build_object('code','INVALID_INPUT');
    END IF;
    expected_size := (item->>'size')::numeric;
    IF expected_size NOT BETWEEN 1 AND 16777216 OR expected_size<>trunc(expected_size)
      OR (item->>'width')::numeric NOT BETWEEN 1 AND (item->>'variant')::integer
      OR (item->>'height')::numeric NOT BETWEEN 1 AND (item->>'variant')::integer
      OR (item->>'width')::numeric<>trunc((item->>'width')::numeric)
      OR (item->>'height')::numeric<>trunc((item->>'height')::numeric) THEN
      RETURN jsonb_build_object('code','INVALID_INPUT');
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'assetId') FROM jsonb_array_elements(p_input->'deliveries'))<>4 THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  SELECT jsonb_build_object('originalSha256',p_input->'originalSha256',
    'deliveries',jsonb_agg(value-'outcome' ORDER BY value->>'variant',value->>'format'))
    INTO receipt FROM jsonb_array_elements(p_input->'deliveries');
  IF j.image_completed_at IS NOT NULL THEN
    IF j.image_receipt IS DISTINCT FROM receipt OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(receipt->'deliveries') r(value)
      JOIN public.media_assets ma ON ma.event_id=p_event_id AND ma.id=(r.value->>'assetId')::uuid
      WHERE ma.byte_size IS DISTINCT FROM (r.value->>'size')::bigint
        OR ma.sha256 IS DISTINCT FROM r.value->>'sha256'
        OR ma.pixel_width IS DISTINCT FROM (r.value->>'width')::integer
        OR ma.pixel_height IS DISTINCT FROM (r.value->>'height')::integer
    ) THEN RETURN jsonb_build_object('code','CONFLICT'); END IF;
    RETURN jsonb_build_object('code','RECORDED');
  END IF;
  observed_at := clock_timestamp();
  IF (plan->>'expiresAt')::numeric<=extract(epoch FROM observed_at)*1000 OR observed_at>=e.private_at THEN
    RETURN jsonb_build_object('code','STALE');
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(receipt->'deliveries') LOOP
    UPDATE public.media_assets SET byte_size=(item->>'size')::bigint,sha256=item->>'sha256',
      pixel_width=(item->>'width')::integer,pixel_height=(item->>'height')::integer
      WHERE event_id=p_event_id AND post_id=p_post_id AND id=(item->>'assetId')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Image asset receipt was not recorded'; END IF;
  END LOOP;
  UPDATE public.media_assets SET sha256=p_input->>'originalSha256' WHERE event_id=p_event_id AND id=a.id;
  UPDATE public.outbox_jobs SET image_completed_at=observed_at,image_receipt=receipt WHERE id=j.id;
  RETURN jsonb_build_object('code','RECORDED');
END;
$$;
REVOKE ALL ON FUNCTION public.manage_image_processing(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_image_processing(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.manage_image_processing(uuid,uuid,uuid,text,jsonb) IS 'Internal image claim/check/finish. Reloads DB policy and identity; trusted pipeline receipts only. No public route, external IO, moderation, job completion or publication.';
NOTIFY pgrst, 'reload schema';
COMMIT;
