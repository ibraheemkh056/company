// Every capability an agent can have is defined in this file.
//
// HARD RULE: there is deliberately no tool here that sends email, publishes,
// books or spends. The only outward-facing tool is request_approval, which
// writes a row to the approvals inbox for the owner to approve or reject.
// Unknown tool names are refused, so an agent cannot gain a capability by
// asking for one that is not in this registry.
import { db, save, newId, now } from './db.js';

export const DEFAULT_MODEL = process.env.MODEL || 'claude-opus-5-5';
// Models the owner can pick per agent. Prices are USD per million tokens and
// only feed the cost estimate shown in the UI.
export const MODELS = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2', hint: 'most capable, priciest', inPrice: 8, outPrice: 40 },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'strong all-rounder', inPrice: 4, outPrice: 20 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'fast, half the price of Opus', inPrice: 2, outPrice: 10 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'cheapest, for simple drafting', inPrice: 0.1, outPrice: 0.5 },
];
if (!MODELS.some((m) => m.id === DEFAULT_MODEL)) MODELS.push({ id: DEFAULT_MODEL, label: DEFAULT_MODEL, hint: 'from MODEL env' });
export const modelFor = (agent) => (MODELS.some((m) => m.id === agent.model) ? agent.model : DEFAULT_MODEL);

// The newer search tool (with dynamic filtering) is documented for Fable, Opus
// and Sonnet; every other model gets the basic version, which all models accept.
export const webSearchTypeFor = (model) => (/^claude-(fable|mythos|opus|sonnet)-/.test(model) ? 'web_search_20260209' : 'web_search_20250305');
export const WEB_SEARCH_MAX_USES = 5;

// Tools the owner can switch on per agent. request_approval is always on.
export const OPTIONAL_TOOLS = ['web_search', 'save_lead', 'list_leads', 'save_note', 'search_notes', 'delegate'];
export const APPROVAL_TYPES = ['email', 'post', 'calendar', 'other'];
export const PRIORITIES = ['P1', 'P2', 'P3'];

const DEFS = {
  save_lead: {
    name: 'save_lead',
    description:
      'Save one lead to the CRM. Only for real organisations or people you found through web_search in this run: source_url must be a page from your search results, and the save is rejected otherwise. Leave email empty if you did not see one on a page; never guess an address.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Organisation name.' },
        contact_name: { type: 'string', description: 'Person to contact, if found.' },
        role: { type: 'string', description: 'Their job title, if found.' },
        email: { type: 'string', description: 'Only an address you actually saw on a page.' },
        website: { type: 'string', description: 'Company website URL.' },
        source_url: { type: 'string', description: 'The search-result page where you found this lead.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'P1 strong fit and reachable now, P2 good fit, P3 worth watching.' },
        notes: { type: 'string', description: 'Why this is a fit and any useful context for outreach.' },
      },
      required: ['company', 'source_url', 'priority'],
    },
  },
  list_leads: {
    name: 'list_leads',
    description: 'List leads already in the CRM, newest first. Use before saving to avoid duplicates, or to pick leads to write to.',
    input_schema: {
      type: 'object',
      properties: {
        priority: { type: 'string', enum: PRIORITIES, description: 'Only leads with this priority.' },
        query: { type: 'string', description: 'Only leads whose company, contact or notes contain this text.' },
      },
    },
  },
  save_note: {
    name: 'save_note',
    description: 'Save a note to the brain, the memory shared by every agent and the owner. Use it for research findings, plans and anything a colleague will need later. Include source links in the content.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, specific title; include the date for time-sensitive findings.' },
        content: { type: 'string', description: 'The note itself.' },
      },
      required: ['title', 'content'],
    },
  },
  search_notes: {
    name: 'search_notes',
    description: 'Search the brain for notes saved by any agent. Returns the best matches in full. Call with an empty query to see the most recent notes.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to look for in note titles and content.' } },
    },
  },
  delegate: {
    name: 'delegate',
    description:
      'Hand a task to one of your direct reports and wait for their final answer. The report starts with no knowledge of your conversation, so the task must stand on its own: include the goal, any text the owner pasted that they need, and what you want back.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The id of one of your direct reports.' },
        task: { type: 'string', description: 'A complete, self-contained brief.' },
      },
      required: ['agent_id', 'task'],
    },
  },
  request_approval: {
    name: 'request_approval',
    description:
      'File something outward-facing for the owner to approve or reject. This is the only way an email, post, calendar booking or any spend can happen: nothing is sent by filing it. Write the body exactly as it should go out, with no placeholders.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: APPROVAL_TYPES },
        title: { type: 'string', description: 'One line telling the owner what this is, e.g. "LinkedIn post: spring launch".' },
        to: { type: 'string', description: 'Recipient email address (emails), platform (posts) or attendees (calendar).' },
        subject: { type: 'string', description: 'Email subject or event name.' },
        body: { type: 'string', description: 'The full text, ready to go out as written.' },
      },
      required: ['type', 'title', 'body'],
    },
  },
};

export const directReports = (agentId) => db.agents.filter((a) => a.reportsTo === agentId);

/** The exact tool list sent to the API for this agent at this depth. */
export function toolsFor(agent, depth, maxDepth, model = modelFor(agent)) {
  const enabled = new Set(agent.tools || []);
  const tools = [];
  if (enabled.has('web_search')) tools.push({ type: webSearchTypeFor(model), name: 'web_search', max_uses: WEB_SEARCH_MAX_USES });
  for (const name of ['save_lead', 'list_leads', 'save_note', 'search_notes']) if (enabled.has(name)) tools.push(DEFS[name]);
  if (enabled.has('delegate') && depth < maxDepth && directReports(agent.id).length) tools.push(DEFS.delegate);
  tools.push(DEFS.request_approval);
  return tools;
}

