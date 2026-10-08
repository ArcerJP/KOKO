-- Private admin invalidation only. Real Realtime settings/activation require separate acceptance.
BEGIN;
ALTER TABLE public.event_settings ADD COLUMN admin_realtime_enabled boolean NOT NULL DEFAULT false;

CREATE FUNCTION koko_private.can_receive_admin_invalidation(p_topic text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE claims jsonb; scoped_event uuid;
BEGIN
  IF p_topic IS NULL OR p_topic !~ '^koko:admin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  claims:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
  IF claims->>'role' IS DISTINCT FROM 'authenticated'
    OR claims->'is_anonymous' IS DISTINCT FROM 'false'::jsonb
    OR claims#>>'{app_metadata,provider}' IS DISTINCT FROM 'google'
    OR claims#>'{app_metadata,providers}' IS DISTINCT FROM '["google"]'::jsonb
    OR claims->>'sub' IS DISTINCT FROM auth.uid()::text THEN RETURN false; END IF;
  scoped_event:=substring(p_topic from 12)::uuid;
  RETURN EXISTS (SELECT 1 FROM public.event_members m
    JOIN public.events e ON e.event_id=m.event_id
    JOIN public.event_settings s ON s.event_id=e.event_id
    JOIN public.consents c ON c.event_id=m.event_id AND c.user_id=m.user_id AND c.terms_version=e.terms_version
    WHERE m.event_id=scoped_event AND m.user_id=auth.uid() AND m.role IN ('admin','moderator')
      AND NOT m.is_banned AND s.admin_realtime_enabled AND btrim(e.terms_version)<>'');
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION koko_private.can_receive_admin_invalidation(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION koko_private.can_receive_admin_invalidation(text) TO authenticated;

DO $$ BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN
    RAISE NOTICE 'KOKO_ADMIN_REALTIME_UNAVAILABLE: local SQL-only environment; activation requires real Realtime acceptance';
  ELSE
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='realtime.messages'::regclass)
      OR to_regprocedure('realtime.topic()') IS NULL OR to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN
      RAISE EXCEPTION 'KOKO_ADMIN_REALTIME_PREFLIGHT_FAILED';
    END IF;
    -- Do not ALTER a Supabase-owned table, grant public.posts SELECT, or replace unrelated policies.
    EXECUTE $policy$ CREATE POLICY koko_admin_invalidation_read ON realtime.messages FOR SELECT TO authenticated
      USING (extension='broadcast' AND topic=realtime.topic() AND koko_private.can_receive_admin_invalidation(realtime.topic())) $policy$;
    -- A pre-existing permissive policy cannot widen the KOKO namespace.
    EXECUTE $policy$ CREATE POLICY koko_admin_invalidation_read_guard ON realtime.messages AS RESTRICTIVE FOR SELECT TO authenticated
      USING (CASE WHEN coalesce(topic,'') LIKE 'koko:%' OR coalesce(realtime.topic(),'') LIKE 'koko:%'
        THEN extension='broadcast' AND topic=realtime.topic() AND koko_private.can_receive_admin_invalidation(realtime.topic()) ELSE true END) $policy$;
    -- anon must not need USAGE on koko_private just to evaluate a denied namespace.
    EXECUTE $policy$ CREATE POLICY koko_admin_invalidation_anon_read_guard ON realtime.messages AS RESTRICTIVE FOR SELECT TO anon
      USING (coalesce(topic,'') NOT LIKE 'koko:%' AND coalesce(realtime.topic(),'') NOT LIKE 'koko:%') $policy$;
    EXECUTE $policy$ CREATE POLICY koko_admin_invalidation_write_guard ON realtime.messages AS RESTRICTIVE FOR INSERT TO anon,authenticated
      WITH CHECK (coalesce(topic,'') NOT LIKE 'koko:%' AND coalesce(realtime.topic(),'') NOT LIKE 'koko:%') $policy$;
  END IF;
END $$;

CREATE FUNCTION koko_private.broadcast_admin_invalidation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE scoped_event uuid;
BEGIN
  scoped_event:=CASE WHEN TG_OP='DELETE' THEN OLD.event_id ELSE NEW.event_id END;
  IF EXISTS (SELECT 1 FROM public.event_settings WHERE event_id=scoped_event AND admin_realtime_enabled)
    AND to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL THEN
    -- No NEW/OLD, post/user IDs, reason, OCR, asset keys or URLs in Broadcast.
    EXECUTE 'SELECT realtime.send($1,$2,$3,$4)'
      USING '{"changed":true}'::jsonb,'invalidate'::text,'koko:admin:'||scoped_event::text,true;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Realtime is an advisory invalidation, never a prerequisite for a BAN/hide/stop.
  RAISE WARNING 'KOKO_ADMIN_REALTIME_SEND_FAILED';
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION koko_private.broadcast_admin_invalidation() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['posts','reports','appeals','themes','event_settings','event_members','events'] LOOP
    EXECUTE format('CREATE TRIGGER koko_admin_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION koko_private.broadcast_admin_invalidation()',target);
  END LOOP;
END $$;
COMMENT ON FUNCTION koko_private.broadcast_admin_invalidation() IS 'Advisory private broadcast only; cached Realtime authorization is not per-message revocation. All data reads/mutations must re-authorize through API.';
NOTIFY pgrst,'reload schema';
COMMIT;
