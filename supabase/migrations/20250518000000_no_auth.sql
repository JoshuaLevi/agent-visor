-- AgentVisor — simplified schema (no auth, single-user)
--
-- ADR: docs/adr-001-no-auth.md explains why the original auth layer was removed.
--
-- Run on a fresh project:  supabase db push
-- Upgrade existing project: apply this file in the SQL editor

-- ── Drop old auth-heavy tables ────────────────────────────────────────────────
DROP TABLE IF EXISTS public.glasses_tokens  CASCADE;
DROP TABLE IF EXISTS public.rate_limits     CASCADE;
DROP TABLE IF EXISTS public.bridge_agents   CASCADE;
DROP FUNCTION IF EXISTS check_rate_limit;

-- ── bridge_agents — one row per registered CLI agent ─────────────────────────
CREATE TABLE public.bridge_agents (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL    DEFAULT 'My Agent',
  agent_type   text        NOT NULL    DEFAULT 'claude',
  status       text        NOT NULL    DEFAULT 'offline',
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL    DEFAULT now()
);

-- Allow full access via the anon key — this is a single-user project.
-- Each user deploys their own Supabase project, so there is no other tenant
-- whose data needs to be isolated.  The anon key in config.js is the effective
-- access credential.
ALTER TABLE public.bridge_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon full access"
  ON public.bridge_agents
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- Enable Realtime so the glasses webapp receives live status updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.bridge_agents;
