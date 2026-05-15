-- GlassDesk — initial schema
-- Run once on a fresh Supabase project: supabase db push

-- ============================================================
-- bridge_agents – tracks paired CLI bridge devices
-- ============================================================
CREATE TABLE public.bridge_agents (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             uuid        REFERENCES auth.users(id),
  pairing_code         text,
  pairing_expires_at   timestamptz,
  pairing_metadata     jsonb,
  poll_token           uuid,
  status               text        DEFAULT 'offline',
  last_seen_at         timestamptz,
  agent_type           text        NOT NULL DEFAULT 'claude',
  name                 text,
  device_email         text,
  device_password_hash text,
  device_user_id       uuid        REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Enforce one active (unclaimed) pairing code at a time
CREATE UNIQUE INDEX idx_active_pairing_code
  ON public.bridge_agents (pairing_code)
  WHERE pairing_code IS NOT NULL AND owner_id IS NULL;

ALTER TABLE public.bridge_agents ENABLE ROW LEVEL SECURITY;

-- Owners and glasses device users (with owner_id in app_metadata) can SELECT
CREATE POLICY "Owner and device can read bridge_agents"
  ON public.bridge_agents FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR owner_id = (auth.jwt()->'app_metadata'->>'owner_id')::uuid
  );

-- ============================================================
-- glasses_tokens – device code flow for Meta Web App auth
-- ============================================================
CREATE TABLE public.glasses_tokens (
  code       text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

ALTER TABLE public.glasses_tokens ENABLE ROW LEVEL SECURITY;
-- Only accessed via service role in edge functions; deny all direct access.

-- ============================================================
-- rate_limits – sliding-window rate limiting for edge functions
-- ============================================================
CREATE TABLE public.rate_limits (
  key           text        NOT NULL,
  window_start  timestamptz NOT NULL DEFAULT now(),
  request_count int         NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX idx_rate_limits_key_window
  ON public.rate_limits (key, window_start DESC);

-- ============================================================
-- check_rate_limit() – returns true if under the limit
-- ============================================================
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key            text,
  p_window_seconds int DEFAULT 60,
  p_max_requests   int DEFAULT 30
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_window_start timestamptz;
  v_count        int;
BEGIN
  v_window_start := date_trunc('second', now())
    - ((EXTRACT(EPOCH FROM now())::int % p_window_seconds) * interval '1 second');

  DELETE FROM rate_limits
    WHERE window_start < now() - (p_window_seconds * 2) * interval '1 second';

  INSERT INTO rate_limits (key, window_start, request_count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (key, window_start)
  DO UPDATE SET request_count = rate_limits.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_max_requests;
END;
$$;
