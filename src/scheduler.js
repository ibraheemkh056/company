// Night shift: once a day at the configured server-local time (TZ env is
// respected by Node), run every agent that has a nightTask, one after another.
import { db, save } from './db.js';
import { startRun } from './runtime.js';

let running = false;
export const nightShiftRunning = () => running;

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Starts the night shift in the background. Returns how many agents were queued, or -1 if one is already running. */
export function runNightShift() {
  if (running) return -1;
  const queue = db.agents.filter((a) => (a.nightTask || '').trim()).map((a) => ({ id: a.id, task: a.nightTask.trim() }));
  if (!queue.length) return 0;
  running = true;
  (async () => {
    for (const { id, task } of queue) {
      if (!db.agents.some((a) => a.id === id)) continue; // deleted while the shift was running
      await startRun({ agentId: id, task, trigger: 'night' }).promise;
    }
  })()
    .catch((err) => console.error('[night shift]', err))
    .finally(() => {
      running = false;
    });
  return queue.length;
}

export function tick(date = new Date()) {
  const ns = db.settings.nightShift;
  if (!ns?.enabled || !/^\d{2}:\d{2}$/.test(ns.time || '')) return false;
  const today = localDate(date);
  if (ns.lastRunDate === today) return false;
  const [h, m] = ns.time.split(':').map(Number);
  const late = date.getHours() * 60 + date.getMinutes() - (h * 60 + m);
  // A 3-minute window tolerates a slow or skipped tick; lastRunDate stops repeats.
  if (late < 0 || late > 2) return false;
  if (runNightShift() === -1) return false;
  ns.lastRunDate = today;
  save();
  return true;
}

export function startScheduler() {
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
}
