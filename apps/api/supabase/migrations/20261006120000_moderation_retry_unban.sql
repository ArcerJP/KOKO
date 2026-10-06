-- Append-only correction; local preparation only, not an instruction to apply to a live database.
-- Preserve the existing service-only RPC signature, policy-first lock order, and every unrelated action.
BEGIN;

CREATE OR REPLACE FUNCTION public.stage_three_operation(
  p_event_id uuid,p_user_id uuid,p_operation text,p_target_id uuid,p_input jsonb,p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  e public.events%ROWTYPE;
  s public.event_settings%ROWTYPE;
  m public.event_members%ROWTYPE;
  owner_row public.event_members%ROWTYPE;
  p public.posts%ROWTYPE;
  a public.media_assets%ROWTYPE;
  appeal public.appeals%ROWTYPE;
  t public.themes%ROWTYPE;
  observed_at timestamptz;
  item jsonb;
  items jsonb;
  required_keys text[];
  allowed_keys text[];
  read_only boolean;
  inserted_id uuid;
  owner_id uuid;
  requested_theme_id uuid;
  before_at timestamptz;
  before_id uuid;
  before_priority integer;
  page_limit integer;
  has_more boolean;
  date_start timestamptz;
  date_end timestamptz;
  reason text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='stage_three_operation requires READ COMMITTED';
  END IF;
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL OR p_operation IS NULL
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>32768 THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  CASE p_operation
    WHEN 'themes' THEN required_keys:=ARRAY[]::text[];
    WHEN 'admin_themes' THEN required_keys:=ARRAY[]::text[];
    WHEN 'get_settings' THEN required_keys:=ARRAY[]::text[];
    WHEN 'delete_own' THEN required_keys:=ARRAY[]::text[];
    WHEN 'delete_theme' THEN required_keys:=ARRAY[]::text[];
    WHEN 'report' THEN required_keys:=ARRAY['reason']; allowed_keys:=ARRAY['reason','detail'];
    WHEN 'appeal' THEN required_keys:=ARRAY['message']; allowed_keys:=ARRAY['message','post_id'];
    WHEN 'hide' THEN required_keys:=ARRAY['expected_version','reason'];
    WHEN 'restore' THEN required_keys:=ARRAY['expected_version','reason'];
    WHEN 'delete' THEN required_keys:=ARRAY['expected_version','reason'];
    WHEN 'retry' THEN required_keys:=ARRAY['expected_version','reason'];
    WHEN 'reassign_theme' THEN required_keys:=ARRAY['expected_version','reason','theme_id'];
    WHEN 'ban' THEN required_keys:=ARRAY['reason'];
    WHEN 'unban' THEN required_keys:=ARRAY['reason'];
    WHEN 'resolve_appeal' THEN required_keys:=ARRAY['status','reason'];
    WHEN 'create_theme' THEN required_keys:=ARRAY['title','description','icon','color','status','starts_at','ends_at'];
    WHEN 'update_theme' THEN required_keys:=ARRAY['title','description','icon','color','status','starts_at','ends_at'];
    WHEN 'update_settings' THEN required_keys:=ARRAY['version','publication_stopped','uploads_enabled','moderation_concurrency','thresholds'];
    WHEN 'admin_feed' THEN required_keys:=ARRAY['limit']; allowed_keys:=ARRAY['limit','before_at','before_id','before_priority'];
    WHEN 'admin_appeals' THEN required_keys:=ARRAY['limit']; allowed_keys:=ARRAY['limit','before_at','before_id','before_priority'];
    ELSE RETURN jsonb_build_object('code','INVALID_INPUT');
  END CASE;
  IF NOT (p_input ?& required_keys) OR p_input-coalesce(allowed_keys,required_keys)<>'{}'::jsonb THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF (p_operation IN ('delete_own','delete_theme','report','hide','restore','delete','retry','reassign_theme','ban','unban','resolve_appeal','update_theme'))
    IS DISTINCT FROM (p_target_id IS NOT NULL) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF p_input ? 'reason' AND (jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string'
    OR char_length(p_input->>'reason') NOT BETWEEN 1 AND 1000 OR btrim(p_input->>'reason')='') THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  reason:=p_input->>'reason';
  IF p_input ? 'expected_version' AND (jsonb_typeof(p_input->'expected_version') IS DISTINCT FROM 'number'
    OR (p_input->>'expected_version')::numeric NOT BETWEEN 1 AND 2147483647
    OR (p_input->>'expected_version')::numeric<>trunc((p_input->>'expected_version')::numeric)) THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF p_operation='report' AND (reason NOT IN ('privacy','sexual','violence','harassment','other')
    OR (p_input ? 'detail' AND (jsonb_typeof(p_input->'detail') IS DISTINCT FROM 'string' OR char_length(p_input->>'detail')>1000))) THEN
    RETURN jsonb_build_object('code','INVALID_INPUT');
  END IF;
  IF p_operation='appeal' THEN
    IF jsonb_typeof(p_input->'message') IS DISTINCT FROM 'string' OR char_length(p_input->>'message') NOT BETWEEN 1 AND 2000
      OR btrim(p_input->>'message')='' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF p_input ? 'post_id' AND p_input->'post_id'<>'null'::jsonb THEN
      IF jsonb_typeof(p_input->'post_id') IS DISTINCT FROM 'string' OR (p_input->>'post_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      p_target_id:=(p_input->>'post_id')::uuid;
    END IF;
  END IF;
  IF p_operation='reassign_theme' AND p_input->'theme_id'<>'null'::jsonb THEN
    IF jsonb_typeof(p_input->'theme_id') IS DISTINCT FROM 'string' OR (p_input->>'theme_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    requested_theme_id:=(p_input->>'theme_id')::uuid;
  END IF;
  IF p_operation='resolve_appeal' AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR p_input->>'status' NOT IN ('resolved','rejected')) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  IF p_operation IN ('create_theme','update_theme') THEN
    IF EXISTS(SELECT 1 FROM unnest(required_keys) k WHERE jsonb_typeof(p_input->k) IS DISTINCT FROM 'string')
      OR char_length(p_input->>'title') NOT BETWEEN 1 AND 100 OR btrim(p_input->>'title')=''
      OR char_length(p_input->>'description')>2000 OR char_length(p_input->>'icon')>50
      OR (p_input->>'color') !~ '^#[0-9a-fA-F]{6}$' OR p_input->>'status' NOT IN ('draft','published','ended')
      OR (p_input->>'starts_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
      OR (p_input->>'ends_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    date_start:=(p_input->>'starts_at')::timestamptz; date_end:=(p_input->>'ends_at')::timestamptz;
    IF NOT isfinite(date_start) OR NOT isfinite(date_end) OR date_start>=date_end THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  END IF;
  IF p_operation='update_settings' THEN
    IF jsonb_typeof(p_input->'version') IS DISTINCT FROM 'number' OR (p_input->>'version')::numeric NOT BETWEEN 1 AND 2147483647
      OR (p_input->>'version')::numeric<>trunc((p_input->>'version')::numeric)
      OR jsonb_typeof(p_input->'publication_stopped') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'uploads_enabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(p_input->'moderation_concurrency') IS DISTINCT FROM 'number'
      OR (p_input->>'moderation_concurrency')::numeric NOT BETWEEN 1 AND 2147483647
      OR (p_input->>'moderation_concurrency')::numeric<>trunc((p_input->>'moderation_concurrency')::numeric)
      OR jsonb_typeof(p_input->'thresholds') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    IF jsonb_array_length(p_input->'thresholds')>100 THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_input->'thresholds') LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      IF NOT (item ?& ARRAY['engine','category','flag','block','immediate_ban']) OR item-ARRAY['engine','category','flag','block','immediate_ban']<>'{}'::jsonb
        OR jsonb_typeof(item->'engine') IS DISTINCT FROM 'string' OR item->>'engine' NOT IN ('openai','safesearch','ocr')
        OR jsonb_typeof(item->'category') IS DISTINCT FROM 'string'
        OR jsonb_typeof(item->'flag') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'block') IS DISTINCT FROM 'number'
        OR jsonb_typeof(item->'immediate_ban') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      IF (item->>'flag')::numeric NOT BETWEEN 0 AND 1 OR (item->>'block')::numeric NOT BETWEEN 0 AND 1
        OR (item->>'flag')::numeric>(item->>'block')::numeric
        OR NOT (CASE item->>'engine'
          WHEN 'openai' THEN item->>'category' IN ('sexual','violence','violence/graphic','self-harm','self-harm/intent','self-harm/instructions')
          WHEN 'safesearch' THEN item->>'category' IN ('adult','spoof','medical','violence','racy')
          WHEN 'ocr' THEN item->>'category' IN ('sexual','sexual/minors','violence','violence/graphic','self-harm','self-harm/intent','self-harm/instructions','harassment','harassment/threatening','hate','hate/threatening','illicit','illicit/violent') END)
        OR ((item->>'immediate_ban')::boolean AND (item->>'engine'='safesearch' OR item->>'category' NOT IN ('sexual/minors','violence/graphic','illicit/violent','hate/threatening','harassment/threatening'))) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    END LOOP;
    IF (SELECT count(DISTINCT (value->>'engine',value->>'category')) FROM jsonb_array_elements(p_input->'thresholds'))<>jsonb_array_length(p_input->'thresholds') THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
  END IF;
  IF p_operation IN ('admin_feed','admin_appeals') THEN
    IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR (p_input->>'limit')::numeric NOT BETWEEN 1 AND 100
      OR (p_input->>'limit')::numeric<>trunc((p_input->>'limit')::numeric) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    page_limit:=(p_input->>'limit')::integer;
    IF p_input ?| ARRAY['before_at','before_id','before_priority'] THEN
      IF NOT (p_input ?& ARRAY['before_at','before_id','before_priority']) OR jsonb_typeof(p_input->'before_at') IS DISTINCT FROM 'string'
        OR jsonb_typeof(p_input->'before_id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'before_priority') IS DISTINCT FROM 'number'
        OR (p_input->>'before_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR (p_input->>'before_priority')::numeric NOT IN (0,1,2)
        OR (p_input->>'before_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
      before_at:=(p_input->>'before_at')::timestamptz; before_id:=(p_input->>'before_id')::uuid; before_priority:=(p_input->>'before_priority')::integer;
      IF NOT isfinite(before_at) OR (p_operation='admin_appeals' AND before_priority<>0) THEN RETURN jsonb_build_object('code','INVALID_INPUT'); END IF;
    END IF;
  END IF;

  read_only:=p_operation IN ('themes','admin_themes','get_settings','admin_feed','admin_appeals');
  -- A policy-first exclusive event lock serializes operational writes against existing upload/image shared locks.
  -- No member/post lock is taken before this gate; a banned owner cannot race publication or admission.
  IF read_only THEN SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR SHARE;
  ELSE SELECT * INTO e FROM public.events WHERE event_id=p_event_id FOR UPDATE; END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  IF p_operation='update_settings' THEN SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR UPDATE;
  ELSE SELECT * INTO s FROM public.event_settings WHERE event_id=p_event_id FOR SHARE; END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','INTERNAL_ERROR'); END IF;
  SELECT * INTO m FROM public.event_members WHERE event_id=p_event_id AND user_id=p_user_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  IF p_operation NOT IN ('themes','delete_own','report','appeal') THEN
    IF m.is_banned OR m.role NOT IN ('moderator','admin') THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
    IF p_operation NOT IN ('admin_feed','hide','restore','delete') AND m.role<>'admin' THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
  END IF;
  IF p_operation NOT IN ('delete_own','appeal') THEN
    IF m.is_banned THEN RETURN jsonb_build_object('code','ACCOUNT_BANNED'); END IF;
    PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=p_user_id AND terms_version=e.terms_version AND btrim(e.terms_version)<>'' FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('code','CONSENT_REQUIRED'); END IF;
  END IF;
  observed_at:=clock_timestamp();

  IF p_operation IN ('themes','admin_themes') THEN
    IF p_operation='themes' THEN
      IF s.publication_stopped THEN RETURN jsonb_build_object('code','PUBLICATION_STOPPED'); END IF;
      IF e.status NOT IN ('live','archive') OR observed_at<e.starts_at OR observed_at>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'event_id',event_id,'title',title,'description',description,
      'icon',icon,'color',color,'status',status,'starts_at',starts_at,'ends_at',ends_at) ORDER BY starts_at,id),'[]'::jsonb) INTO items
      FROM public.themes WHERE event_id=p_event_id AND (p_operation='admin_themes' OR (status<>'draft' AND starts_at<=observed_at));
    RETURN jsonb_build_object('code','ok','items',items);
  ELSIF p_operation='get_settings' THEN
    RETURN jsonb_build_object('code','ok','settings',jsonb_build_object('version',s.settings_version,'publication_stopped',s.publication_stopped,
      'uploads_enabled',s.uploads_enabled,'moderation_concurrency',s.moderation_concurrency,'thresholds',s.moderation_thresholds,'thresholds_approved',s.thresholds_approved));
  ELSIF p_operation='admin_feed' THEN
    WITH page AS (
      SELECT post_row.*,member_row.is_banned,CASE WHEN post_row.report_count>0 THEN 2 WHEN post_row.status='published_flagged' THEN 1 ELSE 0 END AS priority
        FROM public.posts post_row JOIN public.event_members member_row ON member_row.event_id=post_row.event_id AND member_row.user_id=post_row.user_id WHERE post_row.event_id=p_event_id
    ), selected AS (
      SELECT * FROM page WHERE before_id IS NULL OR (priority,created_at,id)<(before_priority,before_at,before_id)
      ORDER BY priority DESC,created_at DESC,id DESC LIMIT page_limit+1
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('post',jsonb_build_object('id',id,'event_id',event_id,'status',status,'version',version,
      'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) || koko_private.post_state_details(event_id,id),
      'user_id',user_id,'report_count',report_count,'is_banned',is_banned,'priority',priority,
      'preview_resource',CASE WHEN status IN ('published','published_flagged','hidden') AND moderation_verdict IN ('PASS','FLAG') AND NOT is_banned THEN
        CASE WHEN kind='photo' AND EXISTS(SELECT 1 FROM public.media_assets preview WHERE preview.event_id=selected.event_id AND preview.post_id=selected.id
          AND purpose='delivery_600_webp' AND provider='r2_delivery' AND sha256 IS NOT NULL AND byte_size>0 AND deletion_requested_at IS NULL AND physically_deleted_at IS NULL)
          THEN 'review-webp-600'
        WHEN kind='video' AND measured_duration_seconds>0 AND measured_duration_seconds<=4 AND EXISTS(SELECT 1 FROM public.media_assets preview WHERE preview.event_id=selected.event_id AND preview.post_id=selected.id
          AND provider='stream' AND purpose=CASE WHEN selected.original_scope='full_video_fallback' THEN 'stream_clip' ELSE 'stream_source' END
          AND stream_ready_to_stream AND stream_processing_complete AND stream_require_signed_urls AND stream_duration_seconds=selected.measured_duration_seconds
          AND deletion_requested_at IS NULL AND physically_deleted_at IS NULL) THEN 'review-thumbnail' END END)
      ORDER BY priority DESC,created_at DESC,id DESC),'[]'::jsonb) INTO items FROM selected;
    has_more:=jsonb_array_length(items)>page_limit;
    IF has_more THEN items:=items-page_limit; END IF;
    RETURN jsonb_build_object('code','ok','items',items,'has_more',has_more);
  ELSIF p_operation='admin_appeals' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'post_id',post_id,'message',message,'status',status,
      'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO items
      FROM (SELECT * FROM public.appeals WHERE event_id=p_event_id AND (before_id IS NULL OR (created_at,id)<(before_at,before_id))
        ORDER BY created_at DESC,id DESC LIMIT page_limit+1) q;
    has_more:=jsonb_array_length(items)>page_limit;
    IF has_more THEN items:=items-page_limit; END IF;
    RETURN jsonb_build_object('code','ok','items',items,'has_more',has_more);
  ELSIF p_operation='update_settings' THEN
    IF s.settings_version<>(p_input->>'version')::bigint THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
    -- Editing values is never approval. A changed policy invalidates prior calibration approval.
    IF NOT (p_input->>'publication_stopped')::boolean AND (NOT s.thresholds_approved OR s.moderation_thresholds IS DISTINCT FROM p_input->'thresholds') THEN
      RETURN jsonb_build_object('code','STATE_CONFLICT');
    END IF;
    UPDATE public.event_settings SET settings_version=settings_version+1,publication_stopped=(p_input->>'publication_stopped')::boolean,
      uploads_enabled=NOT (p_input->>'publication_stopped')::boolean AND (p_input->>'uploads_enabled')::boolean,
      moderation_concurrency=(p_input->>'moderation_concurrency')::integer,
      thresholds_approved=thresholds_approved AND moderation_thresholds=p_input->'thresholds',moderation_thresholds=p_input->'thresholds',updated_at=observed_at WHERE event_id=p_event_id;
    INSERT INTO public.audit_logs(event_id,actor_id,action,request_id,metadata) VALUES(p_event_id,p_user_id,'update_settings',p_request_id,
      jsonb_build_object('previous_version',s.settings_version,'publication_stopped',(p_input->>'publication_stopped')::boolean,'thresholds_changed',s.moderation_thresholds IS DISTINCT FROM p_input->'thresholds'));
    RETURN jsonb_build_object('code','ok');
  ELSIF p_operation IN ('create_theme','update_theme','delete_theme') THEN
    IF p_operation<>'create_theme' THEN
      SELECT * INTO t FROM public.themes WHERE event_id=p_event_id AND id=p_target_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
    END IF;
    IF p_operation='create_theme' THEN
      INSERT INTO public.themes(event_id,title,description,icon,color,status,starts_at,ends_at) VALUES(p_event_id,p_input->>'title',p_input->>'description',p_input->>'icon',p_input->>'color',p_input->>'status',date_start,date_end) RETURNING id INTO p_target_id;
    ELSIF p_operation='update_theme' THEN
      UPDATE public.themes SET title=p_input->>'title',description=p_input->>'description',icon=p_input->>'icon',color=p_input->>'color',status=p_input->>'status',starts_at=date_start,ends_at=date_end WHERE event_id=p_event_id AND id=p_target_id;
    ELSIF EXISTS(SELECT 1 FROM public.posts WHERE event_id=p_event_id AND theme_id=p_target_id) THEN
      UPDATE public.themes SET status='ended' WHERE event_id=p_event_id AND id=p_target_id;
    ELSE DELETE FROM public.themes WHERE event_id=p_event_id AND id=p_target_id;
    END IF;
  ELSIF p_operation='resolve_appeal' THEN
    SELECT * INTO appeal FROM public.appeals WHERE event_id=p_event_id AND id=p_target_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
    IF appeal.status<>'open' THEN
      IF appeal.status=p_input->>'status' AND appeal.resolution_reason=reason THEN RETURN jsonb_build_object('code','ok'); END IF;
      RETURN jsonb_build_object('code','STATE_CONFLICT');
    END IF;
    UPDATE public.appeals SET status=p_input->>'status',resolution_reason=reason,resolved_by=p_user_id,resolved_at=observed_at WHERE event_id=p_event_id AND id=p_target_id;
  ELSIF p_operation IN ('ban','unban') THEN
    SELECT * INTO owner_row FROM public.event_members WHERE event_id=p_event_id AND user_id=p_target_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
    -- Operational BAN targets participants, never a covert change of another operator's authority.
    IF owner_row.role<>'user' OR p_target_id=p_user_id THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
    IF owner_row.is_banned=(p_operation='ban') THEN RETURN jsonb_build_object('code','ok'); END IF;
    UPDATE public.event_members SET is_banned=(p_operation='ban'),banned_at=CASE WHEN p_operation='ban' THEN observed_at ELSE NULL END WHERE event_id=p_event_id AND user_id=p_target_id;
    IF p_operation='ban' THEN
      FOR p IN SELECT * FROM public.posts WHERE event_id=p_event_id AND user_id=p_target_id AND status<>'deleted' ORDER BY id FOR UPDATE LOOP
        UPDATE public.posts SET ban_latched=true,previous_public_status=CASE WHEN status IN ('published','published_flagged') THEN status ELSE previous_public_status END,
          hidden_reason=CASE WHEN status IN ('published','published_flagged','hidden') THEN 'ban' ELSE hidden_reason END,
          status=CASE WHEN status IN ('published','published_flagged') THEN 'hidden'::public.post_status ELSE status END,version=version+1,updated_at=observed_at WHERE id=p.id;
        INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'revoke_delivery','ban:'||p.id||':'||(p.version+1),jsonb_build_object('post_version',p.version+1));
      END LOOP;
      UPDATE public.event_members SET published_post_count=0 WHERE event_id=p_event_id AND user_id=p_target_id;
      INSERT INTO public.outbox_jobs(event_id,kind,deduplication_key,payload) VALUES(p_event_id,'notify','ban:'||p_request_id,jsonb_build_object('category','ban','user_id',p_target_id));
    END IF;
  ELSIF p_operation='appeal' THEN
    IF p_target_id IS NOT NULL THEN
      SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_target_id AND user_id=p_user_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
      IF p.status<>'blocked' AND NOT m.is_banned THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
    ELSIF NOT m.is_banned THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
    SELECT id INTO inserted_id FROM public.appeals WHERE event_id=p_event_id AND user_id=p_user_id AND post_id IS NOT DISTINCT FROM p_target_id
      AND status='open' AND message=p_input->>'message';
    IF FOUND THEN RETURN jsonb_build_object('code','ok'); END IF;
    IF (SELECT count(*) FROM public.appeals WHERE event_id=p_event_id AND user_id=p_user_id AND created_at>observed_at-interval '1 minute')>=10 THEN RETURN jsonb_build_object('code','RATE_LIMITED'); END IF;
    INSERT INTO public.appeals(event_id,user_id,post_id,message) VALUES(p_event_id,p_user_id,p_target_id,p_input->>'message') RETURNING id INTO inserted_id;
    INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p_target_id,'notify','appeal:'||inserted_id,jsonb_build_object('category','appeal','appeal_id',inserted_id));
    p_target_id:=inserted_id;
  ELSE
    SELECT user_id INTO owner_id FROM public.posts WHERE event_id=p_event_id AND id=p_target_id;
    IF NOT FOUND OR (p_operation='delete_own' AND owner_id<>p_user_id) THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
    SELECT * INTO owner_row FROM public.event_members WHERE event_id=p_event_id AND user_id=owner_id FOR UPDATE;
    SELECT * INTO p FROM public.posts WHERE event_id=p_event_id AND id=p_target_id FOR UPDATE;
    IF p_operation='delete_own' AND p.status='deleted' THEN RETURN jsonb_build_object('code','ok'); END IF;
    IF p_operation IN ('hide','restore','delete','retry','reassign_theme') AND p.version<>(p_input->>'expected_version')::bigint THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
    IF p_operation='report' THEN
      IF p.status NOT IN ('published','published_flagged','hidden') THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
      IF EXISTS(SELECT 1 FROM public.reports WHERE event_id=p_event_id AND post_id=p.id AND reporter_id=p_user_id) THEN RETURN jsonb_build_object('code','ok'); END IF;
      IF (SELECT count(*) FROM public.reports WHERE event_id=p_event_id AND reporter_id=p_user_id AND created_at>observed_at-interval '1 minute')>=10 THEN RETURN jsonb_build_object('code','RATE_LIMITED'); END IF;
      INSERT INTO public.reports(event_id,post_id,reporter_id,reason,detail) VALUES(p_event_id,p.id,p_user_id,reason,coalesce(p_input->>'detail','')) RETURNING id INTO inserted_id;
      UPDATE public.posts SET report_count=report_count+1,previous_public_status=CASE WHEN status IN ('published','published_flagged') THEN status ELSE previous_public_status END,
        hidden_reason=CASE WHEN status<>'hidden' THEN 'report' ELSE hidden_reason END,status='hidden',version=version+1,updated_at=observed_at WHERE id=p.id;
      INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'revoke_delivery','report:'||inserted_id,jsonb_build_object('post_version',p.version+1));
      IF p.report_count<2 THEN
        INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'notify','report-notify:'||inserted_id,jsonb_build_object('category','report','report_count',p.report_count+1));
      END IF;
    ELSIF p_operation='hide' THEN
      IF p.status='hidden' THEN RETURN jsonb_build_object('code','ok'); END IF;
      IF p.status NOT IN ('published','published_flagged') THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
      UPDATE public.posts SET status='hidden',previous_public_status=status,hidden_reason='moderator',version=version+1,updated_at=observed_at WHERE id=p.id;
      INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'revoke_delivery','hide:'||p.id||':'||(p.version+1),jsonb_build_object('post_version',p.version+1));
    ELSIF p_operation='restore' THEN
      IF p.status<>'hidden' OR p.previous_public_status IS NULL OR p.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
      IF owner_row.is_banned THEN RETURN jsonb_build_object('code','ACCOUNT_BANNED'); END IF;
      IF p.ban_latched AND m.role<>'admin' THEN RETURN jsonb_build_object('code','FORBIDDEN'); END IF;
      IF s.publication_stopped THEN RETURN jsonb_build_object('code','PUBLICATION_STOPPED'); END IF;
      IF e.status NOT IN ('live','archive') OR observed_at<e.starts_at OR observed_at>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
      PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id AND terms_version=e.terms_version FOR SHARE;
      IF NOT FOUND THEN RETURN jsonb_build_object('code','CONSENT_REQUIRED'); END IF;
      IF (p.previous_public_status='published' AND p.moderation_verdict IS DISTINCT FROM 'PASS')
        OR (p.previous_public_status='published_flagged' AND p.moderation_verdict IS DISTINCT FROM 'FLAG') THEN RETURN jsonb_build_object('code','PROCESSING_HELD'); END IF;
      PERFORM id FROM public.media_assets WHERE event_id=p_event_id AND post_id=p.id ORDER BY id FOR SHARE;
      IF p.kind='photo' AND (SELECT count(*) FROM public.media_assets WHERE event_id=p_event_id AND post_id=p.id AND purpose LIKE 'delivery_%'
        AND provider='r2_delivery' AND byte_size>0 AND sha256 IS NOT NULL AND pixel_width>0 AND pixel_height>0 AND deletion_requested_at IS NULL AND physically_deleted_at IS NULL)<>4 THEN RETURN jsonb_build_object('code','PROCESSING_HELD'); END IF;
      IF p.kind='video' AND (p.measured_duration_seconds IS NULL OR p.measured_duration_seconds>4 OR NOT EXISTS(SELECT 1 FROM public.media_assets
        WHERE event_id=p_event_id AND post_id=p.id AND provider='stream' AND purpose=CASE WHEN p.original_scope='full_video_fallback' THEN 'stream_clip' ELSE 'stream_source' END
        AND stream_ready_to_stream AND stream_processing_complete AND stream_require_signed_urls AND stream_duration_seconds>0 AND stream_duration_seconds<=4
        AND stream_duration_seconds=p.measured_duration_seconds
        AND deletion_requested_at IS NULL AND physically_deleted_at IS NULL)) THEN RETURN jsonb_build_object('code','PROCESSING_HELD'); END IF;
      -- Asset lock waits must not carry a restoration across the event's private boundary.
      IF clock_timestamp()>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
      UPDATE public.posts SET status=previous_public_status,ban_latched=false,hidden_reason=NULL,previous_public_status=NULL,version=version+1,updated_at=observed_at WHERE id=p.id;
    ELSIF p_operation IN ('delete','delete_own') THEN
      IF p.status='deleted' THEN RETURN jsonb_build_object('code','ok'); END IF;
      UPDATE public.posts SET status='deleted',deleted_at=observed_at,version=version+1,updated_at=observed_at WHERE id=p.id;
      INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'revoke_delivery','delete:'||p.id||':'||(p.version+1),jsonb_build_object('post_version',p.version+1));
      FOR a IN SELECT * FROM public.media_assets WHERE event_id=p_event_id AND post_id=p.id ORDER BY id FOR UPDATE LOOP
        UPDATE public.media_assets SET deletion_requested_at=coalesce(deletion_requested_at,observed_at) WHERE id=a.id;
        -- available_at is only earliest review time. NULL retention is UNKNOWN, not proof that no lock exists.
        -- A future physical-delete consumer must independently verify approved retention and provider locks.
        INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload,available_at)
          VALUES(p_event_id,p.id,'delete_assets','delete-asset:'||a.id,jsonb_build_object('asset_id',a.id,'post_version',p.version+1),
            CASE WHEN a.provider='r2_original' THEN greatest(observed_at,coalesce(a.retention_until,observed_at)) ELSE observed_at END) ON CONFLICT(event_id,deduplication_key) DO NOTHING;
      END LOOP;
    ELSIF p_operation='reassign_theme' THEN
      -- Do not advance the post generation while an upload/processing job still owns it.
      IF p.status IN ('uploading','uploaded','processing','deleted') THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
      IF requested_theme_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.themes WHERE event_id=p_event_id AND id=requested_theme_id) THEN RETURN jsonb_build_object('code','THEME_UNAVAILABLE'); END IF;
      UPDATE public.posts SET theme_id=requested_theme_id,version=version+1,updated_at=observed_at WHERE id=p.id;
    ELSIF p_operation='retry' THEN
      IF p.status NOT IN ('held','blocked') THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
      -- Explicit admin retry after unban may clear only this blocked/held post's latch.
      -- The member BAN and every other publication/consent/original guard remain mandatory.
      IF owner_row.is_banned THEN RETURN jsonb_build_object('code','ACCOUNT_BANNED'); END IF;
      IF s.publication_stopped THEN RETURN jsonb_build_object('code','PUBLICATION_STOPPED'); END IF;
      IF e.status<>'live' OR NOT s.uploads_enabled OR observed_at<e.starts_at OR observed_at>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
      PERFORM 1 FROM public.consents WHERE event_id=p_event_id AND user_id=owner_id AND terms_version=e.terms_version FOR SHARE;
      IF NOT FOUND THEN RETURN jsonb_build_object('code','CONSENT_REQUIRED'); END IF;
      SELECT * INTO a FROM public.media_assets WHERE event_id=p_event_id AND post_id=p.id AND purpose='original' FOR UPDATE;
      IF NOT FOUND OR a.deletion_requested_at IS NOT NULL OR a.physically_deleted_at IS NOT NULL OR a.byte_size IS DISTINCT FROM p.original_bytes
        OR a.byte_size IS NULL OR a.object_etag IS NULL OR a.object_version IS NULL THEN RETURN jsonb_build_object('code','STATE_CONFLICT'); END IF;
      IF clock_timestamp()>=e.private_at THEN RETURN jsonb_build_object('code','EVENT_CLOSED'); END IF;
      UPDATE public.posts SET status='processing',ban_latched=false,moderation_verdict=NULL,processing_error=NULL,block_category=NULL,version=version+1,updated_at=observed_at WHERE id=p.id;
      UPDATE public.outbox_jobs SET completed_at=observed_at,locked_until=NULL WHERE event_id=p_event_id AND post_id=p.id AND kind='process_media' AND completed_at IS NULL;
      INSERT INTO public.outbox_jobs(event_id,post_id,kind,deduplication_key,payload) VALUES(p_event_id,p.id,'process_media','retry:'||p.id||':'||(p.version+1),
        jsonb_build_object('asset_id',a.id,'post_version',p.version+1,'object_version',a.object_version,'object_etag',a.object_etag));
    END IF;
    -- Recompute rather than underflow a legacy counter; locks prevent concurrent publication for this owner.
    UPDATE public.event_members SET published_post_count=(SELECT count(*) FROM public.posts WHERE event_id=p_event_id AND user_id=owner_id AND status IN ('published','published_flagged'))
      WHERE event_id=p_event_id AND user_id=owner_id;
  END IF;
  INSERT INTO public.audit_logs(event_id,actor_id,action,target_id,request_id,metadata) VALUES(p_event_id,p_user_id,p_operation,p_target_id,p_request_id,
    CASE WHEN reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason',reason) END);
  RETURN jsonb_build_object('code','ok');
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
  -- A malformed direct service call rolls back this function's entire mutation block.
  RETURN jsonb_build_object('code','INVALID_INPUT');
END;
$$;
REVOKE ALL ON FUNCTION public.stage_three_operation(uuid,uuid,text,uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stage_three_operation(uuid,uuid,text,uuid,jsonb,uuid) TO service_role;
COMMENT ON FUNCTION public.stage_three_operation(uuid,uuid,text,uuid,jsonb,uuid) IS 'Google/CSRF verified API only. Atomic stage 3 authorization, audit and outbox. No external IO, original URLs, direct publication approval or threshold calibration approval.';
NOTIFY pgrst,'reload schema';
COMMIT;
