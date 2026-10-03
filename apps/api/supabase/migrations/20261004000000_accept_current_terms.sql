-- B1-4: reviewed migration must be applied separately; no terms or members are seeded.
BEGIN;

CREATE FUNCTION public.accept_current_terms(
  p_event_id uuid,
  p_user_id uuid,
  p_terms_version text
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  current_version text;
BEGIN
  -- Serialize version changes with acceptance, without serializing all readers.
  SELECT terms_version INTO current_version
  FROM public.events WHERE event_id = p_event_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'forbidden';
  END IF;

  -- Recheck membership inside the write transaction, not only in the Worker.
  PERFORM 1 FROM public.event_members
  WHERE event_id = p_event_id AND user_id = p_user_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN 'forbidden';
  END IF;

  IF p_terms_version IS NULL OR btrim(p_terms_version) = ''
    OR p_terms_version IS DISTINCT FROM current_version THEN
    RETURN 'terms_mismatch';
  END IF;

  -- The DB supplies accepted_at; retrying must not rewrite the original evidence.
  INSERT INTO public.consents (event_id, user_id, terms_version)
  VALUES (p_event_id, p_user_id, p_terms_version)
  ON CONFLICT (event_id, user_id, terms_version) DO NOTHING;
  RETURN 'accepted';
END;
$$;

REVOKE ALL ON FUNCTION public.accept_current_terms(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_current_terms(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.accept_current_terms(uuid, uuid, text) IS 'Worker-only: Google identity verified by API; atomic current-terms acceptance, first DB timestamp retained.';

NOTIFY pgrst, 'reload schema';
COMMIT;
