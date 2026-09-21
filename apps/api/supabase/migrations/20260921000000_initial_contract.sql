-- K-01: 第0日の初期スキーマ。Supabaseへの適用はレビュー後、第1要件で行う。
BEGIN;

CREATE TYPE public.post_status AS ENUM (
  'uploading', 'upload_failed', 'uploaded', 'processing', 'published',
  'published_flagged', 'blocked', 'held', 'hidden', 'deleted'
);

CREATE TABLE public.events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'archive', 'private')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  archive_at timestamptz NOT NULL,
  private_at timestamptz NOT NULL,
  terms_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at AND ends_at <= archive_at AND archive_at <= private_at)
);

CREATE TABLE public.event_members (
  event_id uuid NOT NULL REFERENCES public.events(event_id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  is_banned boolean NOT NULL DEFAULT false,
  banned_at timestamptz,
  block_count integer NOT NULL DEFAULT 0 CHECK (block_count >= 0),
  published_post_count integer NOT NULL DEFAULT 0 CHECK (published_post_count >= 0),
  crown text NOT NULL DEFAULT 'none' CHECK (crown IN ('none', 'white', 'gold')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CHECK (NOT is_banned OR banned_at IS NOT NULL)
);

CREATE TABLE public.event_settings (
  event_id uuid PRIMARY KEY REFERENCES public.events(event_id),
  publication_stopped boolean NOT NULL DEFAULT true,
  uploads_enabled boolean NOT NULL DEFAULT false,
  settings_version bigint NOT NULL DEFAULT 1 CHECK (settings_version > 0),
  posts_per_minute integer NOT NULL DEFAULT 10 CHECK (posts_per_minute > 0),
  moderation_concurrency integer NOT NULL DEFAULT 1 CHECK (moderation_concurrency > 0),
  moderation_thresholds jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(moderation_thresholds) = 'array'),
  thresholds_approved boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.consents (
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  terms_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id, terms_version),
  FOREIGN KEY (event_id, user_id) REFERENCES public.event_members(event_id, user_id)
);

CREATE TABLE public.themes (
  event_id uuid NOT NULL REFERENCES public.events(event_id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '#4338ca' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'ended')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, id),
  CHECK (starts_at < ends_at)
);

CREATE TABLE public.posts (
  event_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  theme_id uuid,
  kind text NOT NULL CHECK (kind IN ('photo', 'video')),
  status public.post_status NOT NULL DEFAULT 'uploading',
  previous_public_status public.post_status CHECK (previous_public_status IN ('published', 'published_flagged')),
  hidden_reason text CHECK (hidden_reason IN ('report', 'moderator', 'ban')),
  ban_latched boolean NOT NULL DEFAULT false,
  client_request_id uuid NOT NULL,
  declared_content_type text NOT NULL,
  detected_content_type text,
  original_scope text NOT NULL CHECK (original_scope IN ('photo_file', 'client_trimmed', 'full_video_fallback')),
  original_bytes bigint CHECK (original_bytes > 0),
  measured_duration_seconds numeric CHECK (measured_duration_seconds > 0),
  moderation_verdict text CHECK (moderation_verdict IN ('PASS', 'FLAG', 'BLOCK', 'HELD')),
  block_category text,
  processing_error text,
  like_count integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  report_count integer NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  published_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, id),
  UNIQUE (event_id, user_id, client_request_id),
  UNIQUE (event_id, id, user_id),
  FOREIGN KEY (event_id, user_id) REFERENCES public.event_members(event_id, user_id),
  FOREIGN KEY (event_id, theme_id) REFERENCES public.themes(event_id, id),
  CHECK ((kind = 'photo' AND original_scope = 'photo_file') OR (kind = 'video' AND original_scope IN ('client_trimmed', 'full_video_fallback'))),
  CHECK (status NOT IN ('published', 'published_flagged') OR (moderation_verdict IS NOT NULL AND moderation_verdict IN ('PASS', 'FLAG') AND NOT ban_latched AND published_at IS NOT NULL)),
  CHECK (status != 'published' OR moderation_verdict = 'PASS'),
  CHECK (status != 'published_flagged' OR moderation_verdict = 'FLAG'),
  CHECK (kind != 'video' OR status NOT IN ('published', 'published_flagged') OR (measured_duration_seconds IS NOT NULL AND measured_duration_seconds <= 4.0)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (status != 'hidden' OR (previous_public_status IS NOT NULL AND hidden_reason IS NOT NULL))
);