const str = (v, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
export const hostOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};
const leadLine = (l) =>
  `- ${l.company} [${l.priority}]${l.contactName ? ` | ${l.contactName}${l.role ? `, ${l.role}` : ''}` : ''}${l.email ? ` | ${l.email}` : ' | no email'}${l.website ? ` | ${l.website}` : ''}${l.notes ? ` | ${l.notes}` : ''} (id ${l.id})`;

const HANDLERS = {
  save_lead(input, ctx) {
    const company = str(input.company, 200);
    const sourceUrl = str(input.source_url, 1000);
    const email = str(input.email, 200);
    need(company, 'company is required.');
    need(PRIORITIES.includes(input.priority), 'priority must be P1, P2 or P3.');
    const host = hostOf(sourceUrl);
    need(host, 'source_url must be a full http(s) URL.');
    // Enforced in code: the source has to be a site that actually came back
    // from a web search during this run, so leads cannot be invented.
    need(
      ctx.seenHosts.has(host),
      ctx.seenHosts.size
        ? `Not saved: ${host} did not appear in your web search results in this run. Use the URL of the page where you found this lead.`
        : 'Not saved: a lead needs a source URL from a web search made in this run, and no search results have come back yet.',
    );
    need(!email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'email is not a valid address; leave it empty if you did not find one.');
    const dup = db.leads.find((l) => l.company.toLowerCase() === company.toLowerCase() && (l.email || '').toLowerCase() === email.toLowerCase());
    if (dup) return `Already in the CRM as ${dup.id}; not saved again.`;
    const lead = {
      id: newId('lead'), company, contactName: str(input.contact_name, 200), role: str(input.role, 200), email,
      website: str(input.website, 500), sourceUrl, priority: input.priority, notes: str(input.notes, 2000),
      foundBy: ctx.agent.id, foundByName: ctx.agent.name, runId: ctx.run.id, createdAt: now(),
    };
    db.leads.push(lead);
    save();
    return `Saved lead ${lead.id}: ${company} (${lead.priority}).`;
  },

  list_leads(input) {
    const q = str(input.query, 200).toLowerCase();
    const rows = db.leads
      .filter((l) => !input.priority || l.priority === input.priority)
      .filter((l) => !q || `${l.company} ${l.contactName} ${l.role} ${l.notes}`.toLowerCase().includes(q))
      .slice(-50)
      .reverse();
    return rows.length ? `${rows.length} lead(s):\n${rows.map(leadLine).join('\n')}` : 'No matching leads in the CRM.';
  },

  save_note(input, ctx) {
    const title = str(input.title, 200);
    const content = str(input.content, 20000);
    need(title && content, 'title and content are both required.');
    const note = { id: newId('note'), title, content, authorId: ctx.agent.id, authorName: ctx.agent.name, runId: ctx.run.id, createdAt: now() };
    db.notes.push(note);
    save();
    return `Saved note ${note.id}: "${title}".`;
  },

  search_notes(input) {
    const words = str(input.query, 200).toLowerCase().split(/\s+/).filter(Boolean);
    const scored = db.notes
      .map((n) => {
        const title = n.title.toLowerCase();
        const body = n.content.toLowerCase();
        const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0), 0);
        return { n, score };
      })
      .filter((x) => !words.length || x.score > 0)
      .sort((a, b) => b.score - a.score || b.n.createdAt.localeCompare(a.n.createdAt))
      .slice(0, 5);
    if (!scored.length) return 'No matching notes in the brain.';
    return scored.map(({ n }) => `## ${n.title}\n(by ${n.authorName}, ${n.createdAt.slice(0, 10)})\n${n.content.slice(0, 3000)}`).join('\n\n');
  },

  async delegate(input, ctx) {
    const report = directReports(ctx.agent.id).find((a) => a.id === input.agent_id);
    need(report, `You can only delegate to your direct reports: ${directReports(ctx.agent.id).map((a) => a.id).join(', ') || 'none'}.`);
    const task = str(input.task, 20000);
    need(task, 'task is required.');
    const child = await ctx.delegate(report.id, task);
    if (child.status !== 'done') throw new Error(`${report.name} failed: ${child.error || 'unknown error'}`);
    return `${report.name} finished (run ${child.id}).\n\n${child.output || '(no output)'}`;
  },

  request_approval(input, ctx) {
    need(APPROVAL_TYPES.includes(input.type), `type must be one of: ${APPROVAL_TYPES.join(', ')}.`);
    const title = str(input.title, 200);
    const body = str(input.body, 20000);
    need(title && body, 'title and body are both required.');
    const approval = {
      id: newId('apr'), agentId: ctx.agent.id, agentName: ctx.agent.name, runId: ctx.run.id, type: input.type, title,
      to: str(input.to, 500), subject: str(input.subject, 300), body, status: 'pending', createdAt: now(), decidedAt: null,
    };
    db.approvals.push(approval);
    save();
    return `Filed approval request ${approval.id}. Nothing has been sent; the owner will approve or reject it.`;
  },
};

/** Runs one client tool. Only tools that were offered to this agent can run. */
export async function runTool(name, input, ctx) {
  if (!ctx.allowed.has(name) || !HANDLERS[name]) throw new Error(`Tool "${name}" is not available to you.`);
  return HANDLERS[name](input && typeof input === 'object' ? input : {}, ctx);
}
