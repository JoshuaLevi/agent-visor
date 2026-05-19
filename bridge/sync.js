#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { platform, homedir } from "os";
import { join, dirname, resolve, basename } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import select, { Separator } from "@inquirer/select";
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import chalk from "chalk";
import dotenv from "dotenv";
import { localDb } from "./db.js";
import { Dashboard, formatDuration } from "./dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

// ── Config ──────────────────────────────────────────────────────────────────

const ENV_PATH              = join(__dirname, ".env");
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const AGENTS_FILE           = join(homedir(), ".agentvisor_agents.json");
const OLD_DEVICE_FILE       = join(__dirname, ".bridge_device.json");
const MCP_SERVER_PATH       = join(__dirname, "mcp-permission-server.js");
const AGENTVISOR_DIR        = join(homedir(), ".agentvisor");
const CLAUDE_PROJECTS_DIR   = join(homedir(), ".claude", "projects");

function checkEnv() {
  if (!existsSync(ENV_PATH)) {
    return chalk.red("  ✗ No .env file found. Create bridge/.env with SUPABASE_URL and SUPABASE_ANON_KEY.");
  }
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
  if (missing.length > 0) {
    return chalk.red(`  ✗ Missing values in .env: ${missing.join(", ")}`);
  }
  return null;
}
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_RETRY_DELAY_MS = 5_000;
const BRIDGE_PRESENCE_INTERVAL_MS = 5_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS  = 30_000;
const BROADCAST_MAX_RETRIES = 2;
const BROADCAST_RETRY_DELAY_MS = 500;
const CRITICAL_BROADCAST_EVENTS = new Set(["agent_message", "activity_state", "conversation_created", "user_message_ack", "conversations_response"]);

// ── Driver Registry ─────────────────────────────────────────────────────────

const DRIVER_MAP = {
  claude: { file: "claude-cli.js", label: "Claude Code CLI" },
  codex:  { file: "codex-cli.js",  label: "Codex CLI" },
};

function availableDrivers() {
  const driversDir = join(__dirname, "drivers");
  if (!existsSync(driversDir)) return [];
  return Object.entries(DRIVER_MAP).filter(([, info]) =>
    existsSync(join(driversDir, info.file))
  );
}

async function loadDriver(type) {
  const info = DRIVER_MAP[type];
  if (!info) throw new Error(`Unknown driver: ${type}`);
  const mod = await import(join(__dirname, "drivers", info.file));
  return mod.default;
}

// ── Active Session ───────────────────────────────────────────────────────────

let activeAgentSession = null; // { instances, dashboard } while agents are running

// ── Saved Agents Store ──────────────────────────────────────────────────────

function loadSavedAgents() {
  if (existsSync(AGENTS_FILE)) {
    return JSON.parse(readFileSync(AGENTS_FILE, "utf8"));
  }

  // Migrate from old single-agent format
  if (existsSync(OLD_DEVICE_FILE)) {
    const old = JSON.parse(readFileSync(OLD_DEVICE_FILE, "utf8"));
    const migrated = [{
      agent_id: old.agent_id,
      agent_type: old.agent_type ?? "claude",
      credentials: old.credentials,
    }];
    writeFileSync(AGENTS_FILE, JSON.stringify(migrated, null, 2));
    return migrated;
  }

  return [];
}