CREATE TABLE public.media_assets (
  event_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('original', 'delivery_600_webp', 'delivery_600_jpg', 'delivery_1600_webp', 'delivery_1600_jpg', 'stream_source', 'stream_clip')),
  provider text NOT NULL CHECK (provider IN ('r2_original', 'r2_delivery', 'stream')),
  object_key text,
  stream_uid text,
  byte_size bigint CHECK (byte_size > 0),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  retention_until timestamptz,
  deletion_requested_at timestamptz,
  physically_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, id),
  UNIQUE (event_id, id, post_id),
  UNIQUE (event_id, post_id, purpose),
  UNIQUE (provider, object_key),
  UNIQUE (stream_uid),
  FOREIGN KEY (event_id, post_id) REFERENCES public.posts(event_id, id),
  CHECK ((provider = 'stream' AND object_key IS NULL AND stream_uid IS NOT NULL AND stream_uid ~ '^[a-zA-Z0-9_-]+$') OR (provider != 'stream' AND stream_uid IS NULL AND object_key IS NOT NULL AND object_key NOT LIKE '%://%' AND position('..' IN object_key) = 0)),
  CHECK ((purpose = 'original' AND provider = 'r2_original') OR (purpose LIKE 'delivery_%' AND provider = 'r2_delivery') OR (purpose IN ('stream_source', 'stream_clip') AND provider = 'stream')),
  CHECK (object_key IS NULL OR object_key LIKE 'events/' || event_id::text || '/%'),
  CHECK (purpose != 'original' OR object_key = 'events/' || event_id::text || '/posts/' || post_id::text || '/original/' || id::text || '.bin'),
  CHECK (purpose NOT LIKE 'delivery_%' OR object_key = 'events/' || event_id::text || '/delivery/' || id::text || '/' || split_part(purpose, '_', 2) || '.' || split_part(purpose, '_', 3))
);

CREATE TABLE public.upload_sessions (
  event_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('single', 'multipart')),
  provider_upload_id text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, id),
  FOREIGN KEY (event_id, post_id) REFERENCES public.posts(event_id, id),
  FOREIGN KEY (event_id, asset_id, post_id) REFERENCES public.media_assets(event_id, id, post_id),
  CHECK (mode != 'multipart' OR provider_upload_id IS NOT NULL)
);

CREATE TABLE public.moderation_runs (
  event_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  engine text NOT NULL CHECK (engine IN ('openai', 'safesearch', 'ocr')),
  model_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('PASS', 'FLAG', 'BLOCK', 'ERROR')),
  scores jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scores) = 'object'),
  latency_ms integer CHECK (latency_ms >= 0),
  estimated_cost_usd numeric CHECK (estimated_cost_usd >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, post_id, attempt, engine),
  FOREIGN KEY (event_id, post_id) REFERENCES public.posts(event_id, id)
);

CREATE TABLE public.reports (
  event_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  reporter_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('privacy', 'sexual', 'violence', 'harassment', 'other')),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, post_id, reporter_id),
  FOREIGN KEY (event_id, post_id) REFERENCES public.posts(event_id, id),
  FOREIGN KEY (event_id, reporter_id) REFERENCES public.event_members(event_id, user_id)
);

CREATE TABLE public.appeals (
  event_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  post_id uuid,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (event_id, user_id) REFERENCES public.event_members(event_id, user_id),
  FOREIGN KEY (event_id, post_id, user_id) REFERENCES public.posts(event_id, id, user_id)
);

-- 第4要件の器だけを第0日に用意。更新とcounterの原子処理は第4要件で実装。
CREATE TABLE public.likes (
  event_id uuid NOT NULL,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, post_id, user_id),
  FOREIGN KEY (event_id, post_id) REFERENCES public.posts(event_id, id),
  FOREIGN KEY (event_id, user_id) REFERENCES public.event_members(event_id, user_id)
);

