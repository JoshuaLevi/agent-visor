# AgentVisor

Monitor your AI coding agents (Claude Code, Codex) directly on your Meta Ray-Ban Display glasses. Approve or deny tool permissions hands-free using the Neural Band.

---

## Quick start overview

```
1. Create a Supabase project  →  run the SQL migration (one file, no edge functions)
2. Fill in webapp/config.js   →  deploy to Vercel (HTTPS)
3. iPhone: Meta AI app → Developer Mode → App Connections → add your Vercel URL
4. Put on glasses → AgentVisor opens directly, no login or code entry needed
5. Mac: cd bridge && npm install && node sync.js → add an agent → activate it
6. Glasses show your agent live — approve permissions with the Neural Band
```

Steps 1–2 are one-time setup. Step 3 is what puts the app on your glasses. The app opens directly to the agent list — no accounts, no pairing codes.

---

## What it does

- **Agent Monitor** — see which agents are running, what they're doing, and their current status in real time
- **Permission Approval** — when an agent asks for permission to run a command, a notification appears on your glasses; press the Neural Band to allow or deny
- **Message Feed** — read agent output and activity without looking at your screen

---

## Requirements

**Hardware**
- Meta Ray-Ban Display glasses (software v125+)
- iPhone with Meta AI app v272+

**Software**
- Node.js 18+
- A [Supabase](https://supabase.com) account (free tier works)
- A [Vercel](https://vercel.com) account (free tier works) — or any static HTTPS host

---

## Architecture

```
Mac (Bridge CLI)  ──→  Supabase Realtime  ──→  Meta Glasses (Web App)
  Claude Code                                    600×600 display
  Codex CLI                                      Neural Band input
```

The **Bridge CLI** wraps your local agents and broadcasts their status to Supabase. The **Web App** runs on your glasses and subscribes to those updates in real time.

---

## Setup

### 1. Clone the repository

```bash
git clone <repo-url>
cd agentvisor
```

### 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. In the SQL editor, run the contents of `supabase/migrations/20250518000000_no_auth.sql`
3. Note your **Project URL** and **anon key** from Project Settings → API

No edge functions to deploy — everything uses the Supabase REST API directly.

### 3. Configure the webapp

Open `webapp/config.js` and fill in your Supabase project values:

```js
window.GLASSDESK_CONFIG = {
  supabaseUrl:  'https://your-project.supabase.co',
  supabaseAnon: 'your-anon-public-key',
};
```

Both values are on the **Supabase Dashboard → Project Settings → API** page. The anon key is safe to include in client-side code — it is intentionally public.

### 4. Deploy the webapp

```bash
cd webapp
npx vercel deploy --prod
```

Note the URL Vercel gives you, e.g. `https://agentvisor.vercel.app`.

### 5. Add the webapp to your glasses

Meta Web Apps are loaded onto the glasses through the **Meta AI app on your iPhone** — there is no app store or sideloading involved. Any HTTPS URL can be registered as an app.

1. Open the **Meta AI app** on your iPhone
2. Enable Developer Mode if needed: go to **Settings**, find the app version number, tap it **5 times** until you see "Developer Mode enabled"
3. Go to **Settings → Developer Mode → App Connections → Add**
4. Enter your Vercel URL (e.g. `https://agentvisor.vercel.app`)
5. Put on your glasses and open AgentVisor from the app launcher

The app will stay registered — you only need to add it once. If it doesn't appear, verify that your URL is HTTPS (plain HTTP is rejected).

### 6. Configure the Bridge CLI

```bash
cd bridge
cp .env.example .env
```

Edit `.env` and fill in your Supabase URL and anon key:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

Install dependencies:

```bash
npm install
```

---

## First-time use

### Add your first agent

Run the Bridge CLI on your Mac:

```bash
cd bridge
node sync.js
```

Select **Add new agent**, choose Claude Code or Codex, give it a name. The agent is registered in your Supabase project immediately — no pairing codes, no phone needed.

### Open on your glasses

Put on your glasses and open AgentVisor from the app launcher. The agent list appears straight away. No login screen, no code entry.

---

## Daily use

Start the bridge each time you want to use AgentVisor:

```bash
cd bridge
node sync.js
# → Select "Activate all agents"
```

Open AgentVisor on your glasses. You'll see your agents listed with live status indicators:

| Indicator | Meaning |
|-----------|---------|
| Green dot | Idle / ready |
| Yellow dot (animated) | Thinking, running a tool, or responding |
| Blue pulsing dot | **Waiting for your permission** |
| Grey dot | Offline |

### Approving permissions

When Claude Code or Codex wants to run a command that needs approval, AgentVisor shows a full-screen overlay on your glasses:

```
PERMISSION REQUEST

Claude Code — my-project

  Bash
  rm -rf node_modules && npm install

┌─────────────────┐  ┌─────────────────┐
│   Allow (Enter) │  │   Deny  (Esc)   │
└─────────────────┘  └─────────────────┘
```

- **Enter / tap Neural Band** — Allow
- **Escape / swipe back** — Deny

The bridge receives your response instantly and Claude continues (or stops).

### Stopping the bridge

Press `q` in the terminal or `Ctrl+C`. All agents go offline on the glasses automatically.

---

## Neural Band controls

| Action | Control |
|--------|---------|
| Navigate items | Swipe forward / backward |
| Select / confirm | Tap |
| Go back | Double tap or swipe back |

These map to `ArrowDown/Up`, `Enter`, and `Escape` in the web app.

---

## Project structure

```
agentvisor/
├── webapp/
│   ├── index.html        # Glasses app (600×600)
│   └── vercel.json
├── bridge/
│   ├── sync.js           # CLI entry point
│   ├── drivers/
│   │   ├── claude-cli.js # Claude Code integration
│   │   └── codex-cli.js  # Codex integration
│   ├── package.json
│   └── .env.example
├── supabase/
│   └── migrations/       # Database schema (single file, no edge functions)
└── docs/
    └── adr-001-no-auth.md  # Why the auth layer was removed
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| App not visible on glasses | Confirm your URL is HTTPS; verify it's added in Meta AI app → Settings → Developer Mode → App Connections |
| Developer Mode option not visible | Tap the version number in Meta AI app Settings exactly 5 times |
| Agent list empty on glasses | Run `node sync.js` on your Mac, add an agent, then activate it |
| Agent shows as offline | Activate the agent from `node sync.js` — it only goes online when the bridge is running |
| Permission overlay doesn't appear | Make sure `CLAUDE_SKIP_PERMISSIONS=false` in bridge `.env` |
| Realtime updates not arriving | Check that your Supabase project has Realtime enabled (Dashboard → Realtime) |
| Config missing error on glasses | You deployed before filling in `webapp/config.js` — add your Supabase values and redeploy |
| "Failed to connect" on glasses | Verify `supabaseUrl` and `supabaseAnon` in `config.js` are correct |

---

## Requirements recap

- Meta Ray-Ban Display glasses with software **v125+**
- Meta AI app **v272+**
- Developer Mode enabled in Meta AI app
- HTTPS hosting for the webapp
- Node.js 18+ for the bridge