function saveAgents(agents) {
  writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

function addSavedAgent(entry) {
  const agents = loadSavedAgents();
  agents.push(entry);
  saveAgents(agents);
}

function removeSavedAgent(agentId) {
  const agents = loadSavedAgents().filter((a) => a.agent_id !== agentId);
  saveAgents(agents);
}

function updateSavedAgent(agentId, updates) {
  const agents = loadSavedAgents();
  const idx = agents.findIndex((a) => a.agent_id === agentId);
  if (idx === -1) return;
  agents[idx] = { ...agents[idx], ...updates };
  saveAgents(agents);
}

// ── Interactive Menu ────────────────────────────────────────────────────────

const GRID_COLS = 2;
const GRID_COL_WIDTH = 26;

function agentDisplayName(agent) {
  return agent.name ?? (DRIVER_MAP[agent.agent_type]?.label ?? agent.agent_type);
}

function interactiveMenu(agents, topActions, bottomActions, startRow, initialFocus = null) {
  const gridRows = [];
  for (let i = 0; i < agents.length; i += GRID_COLS) {
    gridRows.push(agents.slice(i, i + GRID_COLS));
  }

  const hasTop = topActions.length > 0;
  const hasGrid = gridRows.length > 0;
  const hasBottom = bottomActions.length > 0;

  let focus = hasTop ? "top" : hasGrid ? "grid" : "bottom";
  let topIdx = 0;
  let gridRow = 0;
  let gridCol = 0;
  let bottomIdx = 0;

  if (initialFocus) {
    if (initialFocus.section === "top" && hasTop && initialFocus.index < topActions.length) {
      focus = "top";
      topIdx = initialFocus.index;
    } else if (initialFocus.section === "grid" && hasGrid
      && initialFocus.row < gridRows.length
      && initialFocus.col < gridRows[initialFocus.row].length) {
      focus = "grid";
      gridRow = initialFocus.row;
      gridCol = initialFocus.col;
    } else if (initialFocus.section === "bottom" && hasBottom && initialFocus.index < bottomActions.length) {
      focus = "bottom";
      bottomIdx = initialFocus.index;
    }
  }

  function agentCell(agent, highlighted) {
    const name = agentDisplayName(agent);
    const icon = "💻";
    const maxName = GRID_COL_WIDTH - 6;
    const truncated = name.length > maxName
      ? name.substring(0, maxName - 1) + "…"
      : name;
    const prefix = highlighted ? "▸ " : "  ";
    const text = `${icon} ${truncated}`;
    const visLen = 2 + 2 + 1 + truncated.length;
    const pad = " ".repeat(Math.max(2, GRID_COL_WIDTH - visLen));
    return highlighted
      ? chalk.cyan(prefix) + chalk.cyan.bold(text) + pad
      : prefix + text + pad;
  }

  function agentIdCell(agent) {
    const idShort = agent.agent_id.substring(0, 8);
    const content = `    ${idShort}`;
    const pad = " ".repeat(Math.max(2, GRID_COL_WIDTH - 4 - idShort.length));
    return chalk.dim(content + pad);
  }

  function renderActionLine(row, item, highlighted) {
    const prefix = highlighted ? chalk.cyan("▸ ") : "  ";
    const label = highlighted ? chalk.cyan.bold(item.name) : item.name;
    process.stdout.write(`\x1B[${row};1H\x1B[K  ${prefix}${label}`);
  }

  function render() {
    let row = startRow;

    for (let i = 0; i < topActions.length; i++) {
      renderActionLine(row, topActions[i], focus === "top" && topIdx === i);
      row++;
    }

    if (hasGrid) {
      if (hasTop) {
        process.stdout.write(`\x1B[${row};1H\x1B[K`);
        row++;
      }
      process.stdout.write(`\x1B[${row};1H\x1B[K  ${chalk.dim("Saved agents:")}`);
      row++;
      process.stdout.write(`\x1B[${row};1H\x1B[K`);
      row++;

      for (let r = 0; r < gridRows.length; r++) {
        let nameLine = "  ";
        let idLine = "  ";
        for (let c = 0; c < gridRows[r].length; c++) {
          const hl = focus === "grid" && gridRow === r && gridCol === c;
          nameLine += agentCell(gridRows[r][c], hl);
          idLine += agentIdCell(gridRows[r][c]);
        }
        process.stdout.write(`\x1B[${row};1H\x1B[K${nameLine}`);
        row++;
        process.stdout.write(`\x1B[${row};1H\x1B[K${idLine}`);
        row++;
      }
    }

    if (hasBottom) {
      process.stdout.write(`\x1B[${row};1H\x1B[K`);
      row++;
      for (let i = 0; i < bottomActions.length; i++) {
        renderActionLine(row, bottomActions[i], focus === "bottom" && bottomIdx === i);
        row++;
      }
    }

    process.stdout.write(`\x1B[${row};1H\x1B[K`);
    row++;
    process.stdout.write(`\x1B[${row};1H\x1B[K  ${chalk.dim("←→↑↓ navigate · ↵ select")}`);
    process.stdout.write("\x1B[?25l");
  }

  function moveDown() {
    if (focus === "top") {
      if (topIdx < topActions.length - 1) { topIdx++; }
      else if (hasGrid) { focus = "grid"; gridRow = 0; }
      else if (hasBottom) { focus = "bottom"; bottomIdx = 0; }
    } else if (focus === "grid") {
      if (gridRow < gridRows.length - 1) {
        gridRow++;
        if (gridCol >= gridRows[gridRow].length) gridCol = gridRows[gridRow].length - 1;
      } else if (hasBottom) { focus = "bottom"; bottomIdx = 0; }
    } else {
      if (bottomIdx < bottomActions.length - 1) bottomIdx++;
    }
  }

  function moveUp() {
    if (focus === "bottom") {
      if (bottomIdx > 0) { bottomIdx--; }
      else if (hasGrid) {
        focus = "grid";
        gridRow = gridRows.length - 1;
        if (gridCol >= gridRows[gridRow].length) gridCol = gridRows[gridRow].length - 1;
      } else if (hasTop) { focus = "top"; topIdx = topActions.length - 1; }
    } else if (focus === "grid") {
      if (gridRow > 0) { gridRow--; }
      else if (hasTop) { focus = "top"; topIdx = topActions.length - 1; }
    } else {
      if (topIdx > 0) topIdx--;
    }
  }

  return new Promise((resolve) => {
    render();

    process.stdin.setRawMode(true);
    process.stdin.resume();

    function onData(data) {
      const key = data.toString();

      if (key === "\x03") {
        cleanup();
        process.stdout.write("\x1B[?25h");
        resetScrollRegion();
        process.exit(0);
      }

      if (key === "\r") {
        cleanup();
        process.stdout.write("\x1B[?25h");
        const focusState = focus === "grid"
          ? { section: "grid", row: gridRow, col: gridCol }
          : focus === "top"
            ? { section: "top", index: topIdx }
            : { section: "bottom", index: bottomIdx };
        if (focus === "grid") {
          resolve({ type: "agent", agent: gridRows[gridRow][gridCol], focusState });
        } else if (focus === "top") {
          resolve({ type: "action", value: topActions[topIdx].value, focusState });
        } else {
          resolve({ type: "action", value: bottomActions[bottomIdx].value, focusState });
        }
        return;
      }

      if (key === "\x1B[A") { moveUp(); }
      else if (key === "\x1B[B") { moveDown(); }
      else if (key === "\x1B[C") {
        if (focus === "grid" && gridCol < gridRows[gridRow].length - 1) gridCol++;
      } else if (key === "\x1B[D") {
        if (focus === "grid" && gridCol > 0) gridCol--;
      }

      render();
    }

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on("data", onData);
  });
}

// ── Welcome Screen ──────────────────────────────────────────────────────────

function showWelcome(agents, statusMessage = null) {
  process.stdout.write("\x1B[r");
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
  let lines = 0;
  const out = (s = "") => { console.log(s); lines++; };

  out();
  out(`                   ${chalk.cyanBright("●")}`);
  out(`                   ${chalk.cyan("│")}`);
  out(`        ${chalk.cyan("╭─────────────────────╮")}`);
  out(`        ${chalk.cyan("│                     │")}`);
  out(`      ${chalk.cyan("╭─┤")}                     ${chalk.cyan("├─╮")}`);
  out(`      ${chalk.cyan("│ │")}${chalk.blackBright("   ▀▀▀██████▀▀▀██████")}${chalk.cyan("│ │")}`);
  out(`      ${chalk.cyan("│ │")}${chalk.blackBright("      ██████   ██████")}${chalk.cyan("│ │")}`);
  out(`      ${chalk.cyan("│ │")}${chalk.blackBright("       ▀▀▀▀     ▀▀▀▀ ")}${chalk.cyan("│ │")}`);
  out(`      ${chalk.cyan("╰─┤")}                     ${chalk.cyan("├─╯")}`);
  out(`        ${chalk.cyan("╰─────────────────────╯")}`);
  out(chalk.bold("\n         AgentVisor Bridge\n"));
  lines += 2;

  if (agents.length === 0) {
    out(chalk.dim("  No agents configured yet.\n"));
    lines++;
  }

  if (statusMessage) {
    out(statusMessage);
    out();
  }

  return lines;
}

// ── Idle Glasses Animation ──────────────────────────────────────────────────

const GLASSES_FRAMES = [
  { // Looking right (original)
    brow:   "   ▀▀▀██████▀▀▀██████",
    eye:    "      ██████   ██████",
    bottom: "       ▀▀▀▀     ▀▀▀▀ ",
  },
  { // Centered (symmetric, connectors on both sides)
    brow:   "▀▀▀██████▀▀▀██████▀▀▀",
    eye:    "   ██████   ██████   ",
    bottom: "    ▀▀▀▀     ▀▀▀▀    ",
  },
  { // Looking left (mirrored)
    brow:   "██████▀▀▀██████▀▀▀   ",
    eye:    "██████   ██████      ",
    bottom: " ▀▀▀▀     ▀▀▀▀       ",
  },
];

let idleAnimationTimer = null;
let gleamTimer = null;
let gleamPos = null;
let currentLookFrame = 0;

function colorizeRow(text, gleamCol) {
  if (gleamCol == null) return chalk.blackBright(text);
  return [...text].map((ch, i) => {
    if (ch === " ") return ch;
    if (i === gleamCol) return chalk.white(ch);
    if (i === gleamCol - 1 || i === gleamCol + 1) return chalk.hex("#aaaaaa")(ch);
    return chalk.blackBright(ch);
  }).join("");
}

function buildGlassesOutput(frame, gp) {
  const brow   = `      ${chalk.cyan("│ │")}${colorizeRow(frame.brow,   gp != null ? gp - 1 : null)}${chalk.cyan("│ │")}`;
  const eye    = `      ${chalk.cyan("│ │")}${colorizeRow(frame.eye,    gp)}${chalk.cyan("│ │")}`;
  const bottom = `      ${chalk.cyan("│ │")}${colorizeRow(frame.bottom, gp != null ? gp + 1 : null)}${chalk.cyan("│ │")}`;
  return `\x1B[7;1H${brow}\x1B[K\x1B[8;1H${eye}\x1B[K\x1B[9;1H${bottom}\x1B[K`;
}

function pinScrollRegion(welcomeLines) {
  const termRows = process.stdout.rows || 24;
  const scrollStart = Math.min(welcomeLines + 1, termRows);
  process.stdout.write(`\x1B[${scrollStart};${termRows}r\x1B[${scrollStart};1H`);
}

function resetScrollRegion() {
  process.stdout.write("\x1B[r");
}

function drawGlasses() {
  process.stdout.write(
    `\x1B[s${buildGlassesOutput(GLASSES_FRAMES[currentLookFrame], gleamPos)}\x1B[u`
  );
}

function triggerGleam() {
  if (gleamTimer) return;
  gleamPos = -3;
  gleamTimer = setInterval(() => {
    gleamPos++;
    if (gleamPos > 23) {
      gleamPos = null;
      clearInterval(gleamTimer);
      gleamTimer = null;
    }
    drawGlasses();
  }, 50);
}

function startIdleAnimation() {
  stopIdleAnimation();
  const sequence = [
    { frame: 0, ticks: 4 },
    { frame: 1, ticks: 4 },
    { frame: 2, ticks: 4 },
    { frame: 1, ticks: 4 },
  ];
  let seqIdx = 0;
  let tickCount = 0;
  let cycleCount = 0;

  idleAnimationTimer = setInterval(() => {
    currentLookFrame = sequence[seqIdx].frame;
    drawGlasses();
    tickCount++;
    if (tickCount >= sequence[seqIdx].ticks) {
      tickCount = 0;
      seqIdx = (seqIdx + 1) % sequence.length;
      if (seqIdx === 0) {
        cycleCount++;
        if (cycleCount % 2 === 0) triggerGleam();
      }
    }
  }, 500);
}

function stopIdleAnimation() {
  if (gleamTimer) {
    clearInterval(gleamTimer);
    gleamTimer = null;
    gleamPos = null;
  }
  if (idleAnimationTimer) {
    clearInterval(idleAnimationTimer);
    idleAnimationTimer = null;
  }
}

// ── Explosion Animation ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const EXPLOSION_FRAMES = [
  // F1: Ignition
  `                     ${chalk.white('██')}                     \n` +
  `                     ${chalk.white('██')}                     \n` +
  `                     ${chalk.white('██')}                     \n` +
  `                     ${chalk.white('██')}                     `,

  // F2: Flash
  `                   ${chalk.white('▄████▄')}                   \n` +
  `                  ${chalk.white('████████')}                  \n` +
  `                  ${chalk.white('████████')}                  \n` +
  `                  ${chalk.white('████████')}                  \n` +
  `                  ${chalk.white('████████')}                  \n` +
  `                   ${chalk.white('▀████▀')}                   `,

  // F3: Core Expansion
  `                 ${chalk.yellowBright('▄▓██████▓▄')}                 \n` +
  `                ${chalk.yellowBright('▓')}${chalk.white('██████████')}${chalk.yellowBright('▓')}                \n` +
  `               ${chalk.yellowBright('▓')}${chalk.white('████████████')}${chalk.yellowBright('▓')}               \n` +
  `               ${chalk.yellowBright('▓')}${chalk.white('████████████')}${chalk.yellowBright('▓')}               \n` +
  `               ${chalk.yellowBright('▓')}${chalk.white('████████████')}${chalk.yellowBright('▓')}               \n` +
  `               ${chalk.yellowBright('▓')}${chalk.white('████████████')}${chalk.yellowBright('▓')}               \n` +
  `                ${chalk.yellowBright('▓')}${chalk.white('██████████')}${chalk.yellowBright('▓')}                \n` +
  `                 ${chalk.yellowBright('▀▓██████▓▀')}                 `,

  // F4: Sphere Blast
  `                 ${chalk.yellow('▄▓██████▓▄')}                 \n` +
  `             ${chalk.redBright('▄▒')} ${chalk.yellow('▓▓████████▓▓')} ${chalk.redBright('▒▄')}             \n` +
  `           ${chalk.redBright('▄▓▓')}${chalk.yellowBright('████████████████')}${chalk.redBright('▓▓▄')}           \n` +
  `          ${chalk.redBright('▄▓')}${chalk.yellowBright('████████████████████')}${chalk.redBright('▓▄')}          \n` +
  `          ${chalk.redBright('▓')}${chalk.yellowBright('██████████████████████')}${chalk.redBright('▓')}          \n` +
  `          ${chalk.redBright('▓')}${chalk.yellowBright('██████████████████████')}${chalk.redBright('▓')}          \n` +
  `          ${chalk.redBright('▓')}${chalk.yellowBright('██████████████████████')}${chalk.redBright('▓')}          \n` +
  `          ${chalk.redBright('▓')}${chalk.yellowBright('██████████████████████')}${chalk.redBright('▓')}          \n` +
  `          ${chalk.redBright('▀▓')}${chalk.yellowBright('████████████████████')}${chalk.redBright('▓▀')}          \n` +
  `           ${chalk.redBright('▀▓▓')}${chalk.yellowBright('████████████████')}${chalk.redBright('▓▓▀')}           \n` +
  `             ${chalk.redBright('▀▒')} ${chalk.yellow('▓▓████████▓▓')} ${chalk.redBright('▒▀')}             \n` +
  `                 ${chalk.yellow('▀▓██████▓▀')}                 `,

  // F5: Shockwave & Peak Heat
  `         ${chalk.red('▄▄')} ${chalk.redBright('▄▓')}${chalk.yellow('████████████████')}${chalk.redBright('▓▄')} ${chalk.red('▄▄')}         \n` +
  `      ${chalk.red('▄▓██▓▄')}${chalk.redBright('▓▓')}${chalk.yellow('████████████████')}${chalk.redBright('▓▓')}${chalk.red('▄▓██▓▄')}      \n` +
  `    ${chalk.red('▄▓████▓▄')}${chalk.yellow('████')}${chalk.white('████████████')}${chalk.yellow('████')}${chalk.red('▄▓████▓▄')}    \n` +
  `    ${chalk.red('▓██████▓')}${chalk.yellow('████')}${chalk.white('████████████')}${chalk.yellow('████')}${chalk.red('▓██████▓')}    \n` +
  `    ${chalk.red('▓██████▓')}${chalk.yellow('████')}${chalk.white('████████████')}${chalk.yellow('████')}${chalk.red('▓██████▓')}    \n` +
  `    ${chalk.red('▓██████▓')}${chalk.yellow('████')}${chalk.white('████████████')}${chalk.yellow('████')}${chalk.red('▓██████▓')}    \n` +
  `    ${chalk.red('▓██████▓')}${chalk.yellow('████')}${chalk.white('████████████')}${chalk.yellow('████')}${chalk.red('▓██████▓')}    \n` +
  `    ${chalk.red('▀▓████▓▀')}${chalk.yellow('████')}${chalk.white('████████████')}${chalk.yellow('████')}${chalk.red('▀▓████▓▀')}    \n` +
  `      ${chalk.red('▀▓██▓▀')}${chalk.redBright('▓▓')}${chalk.yellow('████████████████')}${chalk.redBright('▓▓')}${chalk.red('▀▓██▓▀')}      \n` +
  `         ${chalk.red('▀▀')} ${chalk.redBright('▀▓')}${chalk.yellow('████████████████')}${chalk.redBright('▓▀')} ${chalk.red('▀▀')}         `,

  // F6: Mushroom Stem Forms
  `       ${chalk.gray('▄░')}  ${chalk.red('▄▓▓')}${chalk.redBright('████████████████')}${chalk.red('▓▓▄')}  ${chalk.gray('░▄')}       \n` +
  `    ${chalk.gray('▒▓▒')}  ${chalk.red('▓▓▓')}${chalk.redBright('██████')}${chalk.yellow('████████')}${chalk.redBright('██████')}${chalk.red('▓▓▓')}  ${chalk.gray('▒▓▒')}    \n` +
  `    ${chalk.gray('▒▓▓▓▒')} ${chalk.red('▓▓')}${chalk.redBright('██████')}${chalk.yellow('████████')}${chalk.redBright('██████')}${chalk.red('▓▓')} ${chalk.gray('▒▓▓▓▒')}    \n` +
  `    ${chalk.gray('▒▓▓▓▒')} ${chalk.red('▓▓')}${chalk.redBright('██████')}${chalk.yellow('████████')}${chalk.redBright('██████')}${chalk.red('▓▓')} ${chalk.gray('▒▓▓▓▒')}    \n` +
  `    ${chalk.gray('▒▓▓▓▒')} ${chalk.red('▓▓')}${chalk.redBright('██████')}${chalk.yellow('████████')}${chalk.redBright('██████')}${chalk.red('▓▓')} ${chalk.gray('▒▓▓▓▒')}    \n` +
  `      ${chalk.gray('▀▓▀')}  ${chalk.red('▀▓▓')}${chalk.redBright('████████████████')}${chalk.red('▓▓▀')}  ${chalk.gray('▀▓▀')}      \n` +
  `             ${chalk.redBright('▀▓▓')}${chalk.yellow('████████████')}${chalk.redBright('▓▓▀')}             \n` +
  `                 ${chalk.yellow('████████')}                 \n` +
  `                 ${chalk.yellow('████████')}                 \n` +
  `                 ${chalk.yellow('████████')}                 \n` +
  `                 ${chalk.yellow('████████')}                 `,

  // F7: Full Mushroom Cloud
  `         ${chalk.gray('▄▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▄')}         \n` +
  `       ${chalk.red('▄▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄')}       \n` +
  `      ${chalk.red('▓▓▓▓')}${chalk.redBright('████████████████████████')}${chalk.red('▓▓▓▓')}      \n` +
  `     ${chalk.gray('▒')}${chalk.red('▓▓▓')}${chalk.redBright('██████████████████████████')}${chalk.red('▓▓▓')}${chalk.gray('▒')}     \n` +
  `     ${chalk.gray('▒')}${chalk.red('▓▓▓')}${chalk.redBright('██████████████████████████')}${chalk.red('▓▓▓')}${chalk.gray('▒')}     \n` +
  `     ${chalk.gray('▒')}${chalk.red('▓▓▓')}${chalk.redBright('██████████████████████████')}${chalk.red('▓▓▓')}${chalk.gray('▒')}     \n` +
  `     ${chalk.gray('▒')}${chalk.red('▓▓▓')}${chalk.redBright('██████████████████████████')}${chalk.red('▓▓▓')}${chalk.gray('▒')}     \n` +
  `      ${chalk.red('▓▓▓▓')}${chalk.redBright('████████████████████████')}${chalk.red('▓▓▓▓')}      \n` +
  `        ${chalk.red('▀▓▓▓')}${chalk.redBright('███████')}${chalk.yellow('████████')}${chalk.redBright('███████')}${chalk.red('▓▓▓▀')}        \n` +
  `             ${chalk.redBright('▀▓▓')}${chalk.yellow('████████████')}${chalk.redBright('▓▓▀')}             \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  `,

  // F8: Cooling Phase
  `           ${chalk.gray('▄░░░░░░░░░░░░░░░░░░░░░░▄')}           \n` +
  `         ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}         \n` +
  `      ${chalk.gray('▒▒▒▒▒▒')}${chalk.red('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓')}${chalk.gray('▒▒▒▒▒▒')}      \n` +
  `     ${chalk.gray('░▒▒▒▒')}${chalk.red('▓▓')}${chalk.redBright('████████████████████')}${chalk.red('▓▓')}${chalk.gray('▒▒▒▒░')}     \n` +
  `     ${chalk.gray('░▒▒▒▒')}${chalk.red('▓▓')}${chalk.redBright('████████████████████')}${chalk.red('▓▓')}${chalk.gray('▒▒▒▒░')}     \n` +
  `     ${chalk.gray('░▒▒▒▒')}${chalk.red('▓▓')}${chalk.redBright('████████████████████')}${chalk.red('▓▓')}${chalk.gray('▒▒▒▒░')}     \n` +
  `     ${chalk.gray('░▒▒▒▒')}${chalk.red('▓▓')}${chalk.redBright('████████████████████')}${chalk.red('▓▓')}${chalk.gray('▒▒▒▒░')}     \n` +
  `      ${chalk.gray('▒▒▒▒▒▒')}${chalk.red('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓')}${chalk.gray('▒▒▒▒▒▒')}      \n` +
  `         ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}         \n` +
  `           ${chalk.gray('▀░░░░░░░░░░░░░░░░░░░░░░▀')}           \n` +
  `                  ${chalk.red('▓▓▓▓▓▓▓▓')}                  \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  \n` +
  `                  ${chalk.yellow('████████')}                  `,

  // F9: Ash & Smoke
  `           ${chalk.gray('▄░░░░░░░░░░░░░░░░░░░░░░▄')}           \n` +
  `         ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}         \n` +
  `      ${chalk.gray('▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒')}      \n` +
  `     ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}     \n` +
  `     ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}     \n` +
  `     ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}     \n` +
  `     ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}     \n` +
  `      ${chalk.gray('▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒')}      \n` +
  `         ${chalk.gray('░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░')}         \n` +
  `           ${chalk.gray('▀░░░░░░░░░░░░░░░░░░░░░░▀')}           \n` +
  `                  ${chalk.gray('▒▒▒▒▒▒▒▒')}                  \n` +
  `                  ${chalk.red('▓▓▓▓▓▓▓▓')}                  \n` +
  `                  ${chalk.red('▓▓▓▓▓▓▓▓')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  `,

  // F10: Dissipating
  `           ${chalk.gray('░░                  ░░')}           \n` +
  `         ${chalk.gray('░░    ░░░░░░░░░░░░░░    ░░')}         \n` +
  `        ${chalk.gray('░░  ░░░░░░░░░░░░░░░░░░░░  ░░')}        \n` +
  `        ${chalk.gray('░░  ░░░░░░░░░░░░░░░░░░░░  ░░')}        \n` +
  `        ${chalk.gray('░░  ░░░░░░░░░░░░░░░░░░░░  ░░')}        \n` +
  `        ${chalk.gray('░░  ░░░░░░░░░░░░░░░░░░░░  ░░')}        \n` +
  `         ${chalk.gray('░░    ░░░░░░░░░░░░░░    ░░')}         \n` +
  `           ${chalk.gray('░░                  ░░')}           \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('▒▒▒▒▒▒▒▒')}                  \n` +
  `                  ${chalk.gray('▒▒▒▒▒▒▒▒')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  `,

  // F11: Wisps
  `                                            \n` +
  `                ${chalk.gray('░░░░░░░░░░░░')}                \n` +
  `                                            \n` +
  `                                            \n` +
  `                                            \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  \n` +
  `                  ${chalk.gray('░░░░░░░░')}                  `,

  // F12: Empty
  `                                            `,
];

