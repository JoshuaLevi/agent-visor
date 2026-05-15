# AgentVisor

Monitor your AI coding agents (Claude Code, Codex) directly on your Meta Ray-Ban Display glasses. Approve or deny tool permissions hands-free using the Neural Band.

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
2. In the SQL editor, run the contents of `supabase/migrations/20250515000000_init.sql`
3. In the Edge Functions section, deploy each function from `supabase/functions/` — or use the Supabase CLI:

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-id>
supabase functions deploy
```

4. Note your **Project URL** and **anon key** from Project Settings → API

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

1. Open the Meta AI app on your iPhone
2. Go to **Settings → Developer Mode** (tap version number 5× to enable if needed)
3. Go to **App Connections → Add**
4. Enter your Vercel URL
5. The app will now appear when you open it on your glasses

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

### Authenticate your glasses

Because the glasses browser has no keyboard, authentication uses a one-time 6-digit code:

1. Open `https://your-agentvisor-url/setup.html` in your **phone or desktop browser**
2. Sign in (or create an account — it happens automatically on first login)
3. A 6-digit code appears on screen with a 5-minute countdown

4. Put on your glasses and open AgentVisor from the Meta AI app
5. You'll see the **Enter Code** screen with a digit picker

   ```
   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
   │  8  │ │  4  │ │  7  │ │  2  │ │  9  │ │  1  │
   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘
   ```

   - **Up/Down** — change the selected digit
   - **Left/Right** — move between digits
   - **Enter (tap Neural Band)** — confirm

6. Once confirmed, your glasses are linked. The session is saved — you won't need to do this again unless you clear your browser data.

### Pair your first agent

Run the Bridge CLI on your Mac:

```bash
cd bridge
node sync.js
```

Select **Add new agent** and choose your agent type (Claude Code or Codex). A 6-digit pairing code appears in your terminal.

On your glasses, navigate to the agent list — the pairing prompt will appear automatically. Enter the code the same way you did during setup.

Your agent is now paired.

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
│   ├── setup.html        # Desktop/phone setup page
│   └── vercel.json
├── bridge/
│   ├── sync.js           # CLI entry point
│   ├── drivers/
│   │   ├── claude-cli.js # Claude Code integration
│   │   └── codex-cli.js  # Codex integration
│   ├── package.json
│   └── .env.example
└── supabase/
    ├── migrations/       # Database schema
    └── functions/        # Edge functions (8 total)
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| App not visible on glasses | Confirm HTTPS hosting and that the URL is added in Meta AI app → App Connections |
| "Invalid or expired code" on glasses | Code has 5-min TTL — generate a new one on the setup page |
| Agent shows as offline | Run `node sync.js` on your Mac and activate the agent |
| Permission overlay doesn't appear | Make sure `CLAUDE_SKIP_PERMISSIONS=false` in bridge `.env` |
| Realtime updates not arriving | Check that your Supabase project has Realtime enabled (Dashboard → Realtime) |

---

## Requirements recap

- Meta Ray-Ban Display glasses with software **v125+**
- Meta AI app **v272+**
- Developer Mode enabled in Meta AI app
- HTTPS hosting for the webapp
- Node.js 18+ for the bridge
