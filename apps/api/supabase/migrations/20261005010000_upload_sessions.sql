-- B1-5: local-only until separately reviewed/applied. No provider calls in SQL.
BEGIN;

ALTER TABLE public.upload_sessions
  DROP CONSTRAINT upload_sessions_check,
  ADD COLUMN provisioning_state text NOT NULL DEFAULT 'ready'
    CHECK (provisioning_state IN ('provisioning', 'ready')),
  ADD COLUMN provisioning_attempt uuid,
  ADD COLUMN provisioning_attempts integer NOT NULL DEFAULT 0 CHECK (provisioning_attempts BETWEEN 0 AND 3),
  ADD COLUMN provisioning_locked_until timestamptz CHECK (provisioning_locked_until IS NULL OR isfinite(provisioning_locked_until)),
  ADD CONSTRAINT upload_sessions_one_per_post UNIQUE (event_id, post_id),
  ADD CONSTRAINT upload_sessions_provider_state CHECK (
    (mode = 'single' AND provisioning_state = 'ready' AND provider_upload_id IS NULL)
    OR (mode = 'multipart' AND (
      (provisioning_state = 'provisioning' AND provider_upload_id IS NULL AND provisioning_attempt IS NOT NULL)
      OR (provisioning_state = 'ready' AND provider_upload_id IS NOT NULL)
    ))
  );

