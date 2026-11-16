# Agent HQ

A self-hosted org chart of AI agents that do your work. You define each agent's job; anything
that would leave the building (an email, a post, a booking, a spend) waits in an approvals inbox
for your yes.

One Node process serves the API and the page. Data is a single JSON file. No build step, no
native dependencies.

## Run it locally

Needs Node 20.12 or newer.

```bash
npm install
cp .env.example .env      # then add your ANTHROPIC_API_KEY
npm start                 # http://localhost:3000
```

### On a Mac: double-click the app

`Agent HQ.app` in this folder is a launcher. Double-click it and it starts the server in the
background and opens the page in your browser. The first launch installs dependencies (about a
minute) and offers to save your API key into `.env`. Double-click it again while it is running to
open the page or stop the server.

- It needs Node.js installed (the app tells you if it is missing).
- Keep the app inside this folder; drag it to the Dock for quick access rather than moving it.
- If you downloaded the project as a ZIP instead of using `git clone`, macOS will refuse to open
  it the first time. Open System Settings → Privacy & Security and click "Open Anyway", and move
  the whole project folder out of Downloads first.
- Its log is `data/agent-hq.log`.

With no API key the app starts in **demo mode**: everything works, but runs return a clearly
labelled placeholder and create no leads, notes or approvals.

`npm test` runs the test suite (tool loop, delegation, guard rails, night shift, HTTP routes)
against a scripted fake of the Anthropic client, so it needs no key and costs nothing.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Your Anthropic key. Empty means demo mode. |
| `MODEL` | `claude-opus-5-5` | Default model, used by any agent whose job card says "Default". |
| `EFFORT` | `medium` | `low` to `max`. How hard the model works per step; higher uses more tokens. Set it empty for older models that do not accept the setting. |
| `APP_PASSWORD` | none | If set, the page and API require HTTP basic auth with this password (any username). |
| `PORT` | `3000` | Port to listen on. |
| `TZ` | system | Time zone for the night shift, e.g. `Europe/London`. |
| `DATA_DIR` | `./data` | Folder holding `db.json`. Point it at a persistent disk in production. |
| `REFUSAL_FALLBACK` | on | Set `off` to disable the server-side refusal fallback (see below). |

## Deploying

Any host that runs a long-lived Node process with a **persistent disk** works (Render, Railway,
Fly.io, a VPS). Serverless and "scale to zero" hosts do not: the night-shift scheduler needs the
process to stay up, and the data file needs a real disk.

1. Create a web service from this repo with build command `npm install` and start command
   `npm start`.
2. Attach a persistent disk (1 GB is plenty) and set `DATA_DIR` to its mount path, for example
   `/var/data`. Without this, every deploy wipes your team, leads and approvals.
3. Set `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `TZ`, and optionally `MODEL`.
4. Run exactly **one instance**. The database is one file owned by one process.
5. Health check path: `/healthz` (the only route outside the password).

Always set `APP_PASSWORD` on a public host, and serve it over HTTPS (every host above does this
for you); basic auth over plain HTTP sends the password in the clear.

Back up by copying `db.json`. It is rewritten atomically (temp file, fsync, rename), so a copy
taken at any moment is a complete database.

## How it works

- **Team**: the org chart, built from each agent's "reports to". Tap an agent for its job card:
  edit it, give it a task, read its runs and step logs.
- **Approvals**: everything agents want sent. Approve, reject, or edit first. Approved emails get
  an "Open in mail app" link; approved posts get a copy button. Approving never sends anything.
- **Leads**: the CRM agents save into, filterable by priority.
- **Brain**: shared notes agents write and search. You can add notes too.
- **Activity**: every run, including delegated and night-shift runs.
- **Settings**: holding name, owner context (every agent reads it), companies, night shift.

### Models and cost

Each agent has a **Model** setting on its job card, so you pay for a strong model only where it
matters. The seed team is set up like this:

| Model | Agents |
|---|---|
| Fable 5.2 (most capable, priciest) | Chief, Research Analyst |
| Sonnet 5.5 | the three managers, Lead Finder, Trend Researcher, Planner |
| Haiku 5.5 (cheapest) | Outbound Writer, Inbound Responder, Post Writer, Inbox Triage |

"Default" on a job card means the `MODEL` env var. The seed models only apply to a fresh
`data/db.json`; an existing database keeps whatever each agent already has.

Every run shows the model it used, its token counts and an estimated token cost under its output.
The estimate uses list prices hard-coded in `src/tools.js` and leaves out web search fees, so
treat the Anthropic console as the real bill.

### The hard rule

It is enforced in code, in `src/tools.js`, not only in the prompt:

- The tool registry contains no tool that sends, publishes, books or spends. The only
  outward-facing tool is `request_approval`, which writes a row for you to decide on.
- An agent's tool list is filtered against that registry when saved, and a tool call for anything
  not offered to that agent is refused.
- `save_lead` is rejected unless its source URL is on a site that actually came back from a web
  search during that run. Agents cannot whitelist a URL by merely mentioning it.
- `delegate` only exists for agents with direct reports, only accepts those reports, and stops at
  three levels deep.

### Agent runtime

Each run builds a system prompt from the agent's job card, your owner context, its manager and
its reports, then loops on the Anthropic Messages API: call, execute tool calls, return results,
repeat until the model finishes. Capped at 12 steps. Every step is logged on the run, token usage
is recorded, and any failure marks the run failed with the error.

## Choices I made

- **Model**: the default is `claude-opus-5-5`; `MODEL` overrides it. Web search is capped at 5
  searches per run. Fable, Opus and Sonnet agents use tool version `web_search_20260209`; any
  other model (including Haiku) gets the basic `web_search_20250305`, which every model accepts.
- **Refusal fallback is on**: for the newest models, if a safety classifier declines a request,
  the API retries it on Anthropic's recommended fallback model (beta
  `server-side-fallback-2026-07-01`). The step log shows when this happens. `REFUSAL_FALLBACK=off`
  disables it.
- **Lead source check is by site, not exact page**, so a lead found on a company's contact page
  is accepted when the search returned its home page.
- **A Brain tab** was added so you can read and add to the shared memory.
- **Approvals can be edited** while pending.
- **Step cap**: a run that hits 12 steps finishes as "done" with what it has and a note saying it
  was cut short, rather than failing and losing the work.
- **Night shift** fires within a three-minute window of the set time, once per calendar day in
  the server's time zone. "Run night shift now" does not use up the scheduled run.
- **Restarts**: a run in progress when the server stops is marked failed on the next boot.
- **History**: the newest 400 runs are kept; the page shows the latest 150.
- **Seed data**: one placeholder company and a placeholder owner context. Fill both in under
  Settings first; agents do much better work once they know the business.
- **Basic auth** accepts any username with the right password.

## Files

```
server.js          Express app: routes, basic auth, static files
src/db.js          JSON store with atomic writes
src/seed.js        The starting team
src/tools.js       Every tool an agent can have, and the guard rails
src/runtime.js     System prompt, tool loop, demo mode
src/scheduler.js   Night shift
public/            The page (index.html, app.js, style.css)
test/app.test.js   Tests
```
