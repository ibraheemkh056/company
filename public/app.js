/* Agent HQ frontend. No framework, no build step.
   Rule for this file: every value that came from the server (and so possibly
   from an agent or the web) goes through esc() before it touches innerHTML. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const isEmail = (s) => /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(s || ''));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const setHTML = (el, html) => {
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
};

const TOOL_LABELS = {
  web_search: 'Web search', save_lead: 'Save leads (CRM)', list_leads: 'Read leads (CRM)',
  save_note: 'Write to brain', search_notes: 'Search brain', delegate: 'Delegate to reports',
};

let S = null; // last server state
const ui = { tab: 'team', leadFilter: '', sheet: null, expanded: new Set(), runCache: new Map() };
let pollTimer = null;

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 5000 : 2200);
}
const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, true);
  }
};

async function refresh() {
  clearTimeout(pollTimer);
  try {
    S = await api('GET', '/api/state');
    // Keep open run details fresh while they are still running.
    const stale = [...ui.expanded].filter((id) => {
      const light = S.runs.find((r) => r.id === id);
      const cached = ui.runCache.get(id);
      return !cached || cached.status === 'running' || (light && light.status !== cached.status);
    });
    await Promise.all(stale.map((id) => api('GET', `/api/runs/${id}`).then((r) => ui.runCache.set(id, r)).catch(() => ui.expanded.delete(id))));
    render();
  } catch (err) {
    toast(`Lost contact with the server: ${err.message}`, true);
  }
  const active = S && (S.runs.some((r) => r.status === 'running') || S.meta.nightShiftRunning);
  pollTimer = setTimeout(refresh, active ? 3000 : 20000);
}

// ---------- shared pieces ----------
const agentById = (id) => S.agents.find((a) => a.id === id);
const companyName = (id) => S.companies.find((c) => c.id === id)?.name || '';
const childrenOf = (id) => S.agents.filter((a) => a.reportsTo === id);
const modelLabel = (a) => S.meta.models.find((x) => x.id === (a.model || S.meta.model))?.label || a.model || S.meta.model;
const isRoot = (a) => !a.reportsTo || !agentById(a.reportsTo);

function agentStatus(agent) {
  const runs = S.runs.filter((r) => r.agentId === agent.id); // newest first
  if (runs.some((r) => r.status === 'running')) return ['running', 'Working now'];
  if (!runs.length) return ['idle', 'No runs yet'];
  return [runs[0].status, runs[0].status === 'done' ? 'Last run finished' : 'Last run failed'];
}

const avatar = (a) => `<span class="avatar" style="background:${esc(/^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#9aa7b8')}">${esc(initials(a.name))}</span>`;

function runDetail(run) {
  if (!run) return '<p class="muted">Loading…</p>';
  const secs = run.finishedAt ? Math.max(1, Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)) : null;
  const kids = S.runs.filter((r) => r.parentRunId === run.id).reverse();
  const u = run.usage || {};
  const m = S.meta.models.find((x) => x.id === run.model);
  const cost = m?.inPrice != null && u.apiCalls ? ((u.inputTokens || 0) * m.inPrice + (u.outputTokens || 0) * m.outPrice) / 1e6 : null;
  return `
    ${run.error ? `<p class="err"><b>Failed:</b> ${esc(run.error)}</p>` : ''}
    ${run.output ? `<pre class="prose">${esc(run.output)}</pre>` : run.status === 'running' ? '<p class="muted">Working…</p>' : ''}
    <p class="kv" style="margin-top:8px">
      ${run.demo ? '<b>Demo response</b> · ' : `${esc(m?.label || run.model || '')} · `}${esc(u.inputTokens || 0)} tokens in · ${esc(u.outputTokens || 0)} out · ${esc(u.apiCalls || 0)} API call(s)${u.webSearches ? ` · ${esc(u.webSearches)} web search(es)` : ''}${secs ? ` · ${esc(secs)}s` : ''}${cost != null ? ` · about $${esc(cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2))} in tokens${u.webSearches ? ', plus search fees' : ''}` : ''}
    </p>
    ${kids.length ? `<p class="kv">Delegated to: ${kids.map((k) => `<b>${esc(k.agentName)}</b> <span class="pill ${esc(k.status)}">${esc(k.status)}</span>`).join(' ')}</p>` : ''}
    ${(run.sources || []).length ? `<p class="kv">Sources: ${run.sources.filter((s) => safeUrl(s.url)).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a>`).join(' · ')}</p>` : ''}
    ${(run.steps || []).length ? `<h3>Step log</h3><ul class="steps">${run.steps.map((s) => `<li class="${esc(s.type)}"><span class="kind">${esc(s.type.replace('_', ' '))}</span>${esc(s.text)}</li>`).join('')}</ul>` : ''}`;
}

function runItem(run, showAgent) {
  const open = ui.expanded.has(run.id);
  return `<details class="run" data-run="${esc(run.id)}"${open ? ' open' : ''}>
    <summary>
      <span class="dot ${esc(run.status)}"></span>
      <span class="head">${showAgent ? `${esc(run.agentName)} ` : ''}<span class="pill ${esc(run.status)}">${esc(run.status)}</span><span class="tag">${esc(run.trigger)}</span></span>
      <span class="when">${esc(when(run.startedAt))}</span>
      <span class="task">${esc(run.task)}</span>
    </summary>
    <div class="run-body">${open ? runDetail(ui.runCache.get(run.id)) : ''}</div>
  </details>`;
}

// ---------- tabs ----------
function treeNode(agent, seen) {
  if (seen.has(agent.id)) return '';
  seen.add(agent.id);
  const [status, label] = agentStatus(agent);
  const kids = childrenOf(agent.id);
  const co = companyName(agent.companyId);
  return `<li>
    <button class="agent" data-action="open-agent" data-id="${esc(agent.id)}">
      <span class="dot ${esc(status)}" title="${esc(label)}"></span>
      ${avatar(agent)}
      <span class="meta">
        <span class="name">${esc(agent.name)}</span>
        <span class="title">${esc(agent.title)}</span>
        ${co ? `<span class="tag">${esc(co)}</span>` : ''}
        <span class="tag model">${esc(modelLabel(agent))}</span>
      </span>
    </button>
    ${kids.length ? `<ul>${kids.map((k) => treeNode(k, seen)).join('')}</ul>` : ''}
  </li>`;
}

function renderTeam() {
  const seen = new Set();
  const roots = S.agents.filter(isRoot);
  const nightCount = S.agents.filter((a) => (a.nightTask || '').trim()).length;
  return `
    <div class="bar">
      <p class="muted grow">${esc(S.agents.length)} agents. Tap one to open its job card.</p>
      <button class="btn" data-action="night-now" ${S.meta.nightShiftRunning ? 'disabled' : ''}>${S.meta.nightShiftRunning ? 'Night shift running…' : `Run night shift now (${esc(nightCount)})`}</button>
      <button class="btn primary" data-action="add-agent">Add agent</button>
    </div>
    ${roots.length ? `<div class="chart-scroll"><div class="tree"><ul>${roots.map((r) => treeNode(r, seen)).join('')}</ul></div></div>` : '<div class="empty">No agents yet. Add your first one.</div>'}`;
}

function approvalCard(a) {
  const pending = a.status === 'pending';
  const mailto = a.type === 'email' && isEmail(a.to) ? `mailto:${a.to}?subject=${encodeURIComponent(a.subject || '')}&body=${encodeURIComponent(a.body)}` : '';
  return `<div class="card">
    <div class="card-head">
      <span class="pill ${esc(a.status)}">${esc(a.status)}</span><span class="tag">${esc(a.type)}</span>
      <span class="who">${esc(a.title)}</span>
      <span class="when">${esc(a.agentName)} · ${esc(when(a.createdAt))}</span>
    </div>
    ${a.to ? `<p class="kv">To: <b>${esc(a.to)}</b></p>` : ''}
    ${a.subject ? `<p class="kv">Subject: <b>${esc(a.subject)}</b></p>` : ''}
    <pre class="prose">${esc(a.body)}</pre>
    <div class="actions">
      ${pending ? `
        <button class="btn ok" data-action="approve" data-id="${esc(a.id)}">Approve</button>
        <button class="btn danger" data-action="reject" data-id="${esc(a.id)}">Reject</button>
        <button class="btn" data-action="edit-approval" data-id="${esc(a.id)}">Edit</button>` : ''}
      ${a.status === 'approved' ? `
        ${mailto ? `<a class="btn primary" href="${esc(mailto)}">Open in mail app</a>` : ''}
        ${a.type === 'email' && !mailto ? '<span class="muted">No valid recipient address, so copy the text instead.</span>' : ''}
        <button class="btn${mailto ? '' : ' primary'}" data-action="copy" data-id="${esc(a.id)}">${a.type === 'post' ? 'Copy post' : 'Copy text'}</button>` : ''}
      ${!pending ? `<button class="btn danger small" data-action="delete-approval" data-id="${esc(a.id)}">Remove</button>` : ''}
    </div>
  </div>`;
}

function renderApprovals() {
  const pending = S.approvals.filter((a) => a.status === 'pending');
  const decided = S.approvals.filter((a) => a.status !== 'pending');
  return `
    <p class="muted" style="margin-bottom:12px">Agents cannot send, publish, book or spend. Whatever they want to go out waits here for your yes. Approving releases the text to you: emails get a mail link, posts a copy button.</p>
    <h3 style="margin-top:0">Waiting for you (${esc(pending.length)})</h3>
    ${pending.length ? pending.map(approvalCard).join('') : '<div class="empty">Nothing is waiting for approval.</div>'}
    ${decided.length ? `<h3>Decided</h3>${decided.map(approvalCard).join('')}` : ''}`;
}

function renderLeads() {
  const rows = S.leads.filter((l) => !ui.leadFilter || l.priority === ui.leadFilter);
  const link = (url, label) => (safeUrl(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(url ? label : ''));
  return `
    <div class="bar">
      <div class="seg" role="group" aria-label="Filter by priority">
        ${['', 'P1', 'P2', 'P3'].map((p) => `<button data-action="lead-filter" data-id="${p}" class="${ui.leadFilter === p ? 'active' : ''}">${p || 'All'}</button>`).join('')}
      </div>
      <p class="muted grow">${esc(rows.length)} of ${esc(S.leads.length)} lead(s)</p>
    </div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Priority</th><th>Company</th><th>Contact</th><th>Email</th><th>Source</th><th>Notes</th><th>Found by</th><th></th></tr></thead>
      <tbody>${rows.map((l) => `<tr>
        <td><span class="pill ${esc(l.priority)}">${esc(l.priority)}</span></td>
        <td><b>${esc(l.company)}</b>${l.website ? `<br>${link(/^https?:/i.test(l.website) ? l.website : `https://${l.website}`, 'website')}` : ''}</td>
        <td>${esc(l.contactName)}${l.role ? `<br><span class="muted">${esc(l.role)}</span>` : ''}</td>
        <td>${isEmail(l.email) ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : esc(l.email)}</td>
        <td>${link(l.sourceUrl, 'source')}</td>
        <td class="notes">${esc(l.notes)}</td>
        <td>${esc(l.foundByName)}<br><span class="muted">${esc(when(l.createdAt))}</span></td>
        <td><button class="btn danger small" data-action="delete-lead" data-id="${esc(l.id)}" aria-label="Delete lead">Delete</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">${S.leads.length ? 'No leads with this priority.' : 'No leads yet. Ask the Lead Finder to find some.'}</div>`}`;
}

function renderBrainList() {
  return S.notes.length
    ? S.notes.map((n) => `<div class="card">
        <div class="card-head"><span class="who">${esc(n.title)}</span><span class="when">${esc(n.authorName)} · ${esc(when(n.createdAt))}</span></div>
        <pre class="prose">${esc(n.content)}</pre>
        <div class="actions"><button class="btn danger small" data-action="delete-note" data-id="${esc(n.id)}">Delete</button></div>
      </div>`).join('')
    : '<div class="empty">The brain is empty. Agents with "Write to brain" save research and plans here, and every agent with "Search brain" can read them.</div>';
}

function renderActivity() {
  return S.runs.length ? S.runs.map((r) => runItem(r, true)).join('') : '<div class="empty">No runs yet. Open an agent and give it a task.</div>';
}

function renderSettings() {
  const s = S.settings;
  return `
    <div class="card">
      <h2>Holding</h2>
      <label for="set-holding">Holding name</label>
      <input type="text" id="set-holding" value="${esc(s.holdingName)}">
      <label for="set-context">Owner context (every agent reads this)</label>
      <textarea id="set-context" rows="7">${esc(s.ownerContext)}</textarea>
      <h3>Night shift</h3>
      <p class="muted">Once a day at this time, every agent with a night task runs it, one after another.</p>
      <div class="row">
        <label class="check" style="margin-top:12px"><input type="checkbox" id="set-night-on" ${s.nightShift.enabled ? 'checked' : ''}> Night shift enabled</label>
        <div><label for="set-night-time">Start time (server clock)</label><input type="time" id="set-night-time" value="${esc(s.nightShift.time)}"></div>
      </div>
      <p class="muted" style="margin-top:8px">Server time now: ${esc(S.meta.serverTime)}${s.nightShift.lastRunDate ? ` · last scheduled run ${esc(s.nightShift.lastRunDate)}` : ''}</p>
      <div class="actions">
        <button class="btn primary" data-action="save-settings">Save settings</button>
        <button class="btn" data-action="night-now">Run night shift now</button>
      </div>
    </div>
    <div class="card">
      <h2>Companies</h2>
      ${S.companies.map((c) => `<div data-company="${esc(c.id)}" style="border-top:1px solid var(--line);margin-top:12px">
        <label>Name</label><input type="text" class="co-name" value="${esc(c.name)}">
        <label>Description</label><textarea class="co-desc" rows="2">${esc(c.description)}</textarea>
        <div class="actions">
          <button class="btn small" data-action="save-company" data-id="${esc(c.id)}">Save</button>
          <button class="btn danger small" data-action="delete-company" data-id="${esc(c.id)}">Delete</button>
        </div>
      </div>`).join('')}
      <div class="actions"><button class="btn" data-action="add-company">Add company</button></div>
    </div>
    <div class="card">
      <h2>System</h2>
      <p class="kv" style="margin-top:6px">Mode: <b>${S.meta.demo ? 'Demo (no API key)' : 'Live'}</b> · Default model: <b>${esc(S.meta.model)}</b> (each agent can override it on its job card) · Step cap: <b>${esc(S.meta.maxSteps)}</b> · Password protection: <b>${S.meta.authEnabled ? 'on' : 'off'}</b></p>
    </div>`;
}

// ---------- job card ----------
function descendants(id, acc = new Set()) {
  for (const c of childrenOf(id)) if (!acc.has(c.id)) descendants(c.id, acc.add(c.id));
  return acc;
}

function agentSheet(a) {
  const blocked = descendants(a.id).add(a.id);
  return `
    <div class="sheet-head">
      ${avatar(a)}
      <div class="grow"><h2 id="sheet-title">${esc(a.name)}</h2><p class="muted">${esc(a.title)}</p></div>
      <button class="close" data-action="close-sheet" aria-label="Close">×</button>
    </div>

    <div class="taskbox">
      <label for="task-input">Give a task</label>
      <textarea id="task-input" rows="4" placeholder="What should ${esc(a.name)} do? Paste any emails or messages it needs."></textarea>
      <div class="actions"><button class="btn primary" data-action="run-agent" data-id="${esc(a.id)}">Run</button></div>
    </div>

    <h3>Recent runs</h3>
    <div id="sheet-runs"></div>

    <h3>Job card</h3>
    <div class="row">
      <div><label for="f-name">Name</label><input type="text" id="f-name" value="${esc(a.name)}"></div>
      <div><label for="f-title">Title</label><input type="text" id="f-title" value="${esc(a.title)}"></div>
    </div>
    <div class="row">
      <div><label for="f-company">Company</label><select id="f-company">
        <option value="">No company</option>
        ${S.companies.map((c) => `<option value="${esc(c.id)}"${c.id === a.companyId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></div>
      <div><label for="f-manager">Reports to</label><select id="f-manager">
        <option value="">Nobody (top of the chart)</option>
        ${S.agents.filter((x) => !blocked.has(x.id)).map((x) => `<option value="${esc(x.id)}"${x.id === a.reportsTo ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></div>
    </div>
    <label for="f-model">Model</label>
    <select id="f-model">
      <option value="">Default (${esc(S.meta.models.find((x) => x.id === S.meta.model)?.label || S.meta.model)})</option>
      ${S.meta.models.map((x) => `<option value="${esc(x.id)}"${x.id === a.model ? ' selected' : ''}>${esc(x.label)}${x.hint ? ` (${esc(x.hint)})` : ''}</option>`).join('')}
    </select>
    <label for="f-mission">Mission</label>
    <textarea id="f-mission" rows="5">${esc(a.mission)}</textarea>
    <label>Tools</label>
    <div class="checks">
      ${S.meta.tools.map((t) => `<label class="check"><input type="checkbox" class="f-tool" value="${esc(t)}"${(a.tools || []).includes(t) ? ' checked' : ''}> ${esc(TOOL_LABELS[t] || t)}</label>`).join('')}
      <label class="check locked"><input type="checkbox" checked disabled> Request approval (always on)</label>
    </div>
    <label for="f-rule">Rule</label>
    <textarea id="f-rule" rows="2">${esc(a.rule)}</textarea>
    <label for="f-night">Night task (optional, runs on the night shift)</label>
    <textarea id="f-night" rows="2" placeholder="Leave empty for no night task.">${esc(a.nightTask)}</textarea>
    <div class="actions">
      <button class="btn primary" data-action="save-agent" data-id="${esc(a.id)}">Save job card</button>
      <button class="btn danger" data-action="delete-agent" data-id="${esc(a.id)}">Delete agent</button>
    </div>`;
}

function approvalSheet(a) {
  return `
    <div class="sheet-head">
      <div class="grow"><h2 id="sheet-title">Edit before approving</h2><p class="muted">${esc(a.title)}</p></div>
      <button class="close" data-action="close-sheet" aria-label="Close">×</button>
    </div>
    <label for="a-to">To</label><input type="text" id="a-to" value="${esc(a.to)}">
    <label for="a-subject">Subject</label><input type="text" id="a-subject" value="${esc(a.subject)}">
    <label for="a-body">Body</label><textarea id="a-body" rows="14">${esc(a.body)}</textarea>
    <div class="actions"><button class="btn primary" data-action="save-approval" data-id="${esc(a.id)}">Save changes</button></div>`;
}

function openSheet(kind, id) {
  ui.sheet = { kind, id };
  const item = kind === 'agent' ? agentById(id) : S.approvals.find((a) => a.id === id);
  if (!item) return closeSheet();
  const sheet = $('#sheet');
  sheet.__html = null;
  sheet.innerHTML = kind === 'agent' ? agentSheet(item) : approvalSheet(item);
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  renderSheetRuns();
}
function closeSheet() {
  ui.sheet = null;
  $('#modal').hidden = true;
  document.body.style.overflow = '';
}
function renderSheetRuns() {
  const box = $('#sheet-runs');
  if (!box || ui.sheet?.kind !== 'agent') return;
  const runs = S.runs.filter((r) => r.agentId === ui.sheet.id).slice(0, 10);
  setHTML(box, runs.length ? runs.map((r) => runItem(r, false)).join('') : '<p class="muted">No runs yet.</p>');
}

// ---------- render ----------
const RENDERERS = { team: renderTeam, approvals: renderApprovals, leads: renderLeads, activity: renderActivity };

function render(force = false) {
  $('#holding').textContent = S.settings.holdingName || '';
  $('#demo-banner').hidden = !S.meta.demo;
  const running = S.runs.filter((r) => r.status === 'running').length;
  $('#live').hidden = !running;
  $('#live-text').textContent = `${running} running`;
  const pending = S.approvals.filter((a) => a.status === 'pending').length;
  $('#badge').hidden = !pending;
  $('#badge').textContent = pending;
  document.title = pending ? `(${pending}) Agent HQ` : 'Agent HQ';

  for (const btn of document.querySelectorAll('#tabs button')) btn.classList.toggle('active', btn.dataset.tab === ui.tab);
  for (const sec of document.querySelectorAll('main > section')) sec.hidden = sec.id !== `tab-${ui.tab}`;
  const el = $(`#tab-${ui.tab}`);

  if (ui.tab === 'settings') {
    // Rendered only on entry or after a save, so polling never wipes what you are typing.
    if (force || !el.dataset.ready) {
      el.innerHTML = renderSettings();
      el.dataset.ready = '1';
    }
  } else if (ui.tab === 'brain') {
    if (!el.dataset.ready) {
      el.innerHTML = `
        <details class="run" style="margin-bottom:14px"><summary><span></span><span class="head">Add a note yourself</span><span></span></summary>
          <div class="run-body">
            <label for="n-title">Title</label><input type="text" id="n-title">
            <label for="n-content">Content</label><textarea id="n-content" rows="5"></textarea>
            <div class="actions"><button class="btn primary" data-action="add-note">Save note</button></div>
          </div></details>
        <div id="brain-list"></div>`;
      el.dataset.ready = '1';
    }
    setHTML($('#brain-list'), renderBrainList());
  } else {
    setHTML(el, RENDERERS[ui.tab]());
  }
  renderSheetRuns();
}

function switchTab(tab) {
  ui.tab = tab;
  if (tab === 'settings') delete $('#tab-settings').dataset.ready;
  render();
  window.scrollTo(0, 0);
}

// ---------- actions ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

const ACTIONS = {
  'open-agent': (id) => openSheet('agent', id),
  'close-sheet': () => closeSheet(),
  'lead-filter': (id) => {
    ui.leadFilter = id;
    render();
  },
  async 'add-agent'() {
    const agent = await api('POST', '/api/agents', { name: 'New agent', title: 'Describe the role', reportsTo: S.agents.find(isRoot)?.id || null, companyId: S.companies[0]?.id || null });
    await refresh();
    openSheet('agent', agent.id);
    $('#f-name')?.scrollIntoView({ block: 'center' });
    $('#f-name')?.select();
  },
  async 'save-agent'(id) {
    await api('PUT', `/api/agents/${id}`, {
      name: $('#f-name').value, title: $('#f-title').value, companyId: $('#f-company').value || null,
      reportsTo: $('#f-manager').value || null, model: $('#f-model').value, mission: $('#f-mission').value, rule: $('#f-rule').value, nightTask: $('#f-night').value,
      tools: [...document.querySelectorAll('.f-tool:checked')].map((c) => c.value),
    });
    await refresh();
    closeSheet();
    toast('Job card saved');
  },
  async 'delete-agent'(id) {
    const a = agentById(id);
    const kids = childrenOf(id).length;
    if (!confirm(`Delete ${a.name}?${kids ? ` Its ${kids} report(s) will move up one level.` : ''} Past runs stay in Activity.`)) return;
    await api('DELETE', `/api/agents/${id}`);
    closeSheet();
    await refresh();
    toast('Agent deleted');
  },
  async 'run-agent'(id) {
    const input = $('#task-input');
    if (!input.value.trim()) return toast('Type a task first.', true);
    const run = await api('POST', `/api/agents/${id}/run`, { task: input.value });
    input.value = '';
    ui.expanded.add(run.id);
    await refresh();
  },
  async 'night-now'() {
    const { queued } = await api('POST', '/api/night-shift/run');
    toast(`Night shift started for ${queued} agent(s)`);
    await refresh();
  },
  async approve(id) {
    await api('POST', `/api/approvals/${id}/approve`);
    await refresh();
    toast('Approved. Nothing was sent: use the button to send or copy it yourself.');
  },
  async reject(id) {
    await api('POST', `/api/approvals/${id}/reject`);
    await refresh();
  },
  'edit-approval': (id) => openSheet('approval', id),
  async 'save-approval'(id) {
    await api('PUT', `/api/approvals/${id}`, { to: $('#a-to').value, subject: $('#a-subject').value, body: $('#a-body').value });
    closeSheet();
    await refresh();
    toast('Saved');
  },
  async 'delete-approval'(id) {
    await api('DELETE', `/api/approvals/${id}`);
    await refresh();
  },
  copy(id) {
    const a = S.approvals.find((x) => x.id === id);
    if (a) return copyText(a.type === 'email' && a.subject ? `Subject: ${a.subject}\n\n${a.body}` : a.body);
  },
  async 'delete-lead'(id) {
    if (!confirm('Delete this lead?')) return;
    await api('DELETE', `/api/leads/${id}`);
    await refresh();
  },
  async 'add-note'() {
    await api('POST', '/api/notes', { title: $('#n-title').value, content: $('#n-content').value });
    $('#n-title').value = $('#n-content').value = '';
    await refresh();
    toast('Note saved');
  },
  async 'delete-note'(id) {
    if (!confirm('Delete this note from the brain?')) return;
    await api('DELETE', `/api/notes/${id}`);
    await refresh();
  },
  async 'save-settings'() {
    await api('PUT', '/api/settings', {
      holdingName: $('#set-holding').value, ownerContext: $('#set-context').value,
      nightShift: { enabled: $('#set-night-on').checked, time: $('#set-night-time').value },
    });
    await refresh();
    render(true);
    toast('Settings saved');
  },
  async 'add-company'() {
    await api('POST', '/api/companies', { name: 'New company', description: '' });
    await refresh();
    render(true);
  },
  async 'save-company'(id) {
    const box = $(`[data-company="${CSS.escape(id)}"]`);
    await api('PUT', `/api/companies/${id}`, { name: $('.co-name', box).value, description: $('.co-desc', box).value });
    await refresh();
    render(true);
    toast('Company saved');
  },
  async 'delete-company'(id) {
    if (!confirm('Delete this company? Its agents stay, without a company tag.')) return;
    await api('DELETE', `/api/companies/${id}`);
    await refresh();
    render(true);
  },
};

document.addEventListener('click', guard(async (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) return switchTab(tab.dataset.tab);
  if (e.target.id === 'modal') return closeSheet();
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const action = ACTIONS[btn.dataset.action];
  if (!action) return;
  btn.disabled = true;
  try {
    await action(btn.dataset.id);
  } finally {
    btn.disabled = false;
  }
}));

// <details> toggle events do not bubble, so listen in the capture phase.
document.addEventListener('toggle', guard(async (e) => {
  const el = e.target;
  const id = el.dataset?.run;
  if (!id) return;
  if (!el.open) return void ui.expanded.delete(id);
  if (ui.expanded.has(id) && ui.runCache.has(id)) return;
  ui.expanded.add(id);
  const body = $('.run-body', el);
  body.innerHTML = runDetail(null);
  ui.runCache.set(id, await api('GET', `/api/runs/${id}`));
  render();
}), true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.sheet) closeSheet();
});

refresh();
