// Agent HQ: one process serving the JSON API and the single-page frontend.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(here, '.env')); // optional; real env vars win
} catch {}

const { default: express } = await import('express');
const { db, save, flush, newId, now, DATA_DIR } = await import('./src/db.js');
const { startRun, isDemo, MODEL, MAX_STEPS } = await import('./src/runtime.js');
const { OPTIONAL_TOOLS, PRIORITIES, MODELS } = await import('./src/tools.js');
const { startScheduler, runNightShift, nightShiftRunning } = await import('./src/scheduler.js');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Unauthenticated liveness probe for hosting platforms; reveals nothing.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- Basic auth (only when APP_PASSWORD is set; any username is accepted) ----
const PASSWORD = process.env.APP_PASSWORD || '';
if (PASSWORD) {
  const expected = crypto.createHash('sha256').update(PASSWORD).digest();
  app.use((req, res, next) => {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && token) {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const given = crypto.createHash('sha256').update(decoded.slice(decoded.indexOf(':') + 1)).digest();
      if (crypto.timingSafeEqual(given, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Agent HQ", charset="UTF-8"').status(401).send('Authentication required.');
  });
}

app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));

// ---- helpers ----
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const find = (list, id, what) => list.find((x) => x.id === id) || fail(404, `${what} not found.`);
const COLORS = ['#f5b84a', '#5ec98b', '#4fb8d6', '#8f8cf2', '#e58fb1', '#f08a5d', '#c58af9', '#9aa7b8', '#e06c75'];

const lightRun = ({ steps, ...run }) => ({ ...run, stepCount: steps.length });

function isAncestor(candidateId, agentId) {
  // True if candidateId sits at or below agentId (so making it the manager would create a loop).
  for (let cur = candidateId, hops = 0; cur && hops < 1000; hops++) {
    if (cur === agentId) return true;
    cur = db.agents.find((a) => a.id === cur)?.reportsTo ?? null;
  }
  return false;
}

function applyAgentFields(agent, body) {
  if ('name' in body) agent.name = text(body.name, 80) || fail(400, 'An agent needs a name.');
  if ('title' in body) agent.title = text(body.title, 120);
  if ('mission' in body) agent.mission = text(body.mission, 4000);
  if ('rule' in body) agent.rule = text(body.rule, 1000);
  if ('nightTask' in body) agent.nightTask = text(body.nightTask, 4000);
  if ('color' in body && /^#[0-9a-f]{6}$/i.test(body.color)) agent.color = body.color;
  // Empty means "use the default model"; anything else must be in the catalogue.
  if ('model' in body) agent.model = !body.model ? '' : MODELS.some((m) => m.id === body.model) ? body.model : fail(400, 'Unknown model.');
  if ('companyId' in body) agent.companyId = body.companyId && db.companies.some((c) => c.id === body.companyId) ? body.companyId : null;
  // Only tools from the fixed registry can ever be enabled.
  if ('tools' in body) agent.tools = OPTIONAL_TOOLS.filter((t) => Array.isArray(body.tools) && body.tools.includes(t));
  if ('reportsTo' in body) {
    const managerId = body.reportsTo || null;
    if (managerId) {
      find(db.agents, managerId, 'Manager');
      if (isAncestor(managerId, agent.id)) fail(400, 'An agent cannot report to itself or to someone below it.');
    }
    agent.reportsTo = managerId;
  }
}

// ---- state ----
app.get('/api/state', (req, res) => {
  res.json({
    meta: {
      demo: isDemo(), model: MODEL, models: MODELS, maxSteps: MAX_STEPS, tools: OPTIONAL_TOOLS,
      serverTime: new Date().toString(), nightShiftRunning: nightShiftRunning(), authEnabled: Boolean(PASSWORD),
    },
    settings: db.settings,
    companies: db.companies,
    agents: db.agents,
    runs: db.runs.slice(-150).reverse().map(lightRun),
    approvals: [...db.approvals].reverse(),
    leads: [...db.leads].reverse(),
    notes: [...db.notes].reverse(),
  });
});

// ---- settings ----
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  if ('holdingName' in b) s.holdingName = text(b.holdingName, 120);
  if ('ownerContext' in b) s.ownerContext = text(b.ownerContext, 8000);
  if (b.nightShift) {
    if ('enabled' in b.nightShift) s.nightShift.enabled = Boolean(b.nightShift.enabled);
    if ('time' in b.nightShift) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.nightShift.time)) fail(400, 'Night shift time must be HH:MM (24-hour).');
      // Changing the time re-arms today's run.
      if (s.nightShift.time !== b.nightShift.time) s.nightShift.lastRunDate = null;
      s.nightShift.time = b.nightShift.time;
    }
  }
  save();
  res.json(s);
});

// ---- companies ----
app.get('/api/companies', (req, res) => res.json(db.companies));
app.post('/api/companies', (req, res) => {
  const company = { id: newId('co'), name: text(req.body?.name, 120) || fail(400, 'A company needs a name.'), description: text(req.body?.description, 2000) };
  db.companies.push(company);
  save();
  res.status(201).json(company);
});
app.put('/api/companies/:id', (req, res) => {
  const company = find(db.companies, req.params.id, 'Company');
  if ('name' in req.body) company.name = text(req.body.name, 120) || fail(400, 'A company needs a name.');
  if ('description' in req.body) company.description = text(req.body.description, 2000);
  save();
  res.json(company);
});
app.delete('/api/companies/:id', (req, res) => {
  find(db.companies, req.params.id, 'Company');
  db.companies = db.companies.filter((c) => c.id !== req.params.id);
  for (const a of db.agents) if (a.companyId === req.params.id) a.companyId = null;
  save();
  res.json({ ok: true });
});

