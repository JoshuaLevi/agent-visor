#!/usr/bin/env node
// AgentVisor — end-to-end flow test (no auth required)
// Usage: node test-flow.js
// Requires .env.local with SUPABASE_URL and SUPABASE_ANON_KEY

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const raw = readFileSync(join(__dir, '.env.local'), 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  } catch {
    console.error('ERROR: .env.local not found.');
    process.exit(1);
  }
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL;
const ANON_KEY     = env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label, value) {
  console.log(`  ✓  ${label}`);
  passed++;
  return value;
}

function fail(label, detail) {
  console.error(`  ✗  ${label}`);
  console.error(`     ${detail}`);
  failed++;
  return null;
}

async function rest(method, path, body) {
  const res = await fetch(`${REST}${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function stepRegister() {
  const res = await rest('POST', '/bridge_agents', { name: 'test-agent-e2e', agent_type: 'claude' });
  if (res.status === 201 && res.body?.[0]?.id) {
    return ok(`register agent → id ${res.body[0].id.slice(0, 8)}…`, res.body[0].id);
  }
  return fail('register agent', JSON.stringify(res.body));
}

async function stepList(expectedId) {
  const res = await rest('GET', '/bridge_agents?select=id,name,status');
  if (res.status === 200 && Array.isArray(res.body)) {
    const found = res.body.find(a => a.id === expectedId);
    if (found) return ok(`list agents — test agent found (${res.body.length} total)`, res.body);
    return fail('list agents', `test agent ${expectedId} not in results`);
  }
  return fail('list agents', JSON.stringify(res.body));
}

async function stepHeartbeat(agentId, status) {
  const res = await rest('PATCH', `/bridge_agents?id=eq.${agentId}`, {
    status,
    last_seen_at: new Date().toISOString(),
  });
  if (res.status === 200) {
    return ok(`heartbeat → status "${status}"`, true);
  }
  return fail(`heartbeat (${status})`, JSON.stringify(res.body));
}

async function stepReadBack(agentId, expectedStatus) {
  const res = await rest('GET', `/bridge_agents?id=eq.${agentId}&select=status`);
  if (res.status === 200 && res.body?.[0]?.status === expectedStatus) {
    return ok(`read back status — "${expectedStatus}" confirmed in DB`, true);
  }
  return fail('read back status', JSON.stringify(res.body));
}

async function stepDelete(agentId) {
  const res = await rest('DELETE', `/bridge_agents?id=eq.${agentId}`);
  if (res.status === 204 || res.status === 200) {
    return ok('delete agent (cleanup)', true);
  }
  return fail('delete agent', `status ${res.status}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('AgentVisor — E2E flow test');
  console.log(`Target : ${SUPABASE_URL}`);
  console.log('');

  console.log('[ 1/5 ] Register');
  const agentId = await stepRegister();
  if (!agentId) { process.exit(1); }

  console.log('\n[ 2/5 ] List');
  await stepList(agentId);

  console.log('\n[ 3/5 ] Heartbeats');
  await stepHeartbeat(agentId, 'online');
  await stepHeartbeat(agentId, 'awaiting_permission');
  await stepHeartbeat(agentId, 'idle');

  console.log('\n[ 4/5 ] Read back');
  await stepReadBack(agentId, 'idle');

  console.log('\n[ 5/5 ] Cleanup');
  await stepDelete(agentId);

  console.log('');
  console.log('─'.repeat(40));
  console.log(`  Passed : ${passed}`);
  console.log(`  Failed : ${failed}`);
  console.log('');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