async function playExplosion() {
  process.stdout.write('\x1B[?25l');
  try {
    for (const frame of EXPLOSION_FRAMES) {
      process.stdout.write('\x1B[2J\x1B[H');
      const lines = frame.split('\n').filter(line => line.length > 0);
      const padTop = Math.max(0, Math.floor((30 - lines.length) / 2));
      console.log('\n'.repeat(padTop) + frame.replace(/^\n+|\n+$/g, ''));
      await sleep(150);
    }
  } finally {
    process.stdout.write('\x1B[?25h');
  }
}

// ── Main Menu ───────────────────────────────────────────────────────────────

async function mainMenu(statusMessage = null, lastFocus = null) {
  stopIdleAnimation();
  const agents = loadSavedAgents();
  const envError = checkEnv();
  const welcomeLines = showWelcome(agents, statusMessage ?? envError);

  const topActions = [];
  const bottomActions = [];
  const envOk = !envError;
  const bridgeAgents = agents;

  if (activeAgentSession) {
    topActions.push({ name: "← Return to running agents", value: "resume" });
  }

  if (!activeAgentSession && envOk && bridgeAgents.length > 0) {
    topActions.push({ name: "Activate all agents", value: "start_all" });
    if (bridgeAgents.length > 1) {
      topActions.push({ name: "Select agents to activate", value: "select" });
    }
  }

  if (envOk) {
    bottomActions.push({ name: "Add new agent", value: "add" });
  }

  bottomActions.push({ name: "Exit", value: "exit" });

  pinScrollRegion(welcomeLines);
  startIdleAnimation();

  const result = await interactiveMenu(agents, topActions, bottomActions, welcomeLines + 1, lastFocus);

  stopIdleAnimation();
  resetScrollRegion();
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");

  if (result.type === "agent") {
    try {
      const subMsg = await agentSubMenu(result.agent);
      return mainMenu(subMsg, result.focusState);
    } catch (err) {
      if (err.name === "ExitPromptError") return mainMenu(null, result.focusState);
      throw err;
    }
  }

  switch (result.value) {
    case "resume":
      return { action: "resume", agents: [] };

    case "start_all":
      return { action: "start", agents };

    case "select": {
      try {
        const bridgeOnly = agents;
        const checked = new Set(bridgeOnly.map((a) => a.agent_id));

        while (true) {
          const checkedCount = checked.size;
          const action = await select({
            message: `Select agents to activate (${checkedCount} selected)`,
            choices: [
              { name: chalk.dim("← Back"), value: null },
              ...bridgeOnly.map((a) => {
                const icon = checked.has(a.agent_id) ? chalk.green("✔") : chalk.dim("○");
                return {
                  name: `${icon} ${agentDisplayName(a)}  ${chalk.dim(a.agent_id.substring(0, 8))}`,
                  value: a.agent_id,
                };
              }),
              ...(checkedCount > 0
                ? [{ name: chalk.cyan(`Activate ${checkedCount} agent${checkedCount > 1 ? "s" : ""} →`), value: "__start__" }]
                : []),
            ],
            loop: false,
          });

          if (action === null) return mainMenu(null, result.focusState);
          if (action === "__start__") {
            const filtered = agents.filter((a) => checked.has(a.agent_id));
            return { action: "start", agents: filtered };
          }

          if (checked.has(action)) {
            checked.delete(action);
          } else {
            checked.add(action);
          }
        }
      } catch (err) {
        if (err.name === "ExitPromptError") return mainMenu(null, result.focusState);
        throw err;
      }
    }

    case "add": {
      try {
        const addMsg = await addNewAgent();
        return mainMenu(addMsg, result.focusState);
      } catch (err) {
        if (err.name === "ExitPromptError") return mainMenu(null, result.focusState);
        throw err;
      }
    }

    case "exit":
      process.exit(0);
  }
}

// ── Browse Conversations ─────────────────────────────────────────────────────

const CLAUDE_SESSIONS_DIR_DEFAULT = join(homedir(), ".bridge-claude-sessions");
const CODEX_SESSIONS_DIR_DEFAULT  = join(homedir(), ".bridge-codex-sessions");