CREATE TABLE public.audit_logs (
  event_id uuid NOT NULL REFERENCES public.events(event_id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  target_id uuid,
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, actor_id) REFERENCES public.event_members(event_id, user_id)
);

-- 状態変更と外部処理の登録を同一transactionに。外部通知自体はcommit後。
CREATE TABLE public.outbox_jobs (
  event_id uuid NOT NULL REFERENCES public.events(event_id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid,
  kind text NOT NULL CHECK (kind IN ('process_media', 'revoke_delivery', 'delete_assets', 'notify', 'export')),
  deduplication_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, deduplication_key),
  FOREIGN KEY (event_id, post_id) REFERENCES public.posts(event_id, id)
);

CREATE INDEX posts_feed ON public.posts (event_id, status, created_at DESC, id DESC);
CREATE INDEX posts_theme_feed ON public.posts (event_id, theme_id, status, created_at DESC, id DESC);
CREATE INDEX posts_owner ON public.posts (event_id, user_id, created_at DESC, id DESC);
CREATE INDEX themes_window ON public.themes (event_id, status, starts_at, ends_at);
CREATE INDEX moderation_post ON public.moderation_runs (event_id, post_id, created_at DESC);
CREATE INDEX appeals_queue ON public.appeals (event_id, status, created_at DESC, id DESC);
CREATE INDEX outbox_pending ON public.outbox_jobs (event_id, available_at, id) WHERE completed_at IS NULL;
CREATE INDEX audit_event ON public.audit_logs (event_id, created_at DESC, id DESC);
CREATE INDEX likes_owner ON public.likes (event_id, user_id, created_at DESC, post_id DESC);

CREATE SCHEMA koko_private;
REVOKE ALL ON SCHEMA koko_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA koko_private TO authenticated, service_role;

-- 自分の所属だけを確認。利用者指定user_idを引数にせず、再帰RLSを避ける。
CREATE FUNCTION koko_private.is_member(target_event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_members m WHERE m.event_id = target_event AND m.user_id = (SELECT auth.uid()));
$$;
REVOKE ALL ON FUNCTION koko_private.is_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION koko_private.is_member(uuid) TO authenticated, service_role;

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.events, public.event_members, public.event_settings, public.consents,
  public.themes, public.posts, public.media_assets, public.upload_sessions,
  public.moderation_runs, public.reports, public.appeals, public.likes,
  public.audit_logs, public.outbox_jobs FROM anon, authenticated;
GRANT ALL ON public.events, public.event_members, public.event_settings, public.consents,
  public.themes, public.posts, public.media_assets, public.upload_sessions,
  public.moderation_runs, public.reports, public.appeals, public.likes,
  public.audit_logs, public.outbox_jobs TO service_role;
GRANT SELECT ON public.events, public.event_members, public.consents, public.themes,
  public.reports, public.appeals, public.likes TO authenticated;
-- 投稿のstatus APIと一覧はWorkers経由のみ。postsも直接読ませない。
CREATE POLICY events_member_read ON public.events FOR SELECT TO authenticated USING (koko_private.is_member(event_id));
CREATE POLICY members_self_read ON public.event_members FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY consents_self_read ON public.consents FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY themes_member_read ON public.themes FOR SELECT TO authenticated USING (status != 'draft' AND koko_private.is_member(event_id));
CREATE POLICY reports_self_read ON public.reports FOR SELECT TO authenticated USING (reporter_id = (SELECT auth.uid()));
CREATE POLICY appeals_self_read ON public.appeals FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY likes_self_read ON public.likes FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

COMMENT ON TABLE public.posts IS '状態・所有者・イベント・同意・BAN・公開停止の検証とcounter/outbox更新はWorkersのtransaction責務。service_roleはRLSをバイパスする。';
COMMENT ON TABLE public.media_assets IS 'URLではなくキー/UIDを保持。利用者には公開済み派生物のURLだけをAPIから返す。';
COMMENT ON TABLE public.moderation_runs IS '秘密や生の画像/OCR全文は保存しない。モデル・スコア・費用・レイテンシのみ。';

COMMIT;
