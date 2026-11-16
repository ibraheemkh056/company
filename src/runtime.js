// Agent runtime: builds the system prompt, drives the Messages API tool loop,
// logs every step to the run, and records token usage.
import Anthropic from '@anthropic-ai/sdk';
import { db, save, newId, now } from './db.js';
import { toolsFor, runTool, directReports, hostOf, modelFor, DEFAULT_MODEL } from './tools.js';

export const MAX_STEPS = 12;
export const MAX_DEPTH = 3;
export const MODEL = DEFAULT_MODEL;
const EFFORT = process.env.EFFORT ?? 'medium';
const MAX_TOKENS = 16000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Models whose safety classifiers can decline a request; for these we let the
// API retry a declined request on Anthropic's recommended fallback model.
const useFallback = (model) =>
  process.env.REFUSAL_FALLBACK !== 'off' && /^claude-(fable-5-[12]|mythos-5-[12]|opus-5(-5)?|sonnet-5-5)$/.test(model);

let client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
export const isDemo = () => !client;
/** Test hook: swap in a fake client (or null for demo mode). */
export const setClient = (c) => {
  client = c;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 1500) => (s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s);

function log(run, type, text) {
  run.steps.push({ at: now(), type, text: clip(String(text), 4000) });
  save();
}

export function buildSystemPrompt(agent) {
  const company = db.companies.find((c) => c.id === agent.companyId);
  const manager = db.agents.find((a) => a.id === agent.reportsTo);
  const reports = directReports(agent.id);
  const has = (t) => (agent.tools || []).includes(t);
  const { holdingName, ownerContext } = db.settings;

  const parts = [
    `You are ${agent.name}, ${agent.title || 'team member'}${company ? ` at ${company.name}` : ''}. You are one of the AI agents in the Agent HQ of ${holdingName || 'the owner\'s holding'}, and you work for its owner.`,
    company?.description ? `About ${company.name}: ${company.description}` : '',
    `## Your mission\n${agent.mission || 'Help the owner with whatever task you are given.'}`,
    agent.rule ? `## Your standing rule\n${agent.rule}` : '',
    ownerContext ? `## The owner's business\n${ownerContext}` : '',
    `## Where you sit\n${
      manager
        ? `You report to ${manager.name} (${manager.title}). Tasks usually arrive from them, and your final answer goes back to them.`
        : 'You report directly to the owner. Your final answer is read by the owner.'
    }${
      reports.length
        ? `\n\nYour direct reports${has('delegate') ? ' (hand work to them with the delegate tool, using these ids)' : ''}:\n${reports
            .map((r) => `- ${r.id}: ${r.name}, ${r.title}. ${r.mission}`)
            .join('\n')}`
        : ''
    }`,
    `## How work leaves the building\nNothing you do reaches the outside world on its own. You have no way to send email, publish, book or spend, and that is by design: the owner personally reviews everything outward-facing. When a task calls for an email, a post, a calendar booking or any other outward action, write it out in full and file it with request_approval, one request per item, worded exactly as it should go out. Filing a request sends nothing, so never tell anyone that something was sent, posted or booked; say it is waiting for approval.`,
    has('web_search') || has('save_lead')
      ? `## Facts, contacts and leads\nThe owner acts on what you report, so names, email addresses, figures and links must come from pages you actually found with web search in this run. If you could not find something, say so or leave the field empty; an invented contact wastes real outreach. A lead can only be saved with the source URL of the search result where you found it.`
      : `## Facts and contacts\nThe owner acts on what you report. Use only names, addresses and figures you were given in the task or found in the CRM or the brain; if something is missing, say so rather than filling the gap.`,
    `## Your final answer\nYour last message is the hand-off. Lead with the outcome, keep it short, and list what you saved or filed for approval and anything you could not do. You have at most ${MAX_STEPS} steps, so plan your tool calls and wrap up in good time.`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

// Collects the hostnames of pages that genuinely came back from server-side
// tools (search results and citations). Model-written text and tool inputs are
// skipped, so an agent cannot whitelist a URL just by mentioning it.
const SKIP_BLOCKS = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use', 'fallback']);
function harvestHosts(content, seen, sources) {
  const add = (url, title) => {
    const host = hostOf(url);
    if (!host) return;
    seen.add(host);
    if (title !== undefined && sources.length < 40 && !sources.some((s) => s.url === url)) sources.push({ url, title: String(title || '').slice(0, 200) });
  };
  const scan = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'encrypted_content' || key === 'encrypted_index') return;
      for (const m of v.matchAll(/https?:\/\/[^\s"'<>)\]\\]+/g)) add(m[0]);
    } else if (Array.isArray(v)) v.forEach((x) => scan(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, k);
  };
  for (const block of content) {
    if (block.type === 'text') for (const c of block.citations || []) if (c.url) add(c.url, c.title);
    if (block.type === 'text' || SKIP_BLOCKS.has(block.type)) continue;
    scan(block);
  }
}

function logResponse(run, content) {
  for (const b of content) {
    if (b.type === 'text' && b.text.trim()) log(run, 'text', b.text.trim());
    else if (b.type === 'server_tool_use') log(run, 'search', `${b.name}: ${b.input?.query ?? clip(JSON.stringify(b.input ?? {}), 300)}`);
    else if (b.type === 'web_search_tool_result') {
      const c = b.content;
      log(run, 'search_result', Array.isArray(c) ? `${c.length} result(s): ${c.slice(0, 5).map((r) => r.title).join(' · ')}` : `Search error: ${c?.error_code || 'unknown'}`);
    } else if (b.type === 'tool_use') log(run, 'tool_call', `${b.name} ${JSON.stringify(b.input)}`);
    else if (b.type === 'fallback') log(run, 'info', `${b.from?.model} declined; ${b.to?.model} continued.`);
  }
}

function addUsage(run, usage = {}) {
  const u = run.usage;
  u.inputTokens += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  u.outputTokens += usage.output_tokens || 0;
  u.webSearches += usage.server_tool_use?.web_search_requests || 0;
  u.apiCalls += 1;
}

function describeError(err, model) {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.PermissionDeniedError) return `Anthropic denied access (403): ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Model "${model}" was not found (404). Check the agent's model setting or the MODEL env var.`;
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic (429) after retries. Try again shortly.';
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
  return err?.message || String(err);
}

function callApi(params) {
  if (useFallback(params.model)) return client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' });
  return client.messages.create(params);
}

async function toolLoop(run, agent, depth) {
  const tools = toolsFor(agent, depth, MAX_DEPTH, run.model);
  const ctx = {
    run, agent,
    allowed: new Set(tools.filter((t) => !t.type).map((t) => t.name)),
    seenHosts: new Set(),
    delegate: (agentId, task) => startRun({ agentId, task, trigger: 'delegated', parentRunId: run.id, depth: depth + 1 }).promise,
  };
  const manager = db.agents.find((a) => a.id === agent.reportsTo);
  const from = run.trigger === 'delegated' && manager ? `your manager, ${manager.name}` : run.trigger === 'night' ? 'the owner (standing night-shift task)' : 'the owner';
  const messages = [{ role: 'user', content: `Today is ${new Date().toDateString()}.\n\nTask from ${from}:\n\n${run.task}` }];
  const params = { model: run.model, max_tokens: MAX_TOKENS, system: buildSystemPrompt(agent), tools, messages };
  if (EFFORT) params.output_config = { effort: EFFORT };

  let lastText = '';
  for (let step = 1; step <= MAX_STEPS; step++) {
    const res = await callApi(params);
    addUsage(run, res.usage);
    harvestHosts(res.content, ctx.seenHosts, run.sources);
    logResponse(run, res.content);
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (text) lastText = text;

    if (res.stop_reason === 'refusal') {
      throw new Error(`The model declined this task${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}.${res.stop_details?.explanation ? ` ${res.stop_details.explanation}` : ''}`);
    }
    // The full content goes back unchanged so thinking and server-tool blocks stay valid.
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'tool_use') {
      const results = [];
      for (const block of res.content.filter((b) => b.type === 'tool_use')) {
        try {
          const out = await runTool(block.name, block.input, ctx);
          log(run, 'tool_result', `${block.name} → ${out}`);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
        } catch (err) {
          log(run, 'tool_error', `${block.name} → ${err.message}`);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (res.stop_reason === 'pause_turn') {
      // A long server-tool turn paused; resending the conversation resumes it.
      log(run, 'info', 'Turn paused by the API; resuming.');
      continue;
    }
    run.output = text || lastText;
    if (res.stop_reason === 'max_tokens') run.output += '\n\n[Cut off: the response hit the output token limit.]';
    return;
  }
  run.capped = true;
  run.output = `${lastText}\n\n[Stopped: reached the ${MAX_STEPS}-step cap before finishing.]`.trim();
  log(run, 'info', `Stopped at the ${MAX_STEPS}-step cap.`);
}

async function demoRun(run, agent) {
  log(run, 'info', 'Demo mode: no ANTHROPIC_API_KEY is set, so no model was called.');
  await sleep(Number(process.env.DEMO_DELAY_MS ?? 1500));
  run.demo = true;
  run.output = `[DEMO MODE] This is a placeholder, not real work. ${agent.name} received the task below but no AI model ran, and no leads, notes or approvals were created. Set ANTHROPIC_API_KEY and restart to run agents for real.\n\nTask received:\n${run.task}`;
}

async function execute(run, agent, depth) {
  try {
    if (client) await toolLoop(run, agent, depth);
    else await demoRun(run, agent);
    run.status = 'done';
  } catch (err) {
    run.status = 'failed';
    run.error = describeError(err, run.model);
    log(run, 'error', run.error);
  } finally {
    run.finishedAt = now();
    save();
  }
  return run;
}

/**
 * Creates a run and starts it in the background.
 * Returns the run record immediately plus a promise that resolves (never
 * rejects) with the finished run.
 */
export function startRun({ agentId, task, trigger = 'manual', parentRunId = null, depth = 1 }) {
  const agent = db.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error('Agent not found.');
  const run = {
    id: newId('run'), agentId, agentName: agent.name, model: modelFor(agent), task: String(task).trim(), status: 'running', trigger, parentRunId, depth,
    steps: [], output: '', error: null, sources: [],
    usage: { inputTokens: 0, outputTokens: 0, webSearches: 0, apiCalls: 0 },
    startedAt: now(), finishedAt: null,
  };
  db.runs.push(run);
  save();
  return { run, promise: execute(run, agent, depth) };
}