// Write a shell script to disk and open it in a new Terminal window.
// Avoids all escaping issues by never passing the command through osascript strings.
function openInTerminal(bin, args, cwd) {
  mkdirSync(AGENTVISOR_DIR, { recursive: true });
  const scriptId = randomUUID().slice(0, 8);
  const scriptPath = join(AGENTVISOR_DIR, `launch-${scriptId}.sh`);

  const lines = ["#!/usr/bin/env bash", `cd ${JSON.stringify(cwd)}`, `exec ${JSON.stringify(bin)} ${args.map(a => JSON.stringify(a)).join(" ")}`];
  writeFileSync(scriptPath, lines.join("\n") + "\n", { mode: 0o700 });

  const os = platform();
  if (os === "darwin") {
    const osaScript = `tell application "Terminal"\n  do script ${JSON.stringify(`bash ${scriptPath}`)}\n  activate\nend tell`;
    spawn("osascript", ["-e", osaScript], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  if (os === "win32") {
    spawn("cmd", ["/c", "start", "bash", scriptPath], { detached: true, stdio: "ignore", shell: true }).unref();
    return true;
  }
  for (const term of ["x-terminal-emulator", "gnome-terminal", "xterm"]) {
    try {
      const termArgs = term === "gnome-terminal" ? ["--", "bash", scriptPath] : ["-e", `bash ${scriptPath}`];
      spawn(term, termArgs, { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch { /* try next */ }
  }
  return false;
}

function writePersistentMcpConfig(conversationId) {
  mkdirSync(AGENTVISOR_DIR, { recursive: true });
  const configPath = join(AGENTVISOR_DIR, `mcp-${conversationId}.json`);
  const config = {
    mcpServers: {
      "bridge-auth": {
        command: "node",
        args: [MCP_SERVER_PATH],
        env: {
          BRIDGE_SUPABASE_URL: SUPABASE_URL,
          BRIDGE_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
          BRIDGE_CONVERSATION_ID: conversationId,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configPath;
}

// Decode a Claude project slug back to a filesystem path.
// Claude slugs replace '/' with '-', so '-Users-joshua-foo-bar' could map to
// '/Users/joshua/foo/bar' OR '/Users/joshua/foo-bar'. Strategy: at each level,
// first try consuming ALL remaining parts as one segment (check disk); if that
// path exists, we're done. Otherwise descend into the shortest matching directory
// prefix and recurse.
function decodeClaudeProjectSlug(slug) {
  const parts = slug.replace(/^-/, "").split("-");

  function build(parts, current) {
    if (parts.length === 0) return current;

    // Try the whole remaining slug as one directory name first.
    const whole = join(current, parts.join("-"));
    try { statSync(whole); return whole; } catch { /* doesn't exist, keep going */ }

    // Descend into the shortest prefix that is an existing directory.
    for (let k = 1; k < parts.length; k++) {
      const candidate = join(current, parts.slice(0, k).join("-"));
      try {
        if (statSync(candidate).isDirectory()) {
          return build(parts.slice(k), candidate);
        }
      } catch { /* not a dir */ }
    }

    return whole; // fallback
  }

  return build(parts, "/");
}

// Returns a list of recent Claude project sessions from ~/.claude/projects/
// Each entry: { projectSlug, projectPath, sessionId, lastModified }
function scanClaudeProjectSessions() {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const results = [];

  for (const slug of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, slug);
    let stat;
    try { stat = statSync(projectDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const projectPath = decodeClaudeProjectSlug(slug);

    // Find the most recently modified .jsonl session file
    let latestSession = null;
    let latestMtime = 0;
    try {
      for (const f of readdirSync(projectDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const fPath = join(projectDir, f);
        const fStat = statSync(fPath);
        if (fStat.mtimeMs > latestMtime) {
          latestMtime = fStat.mtimeMs;
          latestSession = f.replace(".jsonl", "");
        }
      }
    } catch { continue; }

    if (!latestSession) continue;

    results.push({
      projectSlug: slug,
      projectPath,
      sessionId: latestSession,
      lastModified: latestMtime,
    });
  }

  return results.sort((a, b) => b.lastModified - a.lastModified);
}

async function resumeConversationInteractive(conversation, agentType) {
  const claudeBin = process.env.CLAUDE_BIN || "claude";
  const codexBin  = process.env.CODEX_BIN  || "codex";

  process.stdout.write("\x1B[2J\x1B[H\x1B[?25h");
  console.log(chalk.cyan.bold(`\n  Resuming: ${conversation.title}`));

  let bin, args, cwd;

  if (agentType === "claude") {
    bin  = claudeBin;
    args = ["--resume", conversation.id];
    cwd  = conversation.workspace || CLAUDE_SESSIONS_DIR_DEFAULT;
  } else {
    bin  = codexBin;
    args = [];
    const convDir = join(CODEX_SESSIONS_DIR_DEFAULT, conversation.id);
    if (!existsSync(convDir)) mkdirSync(convDir, { recursive: true });
    cwd  = conversation.workspace || convDir;
  }

  console.log(chalk.dim(`  ${cwd}\n`));

  await new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit" });
    child.on("exit",  resolve);
    child.on("error", (err) => {
      console.error(chalk.red(`\n  ✗ Could not launch ${agentType}: ${err.message}`));
      resolve();
    });
  });
}

async function browseConversations(agent) {
  const agentType   = agent.agent_type;
  const displayName = agentDisplayName(agent);
  const conversations = localDb.getConversations(agent.agent_id);

  if (conversations.length === 0) {
    return chalk.dim("  No conversations yet.");
  }

  const choices = [
    { name: chalk.dim("← Back"), value: null },
    ...conversations.map((conv) => {
      const d = new Date(conv.created_at);
      const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        + " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const wsLabel = conv.workspace ? chalk.dim(` · ${basename(conv.workspace)}`) : "";
      return {
        name: `${conv.title}${wsLabel}  ${chalk.dim(dateStr)}`,
        value: conv,
      };
    }),
  ];

  let selected;
  try {
    selected = await select({
      message: `Conversations — ${displayName} (${conversations.length})`,
      choices,
      loop: false,
    });
  } catch (err) {
    if (err.name === "ExitPromptError") return null;
    throw err;
  }

  if (!selected) return null;

  await resumeConversationInteractive(selected, agentType);
  return null;
}

// ── Scan & Attach Existing Claude Session ───────────────────────────────────

async function scanAndAttachClaudeSession(agent) {
  if (agent.agent_type !== "claude") {
    return chalk.yellow("  ⚠ Scan sessions is only supported for Claude agents.");
  }

  const sessions = scanClaudeProjectSessions();

  if (sessions.length === 0) {
    return chalk.dim("  No Claude sessions found in ~/.claude/projects/");
  }

  const choices = [
    { name: chalk.dim("← Back"), value: null },
    ...sessions.slice(0, 20).map((s) => {
      const date = new Date(s.lastModified);
      const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        + " " + date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const label = s.projectPath.length > 55
        ? "…" + s.projectPath.slice(-54)
        : s.projectPath;
      return {
        name: `${label}  ${chalk.dim(dateStr)}`,
        value: s,
      };
    }),
  ];

  let selected;
  try {
    selected = await select({
      message: "Select a Claude session to attach",
      choices,
      loop: false,
    });
  } catch (err) {
    if (err.name === "ExitPromptError") return null;
    throw err;
  }

  if (!selected) return null;

  // Register in localDb so the permission watcher can route requests for this session.
  const projectName = selected.projectPath.split("/").pop() ?? selected.projectPath;
  const createdAt = new Date().toISOString();
  localDb.insertConversation(
    selected.sessionId,
    agent.agent_id,
    "local",
    projectName,
    createdAt,
    null,
    selected.projectPath,
  );

  const claudeBin = process.env.CLAUDE_BIN || "claude";
  const mcpConfigPath = writePersistentMcpConfig(selected.sessionId);

  const args = [
    "--resume", selected.sessionId,
    "--mcp-config", mcpConfigPath,
    "--permission-prompt-tool", "mcp__bridge-auth__bridge_permission_tool",
  ];

  if (!openInTerminal(claudeBin, args, selected.projectPath)) {
    return { ok: false, message: chalk.red("  ✗ Could not open a terminal window") };
  }

  return {
    ok: true,
    message: chalk.green(`  ✓ Terminal opened — session ${selected.sessionId.substring(0, 8)}… with AgentVisor permission routing`),
    sessionId: selected.sessionId,
    agentId: agent.agent_id,
    projectName,
    createdAt,
  };
}

// ── Agent Sub-Menu ──────────────────────────────────────────────────────────

async function agentSubMenu(agent) {
  const displayName = agentDisplayName(agent);

  const artifactsStatus = agent.artifacts_enabled ? "on" : "off";

  const choices = [
    { name: chalk.dim("← Back"), value: null },
    { name: "Manage workspaces", value: "workspaces" },
    { name: "Manage models", value: "models" },
    { name: `Screen sharing (${artifactsStatus})`, value: "artifacts" },
    { name: "Conversations", value: "conversations" },
    { name: "Find existing Claude session", value: "scan_sessions" },
    { name: "Rename", value: "rename" },
    { name: "Remove", value: "remove" },
  ];

  const action = await select({
    message: `${displayName} (${agent.agent_id.substring(0, 8)})`,
    choices,
  });

  if (!action) return null;

  switch (action) {
    case "workspaces":
      return manageWorkspaces(agent);
    case "models":
      return manageModels(agent);
    case "conversations":
      return browseConversations(agent);
    case "scan_sessions":
      return scanAndAttachClaudeSession(agent);
    case "rename": {
      const newName = await input({
        message: "Enter new name",
        default: displayName,
      });
      if (!newName.trim() || newName.trim() === displayName) return null;
      updateSavedAgent(agent.agent_id, { name: newName.trim() });
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/bridge_agents?id=eq.${agent.agent_id}`, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: newName.trim() }),
        });
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ Could not sync rename to Supabase: ${err.message}`));
      }
      return chalk.green(`  ✓ Renamed to: ${newName.trim()}`);
    }
    case "artifacts": {
      const current = agent.artifacts_enabled ?? false;
      const newValue = !current;
      updateSavedAgent(agent.agent_id, { artifacts_enabled: newValue });
      return chalk.green(`  Screen sharing ${newValue ? "enabled" : "disabled"}.`);
    }
    case "remove":
      return removeAgent(agent);
  }
}

// ── Add New Agent ───────────────────────────────────────────────────────────

async function addNewAgent() {
  const drivers = availableDrivers();

  const choices = [
    { name: chalk.dim("← Back"), value: null },
    ...drivers.map(([key, info]) => ({ name: info.label, value: key })),
  ];

  const agentType = await select({
    message: "Select agent type",
    choices,
    loop: false,
  });

  if (!agentType) return null;

  const defaultName = DRIVER_MAP[agentType]?.label ?? agentType;
  const agentName = await input({
    message: "Enter a name for this agent (leave empty to go back)",
    default: defaultName,
  });

  if (!agentName.trim()) return null;

  console.log(chalk.dim("\n  Registering agent…"));

  let agentId;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bridge_agents`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ name: agentName, agent_type: agentType }),
    });
    if (!res.ok) {
      return chalk.red(`  ✗ Registration failed: ${await res.text()}`);
    }
    const [row] = await res.json();
    agentId = row.id;
  } catch (err) {
    return chalk.red(`  ✗ Could not reach Supabase: ${err.message}`);
  }

  const enableArtifacts = await confirm({
    message: "Enable screen sharing? (Allows the AI to send screenshots to your glasses)",
    default: false,
  });

  addSavedAgent({ agent_id: agentId, agent_type: agentType, name: agentName, artifacts_enabled: enableArtifacts });

  if (agentType === "codex") {
    console.log();
    console.log(chalk.yellow("  ⚠ Note: Codex does not support enforced permission gating."));
    console.log(chalk.dim("    Codex runs with --dangerously-bypass-approvals-and-sandbox."));
    console.log(chalk.dim("    Permission requests are best-effort via prompt instruction —"));
    console.log(chalk.dim("    the model may occasionally act without requesting approval."));
    console.log();
  }

  return chalk.green(`  ✓ ${agentName} agent registered!`);
}

// ── Workspace Discovery ─────────────────────────────────────────────────────

function discoverWorkspaces(existingPaths = [], maxDepth = 3) {
  const home = homedir();
  const searchRoots = [
    home,
    join(home, "Documents"),
    join(home, "Projects"),
    join(home, "Developer"),
    join(home, "Desktop"),
    join(home, "dev"),
    join(home, "src"),
    join(home, "repos"),
    join(home, "code"),
    join(home, "work"),
  ];

  const existingSet = new Set(existingPaths);
  const results = [];

  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", "vendor", "dist",
    "build", "__pycache__", ".cache", ".vscode", ".idea",
    "Library", "Applications", "Music", "Pictures", "Movies",
  ]);

  function scan(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
    if (hasGit && !existingSet.has(dir)) {
      const rel = dir.startsWith(home) ? "~" + dir.slice(home.length) : dir;
      results.push({ path: dir, displayPath: rel, name: basename(dir) });
    }

    if (depth < maxDepth) {
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        scan(join(dir, entry.name), depth + 1);
      }
    }
  }

  for (const root of searchRoots) {
    if (existsSync(root) && statSync(root).isDirectory()) {
      scan(root, 0);
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

function getGitBranch(dir) {
  try {
    const headPath = join(dir, ".git", "HEAD");
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, "utf8").trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    return match ? match[1] : head.substring(0, 8);
  } catch {
    return null;
  }
}

function getWorkspaceMetadata(workspacePath) {
  const name = basename(workspacePath);
  const gitBranch = getGitBranch(workspacePath);
  const lastUsed = localDb.getLastConversationTime(workspacePath);
  return { path: workspacePath, name, gitBranch, lastUsed };
}

// ── Manage Workspaces ───────────────────────────────────────────────────────

async function manageWorkspaces(agent) {
  const agentId = agent.agent_id;
  const workspaces = agent.workspaces ?? [];
  const displayName = agentDisplayName(agent);

  const action = await select({
    message: `Workspaces for ${displayName} (${workspaces.length} configured)`,
    choices: [
      { name: chalk.dim("← Back"), value: null },
      { name: "Add workspace", value: "add" },
      ...(workspaces.length > 0
        ? [
            { name: "Remove workspace", value: "remove" },
            { name: "Set default workspace", value: "default" },
            { name: "List workspaces", value: "list" },
          ]
        : []),
    ],
  });

  if (!action) return null;

  switch (action) {
    case "add": {
      const addMethod = await select({
        message: "How do you want to add a workspace?",
        choices: [
          { name: chalk.dim("← Back"), value: null },
          { name: "Browse discovered projects", value: "discover" },
          { name: "Enter path manually", value: "manual" },
        ],
      });

      if (!addMethod) return null;

      let resolved;

      if (addMethod === "discover") {
        console.log(chalk.dim("\n  Scanning for git repositories..."));
        const discovered = discoverWorkspaces(workspaces);

        if (discovered.length === 0) {
          return chalk.yellow("  ⚠ No new git repositories found.");
        }

        const chosen = await select({
          message: `Found ${discovered.length} project${discovered.length > 1 ? "s" : ""}`,
          choices: [
            { name: chalk.dim("← Back"), value: null },
            ...discovered.map((d) => ({
              name: `${d.name}  ${chalk.dim(d.displayPath)}`,
              value: d.path,
            })),
          ],
          loop: false,
        });

        if (!chosen) return null;
        resolved = chosen;
      } else {
        const rawPath = await input({
          message: "Enter the absolute path to the workspace folder",
        });
        if (!rawPath.trim()) return null;

        const expanded = rawPath.trim().replace(/^~/, homedir());
        resolved = resolve(expanded);

        if (!existsSync(resolved)) {
          return chalk.red(`  ✗ Path does not exist: ${resolved}`);
        }

        try {
          if (!statSync(resolved).isDirectory()) {
            return chalk.red(`  ✗ Path is not a directory: ${resolved}`);
          }
        } catch {
          return chalk.red(`  ✗ Cannot access path: ${resolved}`);
        }

        if (workspaces.includes(resolved)) {
          return chalk.yellow(`  ⚠ Workspace already added: ${resolved}`);
        }
      }

      const updated = [...workspaces, resolved];
      const updates = { workspaces: updated };
      if (updated.length === 1) {
        updates.default_workspace = resolved;
      }
      updateSavedAgent(agentId, updates);
      return chalk.green(`  ✓ Added workspace: ${resolved}`);
    }

    case "remove": {
      const toRemove = await select({
        message: "Select workspace to remove",
        choices: [
          { name: chalk.dim("← Back"), value: null },
          ...workspaces.map((w) => ({
            name: `${basename(w)}  ${chalk.dim(w)}${w === agent.default_workspace ? chalk.cyan(" (default)") : ""}`,
            value: w,
          })),
        ],
      });

      if (!toRemove) return null;

      const filtered = workspaces.filter((w) => w !== toRemove);
      const updates = { workspaces: filtered };
      if (agent.default_workspace === toRemove) {
        updates.default_workspace = filtered[0] ?? null;
      }
      updateSavedAgent(agentId, updates);
      return chalk.green(`  ✓ Removed workspace: ${toRemove}`);
    }

    case "default": {
      const chosen = await select({
        message: "Select default workspace",
        choices: workspaces.map((w) => ({
          name: `${basename(w)}  ${chalk.dim(w)}${w === agent.default_workspace ? chalk.cyan(" (current)") : ""}`,
          value: w,
        })),
      });

      updateSavedAgent(agentId, { default_workspace: chosen });
      return chalk.green(`  ✓ Default workspace set to: ${chosen}`);
    }

    case "list": {
      const lines = workspaces.map((w) => {
        const isDefault = w === agent.default_workspace;
        return `  ${isDefault ? chalk.cyan("★") : " "} ${basename(w)}  ${chalk.dim(w)}`;
      });
      return `\n${lines.join("\n")}\n`;
    }
  }
}

// ── Manage Models ───────────────────────────────────────────────────────────

async function manageModels(agent) {
  const agentId = agent.agent_id;
  const models = agent.model_aliases ?? [];
  const displayName = agentDisplayName(agent);

  const action = await select({
    message: `Model aliases for ${displayName} (${models.length} configured)`,
    choices: [
      { name: chalk.dim("← Back"), value: null },
      { name: "Add model alias", value: "add" },
      ...(models.length > 0
        ? [
            { name: "Remove model alias", value: "remove" },
            { name: "List model aliases", value: "list" },
          ]
        : []),
    ],
  });

  if (!action) return null;

  switch (action) {
    case "add": {
      const alias = await input({
        message: "Enter the model name (e.g. claude-sonnet-4-6, gpt-5-codex)",
      });
      if (!alias.trim()) return null;

      const trimmed = alias.trim();
      if (models.includes(trimmed)) {
        return chalk.yellow(`  ⚠ Model alias already exists: ${trimmed}`);
      }

      const updated = [...models, trimmed];
      updateSavedAgent(agentId, { model_aliases: updated });
      return chalk.green(`  ✓ Added model alias: ${trimmed}`);
    }

    case "remove": {
      const toRemove = await select({
        message: "Select model alias to remove",
        choices: [
          { name: chalk.dim("← Back"), value: null },
          ...models.map((m) => ({ name: m, value: m })),
        ],
      });

      if (!toRemove) return null;

      const filtered = models.filter((m) => m !== toRemove);
      updateSavedAgent(agentId, { model_aliases: filtered });
      return chalk.green(`  ✓ Removed model alias: ${toRemove}`);
    }

    case "list": {
      const lines = models.map((m) => `    ${m}`);
      return `\n${lines.join("\n")}\n`;
    }
  }
}

// ── Remove Agent ────────────────────────────────────────────────────────────

async function removeAgent(agent) {
  const displayName = agentDisplayName(agent);
  const agentId = agent.agent_id;

  const yes = await confirm({ message: `Remove ${displayName}?`, default: false });
  if (!yes) return null;

  try {
    console.log(chalk.dim("\n  Removing from Supabase…"));
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bridge_agents?id=eq.${agentId}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) {
      console.log(chalk.yellow(`  ⚠ Supabase removal responded ${res.status} — removing locally anyway.`));
    }
  } catch (e) {
    console.log(chalk.yellow(`  ⚠ Could not reach Supabase: ${e.message} — removing locally.`));
  }

  removeSavedAgent(agentId);
  await playExplosion();
  return chalk.green("  ✓ Agent removed and unpaired.");
}

// ── Bridge Instance ─────────────────────────────────────────────────────────

const PERM_DIR = join(homedir(), ".bridge-data", "permissions");
mkdirSync(PERM_DIR, { recursive: true });

const ARTIFACTS_DIR = join(homedir(), ".bridge-data", "artifacts");
mkdirSync(ARTIFACTS_DIR, { recursive: true });

function createBridgeInstance(agentConfig, driver, dashboard) {
  let supabase;
  let accessToken;
  let heartbeatTimer;
  let presenceTimer;
  let permissionWatcherInterval = null;
  let artifactWatcherInterval = null;
  let reconnectAttempts = 0;
  let broadcastChannel = null;
  let deletionChannel = null;
  let remotelyRemoved = false;
  let lastClientPresenceMs = null;
  const pendingDeliveries = new Map(); // messageId → { payload, timestamp }
  const conversationQueues = new Map();
  const agentId = agentConfig.agent_id;

  async function restPatch(table, id, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PATCH ${table} failed (${res.status}): ${text}`);
    }
  }

  async function broadcast(event, payload) {
    if (!broadcastChannel) {
      dashboard.log(agentId, chalk.yellow(`broadcast "${event}" skipped — no channel`));
      return false;
    }
    const maxAttempts = CRITICAL_BROADCAST_EVENTS.has(event) ? 1 + BROADCAST_MAX_RETRIES : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await broadcastChannel.send({ type: "broadcast", event, payload });
      if (result === "ok") return true;
      dashboard.log(agentId, chalk.yellow(`broadcast "${event}" result: ${result} (attempt ${attempt + 1}/${maxAttempts})`));
      if (attempt < maxAttempts - 1) {
        await sleep(BROADCAST_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    return false;
  }

  function goOffline() {
    if (remotelyRemoved) return;
    remotelyRemoved = true;
    clearInterval(heartbeatTimer);
    clearInterval(presenceTimer);
    stopPermissionWatcher();
    dashboard.setAgentStatus(agentId, "offline");
    if (broadcastChannel) {
      supabase.removeChannel(broadcastChannel);
      broadcastChannel = null;
    }
    if (deletionChannel) {
      supabase.removeChannel(deletionChannel);
      deletionChannel = null;
    }
  }

  function handleRemoteRemoval() {
    goOffline();
    removeSavedAgent(agentId);
  }

  async function sendHeartbeat() {
    try {
      await restPatch("bridge_agents", agentId, { status: "online", last_seen_at: new Date().toISOString() });
      dashboard.setHeartbeat(agentId, true);
    } catch (err) {
      const status = err.message.match(/\((\d{3})\)/)?.[1];
      if (status === "404") {
        dashboard.log(agentId, chalk.yellow.bold("Agent not found in Supabase — going offline. Re-add via sync.js to recover."));
        goOffline();
        return;
      }
      dashboard.setHeartbeat(agentId, false);
      dashboard.log(agentId, chalk.red(`Heartbeat failed: ${err.message}`));
    }
  }

  function startHeartbeat() {
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  async function sendPresence() {
    const sent = await broadcast("bridge_presence", {
      sent_at: new Date().toISOString(),
    });
    if (!sent && broadcastChannel) {
      // Channel object exists but send failed — WebSocket silently dropped.
      dashboard.log(agentId, chalk.yellow("bridge_presence send failed — reconnecting"));
      scheduleReconnect();
    }
  }

  // How long to wait without a client_presence reply before assuming the
  // channel is broken.  We use 2.5× the presence interval as the grace window
  // so a single missed response doesn't trigger a reconnect, and we stop
  // reconnecting after 8× (lens is probably just offline by then).
  const CLIENT_PRESENCE_STALE_MS  = Math.round(BRIDGE_PRESENCE_INTERVAL_MS * 2.5);  // 12.5s
  const CLIENT_PRESENCE_ABSENT_MS = BRIDGE_PRESENCE_INTERVAL_MS * 8;   // 40s

  function startPresence() {
    clearInterval(presenceTimer);
    presenceTimer = setInterval(() => {
      void sendPresence();

      // Fix 2: detect one-way channel break.
      // If we have received client_presence before (lens was active) but it has
      // gone quiet for too long, assume the channel can receive but not deliver
      // back to us and reconnect.  We stop trying once the silence is long
      // enough that the lens is likely just offline.
      if (lastClientPresenceMs !== null && broadcastChannel) {
        const silenceMs = Date.now() - lastClientPresenceMs;
        if (silenceMs >= CLIENT_PRESENCE_STALE_MS && silenceMs < CLIENT_PRESENCE_ABSENT_MS) {
          dashboard.log(agentId, chalk.yellow(`No client_presence for ${Math.round(silenceMs / 1000)}s — reconnecting`));
          lastClientPresenceMs = null; // reset so we don't spam reconnects
          scheduleReconnect();
        }
      }
    }, BRIDGE_PRESENCE_INTERVAL_MS);
  }

  function startDeletionWatcher() {
    if (deletionChannel) {
      supabase.removeChannel(deletionChannel);
    }
    const ch = supabase
      .channel(`agent-deletion-watch:${agentId}`)
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "bridge_agents",
          filter: `id=eq.${agentId}`,
        },
        () => {
          dashboard.log(agentId, chalk.yellow.bold("Agent row deleted from Supabase — going offline."));
          goOffline();
        },
      )
      .subscribe();
    deletionChannel = ch;
  }

  const conversationStates = new Map();
  const stoppedConversations = new Set();

  async function updateConversationState(conversationId, state, tool = null, permissionPayload = null) {
    dashboard.setConversationState(agentId, conversationId, state);
    const seq = localDb.incrementSeq(conversationId);
    conversationStates.set(conversationId, { state, tool, permissionPayload, seq });
    localDb.upsertConversationState(conversationId, state, tool, permissionPayload ? JSON.stringify(permissionPayload) : null);

    await broadcast("activity_state", {
      conversation_id: conversationId,
      state,
      current_tool: tool,
      permission_payload: permissionPayload,
      seq,
    });
  }

  function enqueueMessage(conversationId, content, userId, title, requestId, workspace, images = null, model = null) {
    dashboard.recordMessage(agentId, "in");
    const prev = conversationQueues.get(conversationId) ?? Promise.resolve();
    const next = prev
      .then(() => handleMessage(conversationId, content, userId, title, requestId, workspace, images, model))
      .catch((err) => dashboard.log(agentId, chalk.red(`[${conversationId.substring(0, 8)}] Queue error: ${err.message}`)))
      .finally(() => {
        if (conversationQueues.get(conversationId) === next) {
          conversationQueues.delete(conversationId);
        }
      });
    conversationQueues.set(conversationId, next);
  }

  async function handleMessage(conversationId, content, userId, title, requestId, workspace, images = null, model = null) {
    const convId = conversationId;

    const localConv = localDb.getConversation(convId);
    let targetSession = localConv?.target_session ?? null;
    let conversationWorkspace = localConv?.workspace ?? null;

    if (!localConv) {
      conversationWorkspace = workspace ?? agentConfig.default_workspace ?? null;
      localDb.insertConversation(convId, agentId, userId, title ?? content.substring(0, 80), new Date().toISOString(), null, conversationWorkspace);
    }

    const convTitle = localDb.getConversation(convId)?.title ?? title ?? content.substring(0, 80);
    dashboard.setConversationTitle(agentId, convId, convTitle, Date.now());

    const msgId = randomUUID();
    localDb.insertMessage(msgId, convId, "user", content, new Date().toISOString(), images);

    broadcast("user_message_ack", {
      conversation_id: convId,
      message_id: msgId,
      request_id: requestId ?? null,
    });

    const shortId = convId.substring(0, 8);
    const preview = content.replace(/\n/g, " ");
    const truncated = preview.length > 60 ? preview.substring(0, 57) + "..." : preview;
    const imageNote = images ? ` (+${images.length} image${images.length > 1 ? "s" : ""})` : "";
    dashboard.log(agentId, `${chalk.dim(`[${shortId}]`)} ← ${chalk.white(`"${truncated}"`)}${imageNote}`);

    await updateConversationState(convId, "thinking");

    const thinkStart = Date.now();

    try {
      const response = await driver.sendMessage(convId, content, targetSession, conversationWorkspace, images, model);
      const elapsed = Date.now() - thinkStart;

      await updateConversationState(convId, "responding");

      const agentMsgId = randomUUID();
      const msgSeq = localDb.incrementSeq(convId);
      localDb.insertMessageWithSeq(agentMsgId, convId, "agent", response, new Date().toISOString(), null, msgSeq);

      const agentMsgPayload = { conversation_id: convId, message_id: agentMsgId, content: response, seq: msgSeq };
      pendingDeliveries.set(agentMsgId, { payload: agentMsgPayload, timestamp: Date.now() });
      await broadcast("agent_message", agentMsgPayload);

      stoppedConversations.delete(convId);
      dashboard.recordMessage(agentId, "out");
      dashboard.log(agentId, `${chalk.dim(`[${shortId}]`)} → ${response.length} chars ${chalk.dim(`(${formatDuration(elapsed)})`)}`);
      await updateConversationState(convId, "idle");
    } catch (err) {
      if (stoppedConversations.has(convId)) {
        stoppedConversations.delete(convId);
        dashboard.log(agentId, chalk.dim(`[${shortId}] Driver error after stop — suppressed`));
        return;
      }

      dashboard.log(agentId, chalk.red(`[${shortId}] Driver error: ${err.message}`));

      const errMsgId = randomUUID();
      const errContent = "Sorry, I encountered an error processing your request.";
      const errSeq = localDb.incrementSeq(convId);
      localDb.insertMessageWithSeq(errMsgId, convId, "agent", errContent, new Date().toISOString(), null, errSeq);

      const errMsgPayload = { conversation_id: convId, message_id: errMsgId, content: errContent, seq: errSeq };
      pendingDeliveries.set(errMsgId, { payload: errMsgPayload, timestamp: Date.now() });
      await broadcast("agent_message", errMsgPayload);

      await updateConversationState(convId, "idle");
    }
  }

  async function handleStopRequest(conversationId) {
    const shortId = conversationId.substring(0, 8);
    if (stoppedConversations.has(conversationId)) {
      dashboard.log(agentId, chalk.dim(`[${shortId}] duplicate stop_request ignored`));
      return;
    }
    stoppedConversations.add(conversationId);
    const aborted = driver.abort(conversationId);
    dashboard.log(agentId, `${chalk.dim(`[${shortId}]`)} ${chalk.yellow("⏹ Stop requested")} (aborted=${aborted})`);

    const msgId = randomUUID();
    const content = "Task interrupted by user.";
    const stopSeq = localDb.incrementSeq(conversationId);
    localDb.insertMessageWithSeq(msgId, conversationId, "agent", content, new Date().toISOString(), null, stopSeq);

    const stopMsgPayload = { conversation_id: conversationId, message_id: msgId, content, seq: stopSeq };
    pendingDeliveries.set(msgId, { payload: stopMsgPayload, timestamp: Date.now() });
    await broadcast("agent_message", stopMsgPayload);

    await updateConversationState(conversationId, "idle");
  }

  function parseJsonlHistory(sessionId, workspace) {
    try {
      // Try direct re-encoding first; fall back to scanning all project dirs.
      const directSlug = workspace.replace(/\//g, "-");
      let jsonlPath = join(CLAUDE_PROJECTS_DIR, directSlug, `${sessionId}.jsonl`);
      if (!existsSync(jsonlPath)) {
        let found = false;
        for (const slug of readdirSync(CLAUDE_PROJECTS_DIR)) {
          const candidate = join(CLAUDE_PROJECTS_DIR, slug, `${sessionId}.jsonl`);
          if (existsSync(candidate)) { jsonlPath = candidate; found = true; break; }
        }
        if (!found) return [];
      }

      const lines = readFileSync(jsonlPath, "utf8").split("\n");
      const messages = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        if (entry.type === "user" && entry.message?.role === "user" && !entry.toolUseResult) {
          const raw = entry.message.content;
          const text = typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw.filter((b) => b.type === "text").map((b) => b.text).join("\n")
              : null;
          if (text?.trim()) {
            messages.push({
              id: entry.uuid ?? randomUUID(),
              conversation_id: sessionId,
              role: "user",
              content: text.trim(),
              created_at: entry.timestamp ?? new Date().toISOString(),
            });
          }
        } else if (entry.type === "assistant" && entry.message?.role === "assistant") {
          const content = entry.message.content;
          const text = Array.isArray(content)
            ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
            : typeof content === "string" ? content : null;
          if (text?.trim()) {
            messages.push({
              id: entry.uuid ?? randomUUID(),
              conversation_id: sessionId,
              role: "agent",
              content: text.trim(),
              created_at: entry.timestamp ?? new Date().toISOString(),
            });
          }
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  async function handleFetchHistory(conversationId, requestId, limit = null) {
    let messages = localDb.getMessages(conversationId, limit);

    if (messages.length === 0) {
      const conv = localDb.getConversation(conversationId);
      if (conv?.workspace) {
        messages = parseJsonlHistory(conversationId, conv.workspace);
      }
    }

    const payload = { conversation_id: conversationId, request_id: requestId, messages };
    if (JSON.stringify(payload).length > 200_000) {
      const stripped = messages.map(({ images: _, ...m }) => m);
      await broadcast("history_response", {
        conversation_id: conversationId,
        request_id: requestId,
        messages: stripped,
        images_stripped: true,
      });
    } else {
      await broadcast("history_response", payload);
    }
  }

  async function handleFetchConversations(requestId) {
    const conversations = localDb.getConversations(agentId);
    for (const c of conversations) {
      dashboard.setConversationTitle(agentId, c.id, c.title, new Date(c.created_at).getTime());
    }
    const enriched = conversations.map((c) => ({
      ...c,
      activity_state: conversationStates.get(c.id)?.state ?? "idle",
      current_tool: conversationStates.get(c.id)?.tool ?? null,
      permission_payload: conversationStates.get(c.id)?.permissionPayload ?? null,
      seq: conversationStates.get(c.id)?.seq ?? localDb.getSeq(c.id),
    }));
    const sent = await broadcast("conversations_response", {
      request_id: requestId,
      conversations: enriched,
    });
    if (!sent) dashboard.log(agentId, chalk.yellow("conversations_response broadcast failed"));
  }

  function handleDeleteConversation(conversationId) {
    localDb.deleteConversation(conversationId);
    localDb.deleteConversationState(conversationId);
    conversationStates.delete(conversationId);
    dashboard.log(agentId, `${chalk.dim(`[${conversationId.substring(0, 8)}]`)} conversation deleted`);
  }

  function openConversationInCLI(conversation_id) {
    const conv = localDb.getConversation(conversation_id);
    if (!conv) {
      dashboard.log(agentId, chalk.red(`open_in_cli: conversation ${conversation_id} not found`));
      return;
    }

    const aType = agentConfig.agent_type;
    if (aType !== "claude" && aType !== "codex") {
      dashboard.log(agentId, chalk.yellow(`open_in_cli not supported for agent type: ${aType}`));
      return;
    }

    const claudeBin = process.env.CLAUDE_BIN || "claude";
    const codexBin  = process.env.CODEX_BIN  || "codex";

    let bin, args, cwd;
    if (aType === "claude") {
      bin = claudeBin;
      const mcpConfigPath = writePersistentMcpConfig(conversation_id);
      args = [
        "--resume", conversation_id,
        "--mcp-config", mcpConfigPath,
        "--permission-prompt-tool", "mcp__bridge-auth__bridge_permission_tool",
      ];
      cwd = conv.workspace || CLAUDE_SESSIONS_DIR_DEFAULT;
    } else {
      bin  = codexBin;
      args = [];
      const convDir = join(CODEX_SESSIONS_DIR_DEFAULT, conversation_id);
      if (!existsSync(convDir)) mkdirSync(convDir, { recursive: true });
      cwd  = conv.workspace || convDir;
    }

    if (!openInTerminal(bin, args, cwd)) {
      dashboard.log(agentId, chalk.red("Could not open a terminal window"));
      return;
    }
    dashboard.log(agentId, chalk.cyan(`Opened conversation in CLI: ${conv.title || conversation_id.substring(0, 8)}`));
  }

  function startBroadcastListener() {
    if (broadcastChannel) {
      clearInterval(presenceTimer);
      const old = broadcastChannel;
      broadcastChannel = null;
      supabase.removeChannel(old);
    }
    lastClientPresenceMs = null;

    let _resolveReady;
    const _readyPromise = new Promise((resolve) => { _resolveReady = resolve; });

    const ch = supabase.channel(`bridge:${agentId}`, {
      config: { broadcast: { ack: false, self: false } },
    });

    ch.on("broadcast", { event: "user_message" }, (msg) => {
      const { conversation_id, content, user_id, title, request_id, workspace, images, model } = msg.payload;
      if (!content) return;

      let convId = conversation_id;
      let isNewConversation = false;

      // Check if this is a new conversation — either no ID provided (legacy)
      // or a client-generated ID that doesn't exist yet in our DB.
      const existingConv = convId ? localDb.getConversation(convId) : null;

      if (!convId || !existingConv) {
        if (!convId) convId = randomUUID();
        isNewConversation = true;
        const convTitle = title ?? (content.length > 80 ? content.substring(0, 80) + "..." : content);
        const convWorkspace = workspace ?? agentConfig.default_workspace ?? null;
        const createdAt = new Date().toISOString();

        localDb.insertConversation(convId, agentId, user_id, convTitle, createdAt, null, convWorkspace);

        broadcast("conversation_created", {
          conversation_id: convId,
          agent_id: agentId,
          title: convTitle,
          created_at: createdAt,
          workspace: convWorkspace,
          request_id: request_id,
        });
      }

      const parsedImages = Array.isArray(images) && images.length > 0 ? images : null;
      const selectedModel = typeof model === "string" && model.length > 0 ? model : null;
      enqueueMessage(convId, content, user_id, title, request_id, workspace, parsedImages, selectedModel);
    });

    ch.on("broadcast", { event: "stop_request" }, (msg) => {
      const { conversation_id } = msg.payload;
      if (conversation_id) {
        void handleStopRequest(conversation_id);
      }
    });

    ch.on("broadcast", { event: "fetch_history" }, (msg) => {
      const { conversation_id, request_id, limit } = msg.payload;
      if (conversation_id) {
        void handleFetchHistory(
          conversation_id,
          request_id,
          typeof limit === "number" ? limit : null,
        );
      }
    });

    ch.on("broadcast", { event: "fetch_conversations" }, (msg) => {
      const { request_id } = msg.payload;
      void handleFetchConversations(request_id);
    });

    ch.on("broadcast", { event: "fetch_since" }, (msg) => {
      const { conversation_id, since_seq, request_id } = msg.payload;
      if (!conversation_id || !request_id) return;
      const sinceSeq = typeof since_seq === "number" ? since_seq : 0;
      const messages = localDb.getMessagesSinceSeq(conversation_id, sinceSeq);
      const stateEntry = conversationStates.get(conversation_id);
      const currentSeq = stateEntry?.seq ?? localDb.getSeq(conversation_id);
      broadcast("since_response", {
        request_id,
        conversation_id,
        messages,
        seq: currentSeq,
        activity_state: stateEntry?.state ?? "idle",
        current_tool: stateEntry?.tool ?? null,
        permission_payload: stateEntry?.permissionPayload ?? null,
      });
    });

    ch.on("broadcast", { event: "delete_conversation" }, (msg) => {
      const { conversation_id } = msg.payload;
      if (conversation_id) {
        handleDeleteConversation(conversation_id);
      }
    });

    ch.on("broadcast", { event: "fetch_workspaces" }, (msg) => {
      const { request_id } = msg.payload;
      const fresh = loadSavedAgents().find((a) => a.agent_id === agentId);
      const workspacePaths = fresh?.workspaces ?? agentConfig.workspaces ?? [];
      const workspaces = workspacePaths.map((w) => getWorkspaceMetadata(w));
      broadcast("workspaces_response", {
        request_id,
        workspaces,
        default_workspace: fresh?.default_workspace ?? agentConfig.default_workspace ?? null,
      });
    });

    ch.on("broadcast", { event: "fetch_models" }, (msg) => {
      const { request_id } = msg.payload;
      const fresh = loadSavedAgents().find((a) => a.agent_id === agentId);
      const models = fresh?.model_aliases ?? agentConfig.model_aliases ?? [];
      broadcast("models_response", { request_id, models });
    });

    ch.on("broadcast", { event: "discover_workspaces" }, (msg) => {
      const { request_id } = msg.payload;
      const fresh = loadSavedAgents().find((a) => a.agent_id === agentId);
      const existing = fresh?.workspaces ?? agentConfig.workspaces ?? [];
      const discovered = discoverWorkspaces(existing);
      broadcast("discover_workspaces_response", {
        request_id,
        workspaces: discovered.map((d) => ({ path: d.path, name: d.name })),
      });
      dashboard.log(agentId, chalk.dim(`Workspace discovery: found ${discovered.length} candidates`));
    });

    ch.on("broadcast", { event: "add_workspace" }, (msg) => {
      const { request_id, path: wsPath } = msg.payload;
      if (!wsPath) {
        broadcast("add_workspace_response", { request_id, success: false, error: "No path provided" });
        return;
      }

      const resolvedPath = resolve(wsPath);
      if (!existsSync(resolvedPath)) {
        broadcast("add_workspace_response", { request_id, success: false, error: "Path does not exist" });
        return;
      }

      try {
        if (!statSync(resolvedPath).isDirectory()) {
          broadcast("add_workspace_response", { request_id, success: false, error: "Path is not a directory" });
          return;
        }
      } catch {
        broadcast("add_workspace_response", { request_id, success: false, error: "Cannot access path" });
        return;
      }

      const fresh = loadSavedAgents().find((a) => a.agent_id === agentId);
      const existing = fresh?.workspaces ?? agentConfig.workspaces ?? [];

      if (existing.includes(resolvedPath)) {
        broadcast("add_workspace_response", { request_id, success: false, error: "Workspace already added" });
        return;
      }

      const updated = [...existing, resolvedPath];
      const updates = { workspaces: updated };
      if (updated.length === 1) {
        updates.default_workspace = resolvedPath;
      }
      updateSavedAgent(agentId, updates);
      dashboard.log(agentId, chalk.green(`Workspace added remotely: ${basename(resolvedPath)}`));
      broadcast("add_workspace_response", { request_id, success: true, path: resolvedPath, name: basename(resolvedPath) });
    });

    ch.on("broadcast", { event: "remove_workspace" }, (msg) => {
      const { request_id, path: wsPath } = msg.payload;
      if (!wsPath) {
        broadcast("remove_workspace_response", { request_id, success: false, error: "No path provided" });
        return;
      }

      const fresh = loadSavedAgents().find((a) => a.agent_id === agentId);
      const existing = fresh?.workspaces ?? agentConfig.workspaces ?? [];
      const filtered = existing.filter((w) => w !== wsPath);

      if (filtered.length === existing.length) {
        broadcast("remove_workspace_response", { request_id, success: false, error: "Workspace not found" });
        return;
      }

      const updates = { workspaces: filtered };
      if (fresh?.default_workspace === wsPath) {
        updates.default_workspace = filtered[0] ?? null;
      }
      updateSavedAgent(agentId, updates);
      dashboard.log(agentId, chalk.yellow(`Workspace removed remotely: ${basename(wsPath)}`));
      broadcast("remove_workspace_response", { request_id, success: true });
    });

    ch.on("broadcast", { event: "permission_response" }, (msg) => {
      const { conversation_id, decision, request_id } = msg.payload;
      if (!conversation_id || !decision) return;

      const respFileName = request_id
        ? `resp-${conversation_id}-${request_id}.json`
        : `resp-${conversation_id}.json`;
      const respPath = join(PERM_DIR, respFileName);
      writeFileSync(respPath, JSON.stringify({ permission_response: decision }));

      conversationStates.set(conversation_id, { state: "thinking", tool: null, permissionPayload: null });
      dashboard.setConversationState(agentId, conversation_id, "thinking");
      broadcast("activity_state", {
        conversation_id,
        state: "thinking",
        current_tool: null,
        permission_payload: null,
      });

      dashboard.log(agentId, `${chalk.dim(`[${conversation_id.substring(0, 8)}]`)} ${chalk.green(`Permission: ${decision}`)}`);
    });

    ch.on("broadcast", { event: "toggle_artifacts" }, (msg) => {
      const { enabled, request_id } = msg.payload;
      const newValue = !!enabled;
      updateSavedAgent(agentId, { artifacts_enabled: newValue });
      agentConfig.artifacts_enabled = newValue;

      if (newValue) {
        startArtifactWatcher();
      } else {
        stopArtifactWatcher();
      }

      broadcast("artifacts_config_response", { request_id, artifacts_enabled: newValue });
      dashboard.log(agentId, chalk.cyan(`Screen sharing ${newValue ? "enabled" : "disabled"} (via lens)`));
    });

    ch.on("broadcast", { event: "fetch_artifacts_config" }, (msg) => {
      const { request_id } = msg.payload;
      const fresh = loadSavedAgents().find((a) => a.agent_id === agentId);
      broadcast("artifacts_config_response", {
        request_id,
        artifacts_enabled: fresh?.artifacts_enabled ?? agentConfig.artifacts_enabled ?? false,
      });
    });

    ch.on("broadcast", { event: "fetch_state" }, (msg) => {
      const { conversation_id, request_id } = msg.payload;
      if (!conversation_id) return;

      const conv = localDb.getConversation(conversation_id);
      if (!conv) {
        broadcast("state_response", {
          request_id,
          conversation_id,
          not_found: true,
        });
        return;
      }

      const stateInfo = conversationStates.get(conversation_id);
      broadcast("state_response", {
        request_id,
        conversation_id,
        activity_state: stateInfo?.state ?? "idle",
        current_tool: stateInfo?.tool ?? null,
        permission_payload: stateInfo?.permissionPayload ?? null,
        title: conv.title,
        created_at: conv.created_at,
        workspace: conv.workspace,
        seq: stateInfo?.seq ?? localDb.getSeq(conversation_id),
      });
    });

    ch.on("broadcast", { event: "open_in_cli" }, (msg) => {
      const { conversation_id } = msg.payload;
      if (!conversation_id) return;
      openConversationInCLI(conversation_id);
    });

    ch.on("broadcast", { event: "agent_removed" }, () => {
      dashboard.log(agentId, chalk.yellow.bold("Agent removed by lens — shutting down."));
      handleRemoteRemoval();
    });

    ch.on("broadcast", { event: "agent_message_ack" }, (msg) => {
      const { message_id } = msg.payload;
      if (message_id) pendingDeliveries.delete(message_id);
    });

    ch.on("broadcast", { event: "client_presence" }, () => {
      lastClientPresenceMs = Date.now();
      dashboard.setClientPresence(agentId);
    });

    broadcastChannel = ch;

    ch.subscribe((status) => {
      if (ch !== broadcastChannel) return;
      if (status === "SUBSCRIBED") {
        dashboard.log(agentId, chalk.green("Listening for messages"));
        dashboard.setAgentStatus(agentId, "online");
        reconnectAttempts = 0;
        _resolveReady();
        void sendPresence();
        startPresence();

        // Replay all unacked agent messages after reconnect — the lens
        // deduplicates by message_id so replaying recent messages is safe.
        const toReplay = [];
        for (const [msgId, entry] of pendingDeliveries) {
          toReplay.push([msgId, entry]);
        }
        if (toReplay.length > 0) {
          dashboard.log(agentId, chalk.yellow(`Replaying ${toReplay.length} unacked message(s) after reconnect`));
          for (const [, entry] of toReplay) {
            broadcast("agent_message", entry.payload);
          }
        }

        // Re-broadcast current activity state for any in-flight conversations so
        // the lens can resync without waiting for the next state transition.
        for (const [convId, { state, tool, permissionPayload, seq }] of conversationStates) {
          if (state !== "idle") {
            broadcast("activity_state", {
              conversation_id: convId,
              state,
              current_tool: tool ?? null,
              permission_payload: permissionPayload ?? null,
              seq: seq ?? localDb.getSeq(convId),
            });
          }
        }
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearInterval(presenceTimer);
        dashboard.log(agentId, chalk.yellow(`Broadcast ${status}. Reconnecting...`));
        dashboard.setAgentStatus(agentId, "reconnecting");
        scheduleReconnect();
      }
    });

    return _readyPromise;
  }

  function scheduleReconnect() {
    dashboard.setAgentStatus(agentId, "reconnecting");
    reconnectAttempts++;
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    setTimeout(async () => {
      startBroadcastListener();
    }, delay);
  }

  // Parse a permission request filename: "req-{convId}-{requestId}.json"
  // Returns { convId, requestId } or null if not a valid permission request file.
  function parsePermReqFilename(file) {
    if (!file.startsWith("req-") || !file.endsWith(".json")) return null;
    const inner = file.slice(4, -5); // strip "req-" and ".json"
    // UUIDs are 36 chars; new format: "{36}-{36}" = 73 chars
    if (inner.length === 73) {
      return { convId: inner.slice(0, 36), requestId: inner.slice(37) };
    }
    return null;
  }

  function restorePendingPermissions() {
    try {
      const files = readdirSync(PERM_DIR);
      for (const file of files) {
        const parsed = parsePermReqFilename(file);
        if (!parsed) continue;
        const { convId, requestId } = parsed;

        const conv = localDb.getConversation(convId);
        if (!conv || conv.agent_id !== agentId) continue;

        const respPath = join(PERM_DIR, `resp-${convId}-${requestId}.json`);
        if (existsSync(respPath)) continue;

        const reqPath = join(PERM_DIR, file);
        const req = JSON.parse(readFileSync(reqPath, "utf8"));
        const permPayload = { tool: req.tool, description: req.description, request_id: requestId };
        conversationStates.set(convId, { state: "awaiting_permission", tool: req.tool, permissionPayload: permPayload });
        localDb.upsertConversationState(convId, "awaiting_permission", req.tool, JSON.stringify(permPayload));
        dashboard.setConversationState(agentId, convId, "awaiting_permission");
        dashboard.log(agentId, `${chalk.dim(`[${convId.substring(0, 8)}]`)} ${chalk.yellow(`Restored pending permission: ${req.tool}`)}`);
      }
    } catch (err) {
      dashboard.log(agentId, chalk.red(`restorePendingPermissions error: ${err.message}`));
    }
  }

  function startPermissionWatcher() {
    restorePendingPermissions();
    permissionWatcherInterval = setInterval(() => {
      try {
        const files = readdirSync(PERM_DIR);
        for (const file of files) {
          const parsed = parsePermReqFilename(file);
          if (!parsed) continue;
          const { convId, requestId } = parsed;

          const conv = localDb.getConversation(convId);
          if (!conv) {
            dashboard.log(agentId, chalk.dim(`[perm-watcher] unknown conv ${convId.substring(0, 8)} — not in localDb`));
            continue;
          }
          if (conv.agent_id !== agentId) {
            dashboard.log(agentId, chalk.dim(`[perm-watcher] conv ${convId.substring(0, 8)} belongs to different agent, skipping`));
            continue;
          }

          const reqPath = join(PERM_DIR, file);
          const req = JSON.parse(readFileSync(reqPath, "utf8"));
          if (req.processed) continue;

          req.processed = true;
          writeFileSync(reqPath, JSON.stringify(req));

          const permPayload = { tool: req.tool, description: req.description, request_id: requestId };
          updateConversationState(convId, "awaiting_permission", req.tool, permPayload);

          dashboard.log(agentId, `${chalk.dim(`[${convId.substring(0, 8)}]`)} ${chalk.yellow(`Permission requested: ${req.tool}`)}`);
        }
      } catch (err) {
        dashboard.log(agentId, chalk.red(`Permission watcher error: ${err.message}`));
      }
    }, 1000);
  }

  function stopPermissionWatcher() {
    if (permissionWatcherInterval) {
      clearInterval(permissionWatcherInterval);
      permissionWatcherInterval = null;
    }
  }

  function startArtifactWatcher() {
    if (artifactWatcherInterval) return;
    let processing = false;
    artifactWatcherInterval = setInterval(async () => {
      if (processing) return;
      processing = true;
      try {
        const files = readdirSync(ARTIFACTS_DIR);
        for (const file of files) {
          if (!file.startsWith("artifact-") || !file.endsWith(".json")) continue;

          const filePath = join(ARTIFACTS_DIR, file);
          const artifact = JSON.parse(readFileSync(filePath, "utf8"));

          const convId = artifact.conversation_id;
          if (!convId) {
            try { unlinkSync(filePath); } catch (_) {}
            continue;
          }

          const conv = localDb.getConversation(convId);
          if (!conv || conv.agent_id !== agentId) continue;

          const payload = {
            conversation_id: convId,
            type: artifact.type ?? "image",
            label: artifact.label ?? null,
            images: [{ data: artifact.data }],
          };

          const payloadSize = JSON.stringify(payload).length;
          const shortId = convId.substring(0, 8);

          if (payloadSize > 256_000) {
            dashboard.log(agentId, `${chalk.dim(`[${shortId}]`)} ${chalk.yellow(`Artifact payload is ${Math.round(payloadSize / 1024)}KB — may exceed Supabase broadcast limit`)}`);
          }

          const sent = await broadcast("artifact", payload);
          if (sent) {
            try { unlinkSync(filePath); } catch (_) {}
            dashboard.log(agentId, `${chalk.dim(`[${shortId}]`)} ${chalk.cyan(`Artifact sent (${Math.round(payloadSize / 1024)}KB): ${artifact.type ?? "image"}${artifact.label ? ` — ${artifact.label}` : ""}`)}`);
          } else {
            dashboard.log(agentId, `${chalk.dim(`[${shortId}]`)} ${chalk.yellow(`Artifact broadcast failed, will retry: ${artifact.type ?? "image"}`)}`);
          }
        }
      } catch (_) {}
      processing = false;
    }, 1000);
  }

  function stopArtifactWatcher() {
    if (artifactWatcherInterval) {
      clearInterval(artifactWatcherInterval);
      artifactWatcherInterval = null;
    }
  }

  async function shutdown() {
    stopPermissionWatcher();
    stopArtifactWatcher();
    clearInterval(heartbeatTimer);
    clearInterval(presenceTimer);
    if (deletionChannel) {
      supabase.removeChannel(deletionChannel);
      deletionChannel = null;
    }
    // Broadcast offline signal before removing the channel so the lens reacts
    // immediately rather than waiting for DB propagation or the stale timer.
    await broadcast("bridge_offline", {});
    if (broadcastChannel) {
      supabase.removeChannel(broadcastChannel);
      broadcastChannel = null;
    }
    try {
      await restPatch("bridge_agents", agentId, { status: "offline", last_seen_at: new Date().toISOString() });
    } catch {}
    dashboard.setAgentStatus(agentId, "offline");
  }

  async function start() {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { heartbeatIntervalMs: 2500 },
    });

    dashboard.log(agentId, chalk.green("Connected"));
    dashboard.setAgentStatus(agentId, "online");

    const existingConvs = localDb.getConversations(agentId);
    for (const c of existingConvs) {
      dashboard.setConversationTitle(agentId, c.id, c.title, new Date(c.created_at).getTime());
    }

    // Restore persisted conversation states from SQLite so activity states
    // survive bridge restarts (e.g. "thinking", "awaiting_permission").
    const savedStates = localDb.getConversationStatesForAgent(agentId);
    for (const row of savedStates) {
      let permPayload = null;
      if (row.permission_payload) {
        try { permPayload = JSON.parse(row.permission_payload); } catch {}
      }
      conversationStates.set(row.conversation_id, {
        state: row.state,
        tool: row.tool ?? null,
        permissionPayload: permPayload,
        seq: row.seq ?? 0,
      });
      dashboard.setConversationState(agentId, row.conversation_id, row.state);
    }

    await driver.setup();
    if (driver.configure) {
      driver.configure({
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_ANON_KEY,
        artifactsEnabled: agentConfig.artifacts_enabled ?? false,
        getAccessToken: async () => SUPABASE_ANON_KEY,
      });
    }
    // Start broadcast listener and heartbeat in parallel — the lens can detect
    // us via broadcast presence before the DB heartbeat round-trip completes.
    const [broadcastReady] = await Promise.all([
      startBroadcastListener(),
      restPatch("bridge_agents", agentId, { status: "online", last_seen_at: new Date().toISOString() })
        .then(() => dashboard.setHeartbeat(agentId, true))
        .catch((err) => {
          dashboard.log(agentId, chalk.yellow(`Initial heartbeat failed: ${err.message}`));
          dashboard.setHeartbeat(agentId, false);
        }),
    ]);
    startDeletionWatcher();
    startPermissionWatcher();
    if (agentConfig.artifacts_enabled) {
      startArtifactWatcher();
    }
    // Age out pending deliveries that were never acked (30 min TTL).
    // Also enforce a size cap to prevent unbounded memory growth.
    const PENDING_TTL_MS = 30 * 60 * 1000;
    const PENDING_MAX_SIZE = 500;
    setInterval(() => {
      const cutoff = Date.now() - PENDING_TTL_MS;
      for (const [msgId, entry] of pendingDeliveries) {
        if (entry.timestamp < cutoff) pendingDeliveries.delete(msgId);
      }
      if (pendingDeliveries.size > PENDING_MAX_SIZE) {
        const sorted = [...pendingDeliveries.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = sorted.slice(0, sorted.length - PENDING_MAX_SIZE);
        for (const [msgId] of toRemove) pendingDeliveries.delete(msgId);
      }
    }, 60_000);
    startHeartbeat();
    return true;
  }

  async function broadcastConversationCreated(conversationId, title, createdAt, workspace) {
    const sent = await broadcast("conversation_created", {
      conversation_id: conversationId,
      agent_id: agentId,
      title,
      created_at: createdAt,
      workspace: workspace ?? null,
    });
    if (sent) {
      dashboard.log(agentId, chalk.dim(`[scan] broadcast conversation_created for ${conversationId.substring(0, 8)}`));
    } else {
      dashboard.log(agentId, chalk.yellow(`[scan] conversation_created broadcast failed for ${conversationId.substring(0, 8)}`));
    }
  }

  return { start, shutdown, agentId, openConversation: openConversationInCLI, broadcastConversationCreated };
}

// ── Run Selected Agents ─────────────────────────────────────────────────────

async function runAgents(agentConfigs) {
  let dashboard, instances;

  if (activeAgentSession) {
    // Re-entering the dashboard after returning to menu — reuse existing agents
    ({ dashboard, instances } = activeAgentSession);
    dashboard.setup();
  } else {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error(chalk.red("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env"));
      process.exit(1);
    }

    preventSleep();

    const bridgeConfigs = agentConfigs.filter((c) => c.agent_type !== "cursor_cloud");

    if (bridgeConfigs.length === 0) {
      console.log(chalk.yellow("\n  No agents to activate.\n"));
      return "back";
    }

    dashboard = new Dashboard();
    for (const config of bridgeConfigs) {
      const label = DRIVER_MAP[config.agent_type]?.label ?? config.agent_type;
      dashboard.addAgent(config.agent_id, config.name ?? label, config.agent_type);
    }
    dashboard.setup();

    instances = [];
    for (const config of bridgeConfigs) {
      const driver = await loadDriver(config.agent_type);
      const instance = createBridgeInstance(config, driver, dashboard);
      const ok = await instance.start();
      if (ok) instances.push(instance);
    }

    if (instances.length === 0) {
      dashboard.teardown();
      console.error(chalk.red("\nNo agents started successfully."));
      process.exit(1);
    }

    activeAgentSession = { instances, dashboard };
  }

  return new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      dashboard.log(null, chalk.dim("Shutting down..."));
      await Promise.allSettled(instances.map((i) => i.shutdown()));
      dashboard.teardown();
      activeAgentSession = null;
      console.log(chalk.dim("  All agents offline."));
      process.exit(0);
    };

    const goBack = () => {
      dashboard.teardown();
      resolve("back");
    };

    process.on("SIGTERM", shutdown);
    dashboard.onQuit = shutdown;
    dashboard.onBack = goBack;
    dashboard.onOpenConversation = (selectedAgentId, convId) => {
      const inst = instances.find((i) => i.agentId === selectedAgentId);
      inst?.openConversation(convId);
    };
    let scanSessionsActive = false;
    dashboard.onScanSessions = async (selectedAgentId) => {
      if (scanSessionsActive) return;
      scanSessionsActive = true;

      const agentConfig = instances.find((i) => i.agentId === selectedAgentId)
        ? loadSavedAgents().find((a) => a.agent_id === selectedAgentId)
        : loadSavedAgents()[0];

      if (!agentConfig || agentConfig.agent_type !== "claude") {
        scanSessionsActive = false;
        return;
      }

      dashboard.teardown();
      process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
      const result = await scanAndAttachClaudeSession(agentConfig);
      if (result?.message) console.log(result.message);

      if (result?.ok) {
        // Update dashboard in-memory state so the conversation appears immediately.
        dashboard.setConversationTitle(result.agentId, result.sessionId, result.projectName, Date.now());
        dashboard.log(result.agentId, chalk.cyan(`Attached session: ${result.projectName} (${result.sessionId.substring(0, 8)}…)`));

        // Broadcast conversation_created so the webapp is notified.
        const inst = instances.find((i) => i.agentId === result.agentId);
        if (inst?.broadcastConversationCreated) {
          inst.broadcastConversationCreated(result.sessionId, result.projectName, result.createdAt, null);
        }
      }

      await new Promise((r) => setTimeout(r, 1200));
      scanSessionsActive = false;
      dashboard.setup();
    };
  });
}

// ── Caffeinate ──────────────────────────────────────────────────────────────

function preventSleep() {
  if (platform() !== "darwin") return;
  const child = spawn("caffeinate", ["-is", "-w", String(process.pid)], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

// ── Entry Point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("activate-all")) {
  const envError = checkEnv();
  if (envError) {
    console.error(envError);
    process.exit(1);
  }
  const agents = loadSavedAgents();
  if (agents.length === 0) {
    console.error(chalk.red("No saved agents found. Run without arguments to add agents."));
    process.exit(1);
  }
  await runAgents(agents);
} else {
  while (true) {
    const { action, agents } = await mainMenu();
    if (action === "start" || action === "resume") {
      await runAgents(action === "start" ? agents : null);
      // runAgents only returns when "back" was pressed; loop back to menu
    }
    // "exit" is handled by process.exit(0) inside mainMenu's switch
  }
}