// ---- agents ----
app.get('/api/agents', (req, res) => res.json(db.agents));
app.post('/api/agents', (req, res) => {
  const agent = {
    id: newId('agt'), name: '', title: '', model: '', companyId: null, reportsTo: null, mission: '', tools: [],
    rule: 'Never sends, publishes, books or spends without my yes.', nightTask: '', color: COLORS[db.agents.length % COLORS.length],
  };
  applyAgentFields(agent, { name: 'New agent', ...req.body });
  db.agents.push(agent);
  save();
  res.status(201).json(agent);
});
app.put('/api/agents/:id', (req, res) => {
  const agent = find(db.agents, req.params.id, 'Agent');
  const draft = { ...agent };
  applyAgentFields(draft, req.body || {}); // validate everything before changing anything
  Object.assign(agent, draft);
  save();
  res.json(agent);
});
app.delete('/api/agents/:id', (req, res) => {
  const agent = find(db.agents, req.params.id, 'Agent');
  // Reports move up one level to the deleted agent's own manager.
  for (const a of db.agents) if (a.reportsTo === agent.id) a.reportsTo = agent.reportsTo;
  db.agents = db.agents.filter((a) => a.id !== agent.id);
  save();
  res.json({ ok: true });
});
app.post('/api/agents/:id/run', (req, res) => {
  find(db.agents, req.params.id, 'Agent');
  const task = text(req.body?.task, 50000) || fail(400, 'Give the agent a task first.');
  const { run } = startRun({ agentId: req.params.id, task, trigger: 'manual' });
  res.status(202).json(lightRun(run));
});

// ---- runs ----
app.get('/api/runs', (req, res) => {
  let runs = db.runs;
  if (req.query.agentId) runs = runs.filter((r) => r.agentId === req.query.agentId);
  res.json(runs.slice(-150).reverse().map(lightRun));
});
app.get('/api/runs/:id', (req, res) => res.json(find(db.runs, req.params.id, 'Run')));

// ---- approvals: the only place an outward action is ever released, and only by the owner ----
app.get('/api/approvals', (req, res) => {
  const list = req.query.status ? db.approvals.filter((a) => a.status === req.query.status) : db.approvals;
  res.json([...list].reverse());
});
for (const [verb, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
  app.post(`/api/approvals/:id/${verb}`, (req, res) => {
    const approval = find(db.approvals, req.params.id, 'Approval');
    if (approval.status !== 'pending') fail(409, `This request was already ${approval.status}.`);
    approval.status = status;
    approval.decidedAt = now();
    save();
    res.json(approval);
  });
}
app.put('/api/approvals/:id', (req, res) => {
  const approval = find(db.approvals, req.params.id, 'Approval');
  if (approval.status !== 'pending') fail(409, 'Only pending requests can be edited.');
  if ('to' in req.body) approval.to = text(req.body.to, 500);
  if ('subject' in req.body) approval.subject = text(req.body.subject, 300);
  if ('body' in req.body) approval.body = text(req.body.body, 20000) || fail(400, 'The body cannot be empty.');
  save();
  res.json(approval);
});
app.delete('/api/approvals/:id', (req, res) => {
  find(db.approvals, req.params.id, 'Approval');
  db.approvals = db.approvals.filter((a) => a.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ---- leads ----
app.get('/api/leads', (req, res) => {
  const list = req.query.priority ? db.leads.filter((l) => l.priority === req.query.priority) : db.leads;
  res.json([...list].reverse());
});
app.put('/api/leads/:id', (req, res) => {
  const lead = find(db.leads, req.params.id, 'Lead');
  if ('priority' in req.body) lead.priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : fail(400, 'Priority must be P1, P2 or P3.');
  if ('notes' in req.body) lead.notes = text(req.body.notes, 2000);
  save();
  res.json(lead);
});
app.delete('/api/leads/:id', (req, res) => {
  find(db.leads, req.params.id, 'Lead');
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ---- notes (the brain) ----
app.get('/api/notes', (req, res) => res.json([...db.notes].reverse()));
app.post('/api/notes', (req, res) => {
  const note = {
    id: newId('note'), title: text(req.body?.title, 200) || fail(400, 'A note needs a title.'),
    content: text(req.body?.content, 20000) || fail(400, 'A note needs some content.'),
    authorId: null, authorName: 'Owner', runId: null, createdAt: now(),
  };
  db.notes.push(note);
  save();
  res.status(201).json(note);
});
app.delete('/api/notes/:id', (req, res) => {
  find(db.notes, req.params.id, 'Note');
  db.notes = db.notes.filter((n) => n.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ---- night shift ----
app.post('/api/night-shift/run', (req, res) => {
  const queued = runNightShift();
  if (queued === -1) fail(409, 'The night shift is already running.');
  if (queued === 0) fail(400, 'No agent has a night task yet. Add one on an agent\'s job card.');
  res.status(202).json({ queued });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'No such API route.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : err.message });
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
  console.log(`Agent HQ on http://localhost:${PORT}  |  ${isDemo() ? 'DEMO MODE (no ANTHROPIC_API_KEY)' : `model ${MODEL}`}  |  auth ${PASSWORD ? 'on' : 'off'}  |  data ${DATA_DIR}`);
  startScheduler();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
