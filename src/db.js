// Single-file JSON store. Everything lives in memory; every change is written
// to data/db.json atomically (temp file + fsync + rename) so a crash mid-write
// can never leave a half-written database behind.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedData } from './seed.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_RUNS = 400;

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const now = () => new Date().toISOString();

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return seedData();
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const seed = seedData();
    // Fill in any top-level collection a hand-edited or older file is missing.
    for (const key of Object.keys(seed)) if (data[key] == null) data[key] = key === 'settings' ? seed.settings : [];
    data.settings.nightShift = { ...seed.settings.nightShift, ...data.settings.nightShift };
    return data;
  } catch (err) {
    const backup = path.join(DATA_DIR, `db.corrupt-${Date.now()}.json`);
    fs.renameSync(DB_FILE, backup);
    console.error(`[db] data/db.json was unreadable (${err.message}). Kept it as ${backup} and started from the seed team.`);
    return seedData();
  }
}

export const db = load();

let pending = false;
export function flush() {
  pending = false;
  if (db.runs.length > MAX_RUNS) db.runs.splice(0, db.runs.length - MAX_RUNS);
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(db, null, 1));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DB_FILE);
}

// Coalesces bursts of changes within one tick into a single write.
export function save() {
  if (pending) return;
  pending = true;
  setImmediate(() => {
    if (pending) flush();
  });
}

// Runs still marked "running" at boot were cut off by a restart.
for (const run of db.runs) {
  if (run.status === 'running') {
    run.status = 'failed';
    run.error = 'Interrupted: the server restarted while this run was in progress.';
    run.finishedAt = now();
  }
}
flush();