-- All transitions serialize through reserve_upload's member/post locks, then
-- the session lock. Never hold a DB transaction open across a provider call.
CREATE FUNCTION public.manage_upload_session(
  p_event_id uuid, p_user_id uuid, p_action text, p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  reservation jsonb;
  initial_request jsonb;
  session_row public.upload_sessions%ROWTYPE;
  supplied_id uuid;
  attempt_id uuid;
  provider_id text;
  expected_mode text;
  deadline timestamptz;
  event_end timestamptz;
  theme_end timestamptz;
  observed_at timestamptz;
  provisioning_deadline timestamptz;
  create_provider boolean := false;
BEGIN
  IF p_event_id IS NULL OR p_user_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('open', 'refresh', 'parts', 'attach')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('code', 'INVALID_INPUT');
  END IF;
  IF p_action = 'open' THEN
    IF NOT (p_input ?& ARRAY['request', 'attempt_id'])
      OR p_input - ARRAY['request', 'attempt_id'] <> '{}'::jsonb THEN
      RETURN jsonb_build_object('code', 'INVALID_INPUT');
    END IF;
    initial_request := p_input->'request';
  ELSE
    IF jsonb_typeof(p_input->'upload_id') IS DISTINCT FROM 'string'
      OR (p_input->>'upload_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (p_action <> 'attach' AND p_input - 'upload_id' <> '{}'::jsonb)
      OR (p_action = 'attach' AND (NOT (p_input ?& ARRAY['attempt_id', 'provider_upload_id'])
        OR p_input - ARRAY['upload_id', 'attempt_id', 'provider_upload_id'] <> '{}'::jsonb)) THEN
      RETURN jsonb_build_object('code', 'INVALID_INPUT');
    END IF;
    supplied_id := (p_input->>'upload_id')::uuid;
    -- Unlocked lookup only, to discover the immutable request. Ownership is scoped
    -- here and the mutable state is checked again AFTER the admission locks.
    SELECT p.upload_request INTO initial_request
    FROM public.upload_sessions s JOIN public.posts p ON p.event_id=s.event_id AND p.id=s.post_id
    WHERE s.event_id=p_event_id AND s.id=supplied_id AND p.user_id=p_user_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('code', 'NOT_FOUND'); END IF;
    IF initial_request IS NULL THEN RETURN jsonb_build_object('code', 'STATE_CONFLICT'); END IF;
  END IF;
  IF p_action IN ('open', 'attach') THEN
    IF jsonb_typeof(p_input->'attempt_id') IS DISTINCT FROM 'string'
      OR (p_input->>'attempt_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('code', 'INVALID_INPUT');
    END IF;
    attempt_id := (p_input->>'attempt_id')::uuid;
  END IF;
  IF p_action = 'attach' THEN
    IF jsonb_typeof(p_input->'provider_upload_id') IS DISTINCT FROM 'string'
      OR char_length(p_input->>'provider_upload_id') NOT BETWEEN 1 AND 2048
      OR (p_input->>'provider_upload_id') !~ '^[!-~]+$' THEN
      RETURN jsonb_build_object('code', 'INVALID_INPUT');
    END IF;
    provider_id := p_input->>'provider_upload_id';
  END IF;

  reservation := public.reserve_upload(p_event_id, p_user_id, initial_request);
  IF reservation->>'code' <> 'reserved' THEN RETURN reservation; END IF;
  expected_mode := CASE WHEN (reservation->'request'->>'file_size_bytes')::bigint <= 67108864
    THEN 'single' ELSE 'multipart' END;
  SELECT * INTO session_row FROM public.upload_sessions
  WHERE event_id=p_event_id AND post_id=(reservation->>'post_id')::uuid FOR UPDATE;

  SELECT ends_at INTO event_end FROM public.events WHERE event_id=p_event_id;
  SELECT ends_at INTO theme_end FROM public.themes
    WHERE event_id=p_event_id AND id=(reservation->'request'->>'theme_id')::uuid;
  deadline := date_trunc('second', least(clock_timestamp()+interval '15 minutes', event_end, theme_end));
  IF deadline <= clock_timestamp() THEN RETURN jsonb_build_object('code', 'EVENT_CLOSED'); END IF;
  observed_at := clock_timestamp();
  provisioning_deadline := least(observed_at+interval '2 minutes',deadline);

  IF session_row.id IS NULL THEN
    IF p_action <> 'open' THEN RETURN jsonb_build_object('code', 'NOT_FOUND'); END IF;
    create_provider := expected_mode = 'multipart';
    INSERT INTO public.upload_sessions(event_id,post_id,asset_id,mode,expires_at,provisioning_state,provisioning_attempt,provisioning_attempts,provisioning_locked_until)
    VALUES(p_event_id,(reservation->>'post_id')::uuid,(reservation->>'asset_id')::uuid,expected_mode,deadline,
      CASE WHEN create_provider THEN 'provisioning' ELSE 'ready' END,attempt_id,
      CASE WHEN create_provider THEN 1 ELSE 0 END,CASE WHEN create_provider THEN provisioning_deadline ELSE NULL END)
    RETURNING * INTO session_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload session was not inserted'; END IF;
  ELSE
    IF (supplied_id IS NOT NULL AND session_row.id <> supplied_id)
      OR session_row.asset_id <> (reservation->>'asset_id')::uuid
      OR session_row.mode <> expected_mode OR session_row.completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('code', 'STATE_CONFLICT');
    END IF;
    IF p_action = 'attach' THEN
      IF session_row.mode <> 'multipart' OR session_row.provisioning_attempt IS DISTINCT FROM attempt_id
        OR (session_row.provider_upload_id IS NOT NULL AND session_row.provider_upload_id <> provider_id)
        OR (session_row.provisioning_state='provisioning' AND (session_row.provisioning_attempts<1
          OR session_row.provisioning_locked_until IS NULL OR session_row.provisioning_locked_until<=observed_at)) THEN
        RETURN jsonb_build_object('code', 'STATE_CONFLICT');
      END IF;
      UPDATE public.upload_sessions SET provider_upload_id=provider_id, provisioning_state='ready', expires_at=deadline,provisioning_locked_until=NULL
        WHERE id=session_row.id RETURNING * INTO session_row;
      IF NOT FOUND THEN RAISE EXCEPTION 'Upload session was not attached'; END IF;
    ELSIF session_row.provisioning_state = 'provisioning' THEN
      -- A provider created by an expired generation may be orphaned, but never
      -- attached/ticketed later. Only a new explicit open gets one bounded retry.
      -- Legacy/unknown lease metadata stays closed; never infer a safe takeover.
      IF p_action<>'open' OR session_row.provisioning_attempt=attempt_id
        OR session_row.provisioning_attempts NOT BETWEEN 1 AND 2
        OR session_row.provisioning_locked_until IS NULL OR session_row.provisioning_locked_until>observed_at THEN
        RETURN jsonb_build_object('code', 'UPLOAD_INCOMPLETE');
      END IF;
      UPDATE public.upload_sessions SET provisioning_attempt=attempt_id,provisioning_attempts=provisioning_attempts+1,
        provisioning_locked_until=provisioning_deadline,expires_at=deadline
        WHERE id=session_row.id RETURNING * INTO session_row;
      IF NOT FOUND THEN RAISE EXCEPTION 'Upload session was not reclaimed'; END IF;
      create_provider:=true;
    ELSIF p_action IN ('open', 'refresh') THEN
      UPDATE public.upload_sessions SET expires_at=deadline WHERE id=session_row.id RETURNING * INTO session_row;
      IF NOT FOUND THEN RAISE EXCEPTION 'Upload session was not refreshed'; END IF;
    END IF;
  END IF;
  IF p_action = 'parts' THEN
    IF session_row.mode <> 'multipart' THEN RETURN jsonb_build_object('code', 'STATE_CONFLICT'); END IF;
    IF session_row.expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('code', 'UPLOAD_EXPIRED'); END IF;
  END IF;
  -- The latest event/theme end also bounds an unchanged parts ticket.
  RETURN reservation || jsonb_build_object(
    'code', CASE WHEN create_provider THEN 'provision' ELSE 'ready' END,
    'upload_id', session_row.id, 'mode', session_row.mode,
    'expires_at', least(session_row.expires_at, deadline),
    'provider_upload_id', session_row.provider_upload_id)
    || CASE WHEN create_provider THEN jsonb_build_object('provisioning_attempt',session_row.provisioning_attempt,
      'provisioning_locked_until',session_row.provisioning_locked_until) ELSE '{}'::jsonb END;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_upload_session(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_upload_session(uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.manage_upload_session(uuid,uuid,text,jsonb) IS 'Worker-only after Google/CSRF. Provisioning uses a 120s lease and at most 3 create claims. Only a new open can reclaim an expired unknown generation; ready provider is immutable. Never return this internal result to a client.';
NOTIFY pgrst, 'reload schema';
COMMIT;
