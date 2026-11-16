// End-to-end tests against a scripted fake of the Anthropic client, so the
// real tool loop, delegation, guard rails and HTTP routes run without an API key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-test-'));
process.env.PORT = '3197';
process.env.APP_PASSWORD = 'pw:with-colon';
process.env.DEMO_DELAY_MS = '0';
delete process.env.ANTHROPIC_API_KEY;

await import('../server.js');
const { db } = await import('../src/db.js');
const { startRun, setClient, buildSystemPrompt, MAX_STEPS } = await import('../src/runtime.js');
const { tick } = await import('../src/scheduler.js');

const BASE = 'http://localhost:3197';
const AUTH = { Authorization: `Basic ${Buffer.from('me:pw:with-colon').toString('base64')}`, 'Content-Type': 'application/json' };
const http = (method, url, body) => fetch(BASE + url, { method, headers: AUTH, body: body && JSON.stringify(body) });

const usage = { input_tokens: 10, output_tokens: 5 };
const text = (t) => ({ type: 'text', text: t });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (stop_reason, ...content) => ({ stop_reason, content, usage });

/** Fake client: each agent gets a list of scripted responses, consumed in order. */
function fakeClient(scripts) {
  const calls = [];
  const create = async (params) => {
    const name = /^You are ([^,]+),/.exec(params.system)[1];
    calls.push({ name, params: structuredClone(params) });
    const next = scripts[name]?.shift();
    if (!next) throw new Error(`no scripted response left for ${name}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(params) : next;
  };
  return { calls, messages: { create }, beta: { messages: { create } } };
}

test('demo mode returns a labelled placeholder and creates nothing', async () => {
  setClient(null);
  const run = await startRun({ agentId: 'lead-finder', task: 'Find leads' }).promise;
  assert.equal(run.status, 'done');
  assert.equal(run.demo, true);
  assert.match(run.output, /^\[DEMO MODE\]/);
  assert.equal(db.leads.length + db.approvals.length + db.notes.length, 0);
});

test('delegation chain, pause_turn, lead guard, approvals, and tool refusals', async () => {
  const client = fakeClient({
    Chief: [
      reply('tool_use', use('c1', 'delegate', { agent_id: 'lead-finder', task: 'skip a level' }), use('c2', 'delegate', { agent_id: 'sales-manager', task: 'Find leads' })),
      reply('end_turn', text('Summary for the owner.')),
    ],
    'Sales Manager': [
      reply('tool_use', use('s1', 'delegate', { agent_id: 'lead-finder', task: 'Find 1 lead' })),
      reply('end_turn', text('Pipeline updated.')),
    ],
    'Lead Finder': [
      reply('tool_use', use('l0', 'save_lead', { company: 'Too Early Ltd', source_url: 'https://acme.example/team', priority: 'P1' })),
      reply('pause_turn', { type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'acme team' } }),
      reply(
        'tool_use',
        { type: 'web_search_tool_result', tool_use_id: 'st1', content: [{ type: 'web_search_result', url: 'https://www.acme.example/team', title: 'Acme team' }] },
        text('I also saw https://invented.example/contact mentioned.'),
        use('l1', 'save_lead', { company: 'Acme', contact_name: 'Ada', email: 'ada@acme.example', source_url: 'https://acme.example/team', priority: 'P1' }),
        use('l2', 'save_lead', { company: 'Invented Inc', source_url: 'https://invented.example/contact', priority: 'P2' }),
        use('l3', 'send_email', { to: 'ada@acme.example', body: 'hi' }),
        use('l4', 'delegate', { agent_id: 'chief', task: 'x' }),
        use('l5', 'request_approval', { type: 'email', title: 'Intro to Acme', to: 'ada@acme.example', subject: 'Hello', body: 'Hi Ada' }),
        use('l6', 'save_lead', { company: 'Acme', email: 'ada@acme.example', source_url: 'https://acme.example/team', priority: 'P1' }),
      ),
      reply('end_turn', text('Saved 1 lead, filed 1 email.')),
    ],
  });
  setClient(client);
  const run = await startRun({ agentId: 'chief', task: 'Get me leads' }).promise;

  assert.equal(run.status, 'done');
  assert.equal(run.output, 'Summary for the owner.');
  assert.deepEqual(run.usage, { inputTokens: 20, outputTokens: 10, webSearches: 0, apiCalls: 2 });

  // Run tree: chief -> sales-manager -> lead-finder, with depth and parent links.
  const sm = db.runs.find((r) => r.parentRunId === run.id);
  const lf = db.runs.find((r) => r.parentRunId === sm.id);
  assert.deepEqual([sm.agentId, sm.trigger, sm.depth, lf.agentId, lf.depth], ['sales-manager', 'delegated', 2, 'lead-finder', 3]);
  assert.equal(lf.usage.apiCalls, 4);

  // Chief may only delegate to direct reports.
  const chiefResults = client.calls.filter((c) => c.name === 'Chief')[1].params.messages.at(-1).content;
  assert.equal(chiefResults[0].is_error, true);
  assert.match(chiefResults[0].content, /direct reports/);
  assert.match(chiefResults[1].content, /Pipeline updated\./);

  // Lead Finder is at max depth and has no reports: no delegate tool offered.
  const lfCalls = client.calls.filter((c) => c.name === 'Lead Finder');
  const offered = lfCalls[0].params.tools.map((t) => t.name);
  assert.deepEqual(offered, ['web_search', 'save_lead', 'list_leads', 'request_approval']);
  assert.deepEqual(lfCalls[0].params.tools[0], { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });

  // Each agent runs on its own model; the fallback beta is only sent where supported.
  assert.deepEqual([run.model, sm.model, lf.model], ['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  assert.equal(client.calls[0].params.model, 'claude-fable-5-2');
  assert.equal(lfCalls[0].params.fallbacks, 'default');

  // pause_turn: the paused assistant turn is resent as-is with no extra user message.
  const afterPause = lfCalls[2].params.messages;
  assert.equal(afterPause.at(-1).role, 'assistant');
  assert.equal(afterPause.at(-1).content[0].type, 'server_tool_use');

  // Tool results: one message, in order, with the guard rails applied.
  const results = lfCalls[3].params.messages.at(-1).content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  assert.deepEqual(results.map((r) => Boolean(r.is_error)), [false, true, true, true, false, false]);
  assert.match(results[1].content, /did not appear in your web search results/);
  assert.match(results[2].content, /not available/);
  assert.match(results[5].content, /Already in the CRM/);

  assert.deepEqual(db.leads.map((l) => l.company), ['Acme']); // not "Too Early", not "Invented"
  assert.equal(db.leads[0].foundBy, 'lead-finder');
  assert.equal(db.approvals.length, 1);
  assert.equal(db.approvals[0].status, 'pending');
  assert.ok(lf.steps.some((s) => s.type === 'tool_error') && lf.steps.some((s) => s.type === 'search_result'));
});

test('step cap, API failure and refusal', async () => {
  const loop = () => reply('tool_use', use(`n${Math.random()}`, 'search_notes', { query: '' }));
  setClient(fakeClient({ Planner: Array(20).fill(loop) }));
  const capped = await startRun({ agentId: 'planner', task: 'loop' }).promise;
  assert.equal(capped.status, 'done');
  assert.equal(capped.capped, true);
  assert.equal(capped.usage.apiCalls, MAX_STEPS);
  assert.match(capped.output, /12-step cap/);

  setClient(fakeClient({ Planner: [new Error('boom')] }));
  const failed = await startRun({ agentId: 'planner', task: 'x' }).promise;
  assert.deepEqual([failed.status, failed.error], ['failed', 'boom']);

  setClient(fakeClient({ Planner: [{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage }] }));
  const refused = await startRun({ agentId: 'planner', task: 'x' }).promise;
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /declined.*cyber/);
});

test('per-agent model: Haiku gets basic web search and no fallback; empty falls back to default', async () => {
  const lf = db.agents.find((a) => a.id === 'lead-finder');
  const client = fakeClient({ 'Lead Finder': [reply('end_turn', text('ok')), reply('end_turn', text('ok'))] });
  setClient(client);
  lf.model = 'claude-haiku-5-5';
  await startRun({ agentId: 'lead-finder', task: 'x' }).promise;
  lf.model = '';
  const second = await startRun({ agentId: 'lead-finder', task: 'x' }).promise;
  const [haiku, dflt] = client.calls.map((c) => c.params);
  assert.equal(haiku.model, 'claude-haiku-5-5');
  assert.equal(haiku.tools[0].type, 'web_search_20250305');
  assert.equal(haiku.fallbacks, undefined);
  assert.deepEqual([dflt.model, second.model], ['claude-opus-5-5', 'claude-opus-5-5']);
  assert.equal((await http('PUT', '/api/agents/lead-finder', { model: 'gpt-9' })).status, 400);
  assert.equal((await (await http('PUT', '/api/agents/lead-finder', { model: 'claude-sonnet-5-5' })).json()).model, 'claude-sonnet-5-5');
});

test('system prompt carries identity, context, manager and reports', () => {
  db.settings.ownerContext = 'We sell hats.';
  const p = buildSystemPrompt(db.agents.find((a) => a.id === 'sales-manager'));
  for (const s of ['You are Sales Manager, Head of Sales at Main Company', 'We sell hats.', 'You report to Chief', '- lead-finder: Lead Finder', 'Never sends, publishes, books or spends', 'request_approval']) {
    assert.ok(p.includes(s), `missing: ${s}`);
  }
});

test('night shift runs agents with a nightTask once per day at the set time', async () => {
  setClient(null);
  const before = db.runs.length;
  Object.assign(db.settings.nightShift, { enabled: true, time: '02:00', lastRunDate: null });
  assert.equal(tick(new Date(2026, 0, 5, 1, 59)), false);
  assert.equal(tick(new Date(2026, 0, 5, 2, 1)), true);
  assert.equal(tick(new Date(2026, 0, 5, 2, 2)), false); // already ran today
  await new Promise((r) => setTimeout(r, 100));
  const night = db.runs.slice(before);
  assert.deepEqual(night.map((r) => [r.agentId, r.trigger, r.status]), [['trend-researcher', 'night', 'done']]);
  db.settings.nightShift.enabled = false;
  assert.equal(tick(new Date(2026, 0, 6, 2, 0)), false);
});

test('HTTP: basic auth, approvals workflow, leads, manager deletion', async () => {
  assert.equal((await fetch(`${BASE}/api/state`)).status, 401);
  assert.equal((await fetch(`${BASE}/`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/state`, { headers: { Authorization: `Basic ${Buffer.from('me:wrong').toString('base64')}` } })).status, 401);
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200);

  const state = await (await http('GET', '/api/state')).json();
  assert.equal(state.approvals.length, 1);
  assert.equal(state.runs[0].steps, undefined); // state stays light; steps come from /api/runs/:id
  const id = state.approvals[0].id;

  assert.equal((await http('PUT', `/api/approvals/${id}`, { body: 'Hi Ada, edited' })).status, 200);
  assert.equal((await (await http('GET', '/api/approvals?status=pending')).json()).length, 1);
  const approved = await (await http('POST', `/api/approvals/${id}/approve`)).json();
  assert.deepEqual([approved.status, approved.body], ['approved', 'Hi Ada, edited']);
  assert.equal((await http('POST', `/api/approvals/${id}/reject`)).status, 409);
  assert.equal((await http('PUT', `/api/approvals/${id}`, { body: 'x' })).status, 409);
  assert.equal((await http('DELETE', `/api/approvals/${id}`)).status, 200);

  const lead = (await (await http('GET', '/api/leads?priority=P1')).json())[0];
  assert.equal((await http('PUT', `/api/leads/${lead.id}`, { priority: 'P9' })).status, 400);
  assert.equal((await (await http('PUT', `/api/leads/${lead.id}`, { priority: 'P3' })).json()).priority, 'P3');
  assert.equal((await (await http('GET', '/api/leads?priority=P1')).json()).length, 0);
  assert.equal((await http('DELETE', `/api/leads/${lead.id}`)).status, 200);

  // Deleting a manager moves its reports up one level.
  assert.equal((await http('DELETE', '/api/agents/sales-manager')).status, 200);
  for (const a of db.agents.filter((x) => ['lead-finder', 'outbound-writer', 'inbound-responder'].includes(x.id))) assert.equal(a.reportsTo, 'chief');

  // The database on disk is valid JSON and matches memory.
  await new Promise((r) => setTimeout(r, 50));
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8'));
  assert.equal(onDisk.agents.length, db.agents.length);
});

test.after(() => setTimeout(() => process.exit(0), 50));
