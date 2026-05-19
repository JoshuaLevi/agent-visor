# ADR-001: Remove authentication layer — single-user, own-Supabase model

**Status:** Accepted  
**Date:** 2025-05-18  
**Authors:** Joshua, Claude

---

## Context

AgentVisor was built by adapting the Agent Center (Spectacles sample project), which is a **multi-tenant** platform. It had a full authentication layer:

- Supabase `auth.users` accounts for each user
- Device code flow (`create_glasses_token` / `redeem_glasses_token`) to provision a separate "glasses device" user account
- Pairing codes (`register_bridge` / `poll_bridge` / `pair_bridge`) to link the bridge CLI to a user account
- RLS policies that isolated one user's agents from another's
- 8 edge functions handling auth, pairing, heartbeats, naming, and unpairing
- `setup.html` as a desktop login page
- 6-digit digit picker on the glasses for code entry

All of this complexity existed to support **multiple users sharing one Supabase project**.

---

## Decision

**AgentVisor is a single-user, bring-your-own-Supabase project.**

Each user:
1. Creates their own Supabase project (free tier)
2. Runs their own bridge on their Mac
3. Deploys their own webapp instance to Vercel
4. Adds that URL to the Meta AI app

There is no shared backend. There is no other tenant whose data needs to be isolated from yours. **The anon key is the effective access credential** — anyone who has your Supabase URL and anon key can read your agents, which is acceptable because:

- The URL is not publicly listed anywhere
- The anon key is project-specific and non-guessable
- This is a personal productivity tool, not a public service

We therefore **removed the entire auth layer** and replaced every edge function call with a direct Supabase REST API call using the anon key.

---

## What changed

### Removed
| Component | Reason |
|-----------|--------|
| `supabase/functions/register_bridge` | Replaced by `POST /rest/v1/bridge_agents` |
| `supabase/functions/poll_bridge` | No polling needed — no pairing codes |
| `supabase/functions/pair_bridge` | No pairing needed |
| `supabase/functions/create_glasses_token` | No device code flow |
| `supabase/functions/redeem_glasses_token` | No device accounts |
| `supabase/functions/unpair_bridge` | Replaced by `DELETE /rest/v1/bridge_agents` |
| `supabase/functions/bridge_heartbeat` | Replaced by `PATCH /rest/v1/bridge_agents` |
| `supabase/functions/bridge_update_name` | Replaced by `PATCH /rest/v1/bridge_agents` |
| `webapp/setup.html` | No login needed |
| `glasses_tokens` DB table | No device code flow |
| `rate_limits` DB table | No edge functions to protect |
| `check_rate_limit` DB function | No edge functions to protect |
| `auth.users` device accounts | No device provisioning |
| `owner_id`, `pairing_code`, `poll_token`, etc. columns | All auth-related columns removed |
| Digit picker (6-digit code entry on glasses) | No code entry needed |
| Session tokens in `localStorage` | No auth session |

### Simplified
| Component | Before | After |
|-----------|--------|-------|
| `bridge_agents` schema | 12 columns, 3 FK references to `auth.users` | 5 columns, no FK |
| RLS policy | `owner_id = auth.uid()` | `FOR ALL TO anon USING (true)` |
| Bridge startup | `supabase.auth.signInWithPassword()` | `createClient(url, anonKey)` — no sign-in |
| Agent registration | `register_bridge` edge function + pairing flow | `POST /rest/v1/bridge_agents` |
| Heartbeat | `bridge_heartbeat` edge function | `PATCH /rest/v1/bridge_agents?id=eq.{id}` |
| Webapp boot | Check session → digit picker if missing | Load agents directly, no auth |
| Webapp Realtime | JWT Bearer token in WS join | Anon key in WS join |

### Unchanged
- `webapp/config.js` pattern (users fill in their own Supabase URL + anon key)
- Realtime broadcast channels (`bridge:{agentId}:main`) for permission flow
- Permission overlay UX (Enter = allow, Escape = deny)
- Neural Band keyboard navigation
- Bridge CLI driver system (`claude-cli.js`, `codex-cli.js`)
- Local agent state in `~/.agentvisor_agents.json`
- Local conversation SQLite DB in `~/.bridge-data/`

---

## Consequences

**Positive:**
- Setup is dramatically simpler: 3 steps instead of 6 (no edge functions to deploy)
- No `setup.html` or device code entry on the glasses — app opens directly
- Codebase is ~400 lines smaller
- No orphaned `auth.users` device accounts left in the database
- Tests require no user accounts or session management

**Negative / trade-offs:**
- Anyone who discovers your Supabase URL + anon key can read your agent status and approve/deny permissions. Mitigation: keep your Vercel deployment URL private; the anon key is not guessable from the URL alone.
- No multi-user support. This is intentional — use the original Agent Center (Spectacles) if you need that.

---

## Migration path for existing installations

Run `supabase/migrations/20250518000000_no_auth.sql` against your project (Supabase Dashboard → SQL Editor). This drops and recreates `bridge_agents` with the new schema. Existing paired agents will be lost — re-add them via `node bridge/sync.js → Add new agent`.
