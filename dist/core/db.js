import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ensureHome, mcHome } from "./config.js";
let db = null;
export function openDb() {
    if (db)
        return db;
    ensureHome();
    db = new DatabaseSync(join(mcHome(), "mc.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      parent_run_id TEXT,
      root_run_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      model TEXT,
      host TEXT NOT NULL,
      prompt TEXT NOT NULL,
      title TEXT NOT NULL,
      spec_path TEXT NOT NULL,
      workdir TEXT NOT NULL,
      session_id TEXT,
      exit TEXT NOT NULL,
      verdict TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      cost_usd REAL,
      cost_basis TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      budget_usd REAL,
      max_minutes REAL,
      auth_mode TEXT NOT NULL,
      gateway TEXT,
      pid INTEGER,
      supervisor_pid INTEGER,
      stderr_path TEXT NOT NULL,
      artifacts TEXT NOT NULL,
      verify_evidence TEXT,
      notified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
    migrate(db);
    return db;
}
/** Rename-only migrations for pre-claude-shape databases (goal/session_ref era). */
function migrate(d) {
    const columns = d.prepare("PRAGMA table_info(runs)").all().map((c) => c.name);
    if (columns.includes("goal"))
        d.exec("ALTER TABLE runs RENAME COLUMN goal TO prompt");
    if (columns.includes("session_ref"))
        d.exec("ALTER TABLE runs RENAME COLUMN session_ref TO session_id");
}
/** Test-only: drop the cached handle so a new MC_HOME takes effect. */
export function resetDbForTest() {
    db?.close();
    db = null;
}
function rowToRun(row) {
    return { ...row, artifacts: JSON.parse(row.artifacts), notified: row.notified === 1 };
}
function dollarKeys(obj) {
    const out = {};
    for (const [key, value] of Object.entries(obj))
        out[`$${key}`] = value;
    return out;
}
const RUN_COLUMNS = [
    "id", "parent_run_id", "root_run_id", "harness", "model", "host", "prompt", "title",
    "spec_path", "workdir", "session_id", "exit", "verdict", "started_at", "ended_at",
    "cost_usd", "cost_basis", "tokens_in", "tokens_out", "budget_usd", "max_minutes",
    "auth_mode", "gateway", "pid", "supervisor_pid", "stderr_path", "artifacts", "verify_evidence", "notified",
];
export function insertRun(run) {
    const params = dollarKeys({
        ...run,
        artifacts: JSON.stringify(run.artifacts),
        notified: run.notified ? 1 : 0,
    });
    const columns = RUN_COLUMNS.join(", ");
    const placeholders = RUN_COLUMNS.map((c) => `$${c}`).join(", ");
    openDb().prepare(`INSERT INTO runs (${columns}) VALUES (${placeholders})`).run(params);
}
export function updateRun(id, fields) {
    const patch = { ...fields };
    if ("artifacts" in patch)
        patch.artifacts = JSON.stringify(patch.artifacts);
    if ("notified" in patch)
        patch.notified = patch.notified ? 1 : 0;
    const keys = Object.keys(patch);
    if (keys.length === 0)
        return;
    const sets = keys.map((k) => `${k} = $${k}`).join(", ");
    openDb()
        .prepare(`UPDATE runs SET ${sets} WHERE id = $__id`)
        .run(dollarKeys({ ...patch, __id: id }));
}
export function getRun(id) {
    const row = openDb().prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? rowToRun(row) : null;
}
/** Prefix match so short ids work on the CLI, full ids in code. */
export function findRun(idOrPrefix) {
    const exact = getRun(idOrPrefix);
    if (exact)
        return exact;
    const rows = openDb()
        .prepare("SELECT * FROM runs WHERE id LIKE ? || '%' ORDER BY started_at DESC")
        .all(idOrPrefix);
    return rows.length === 1 ? rowToRun(rows[0]) : null;
}
export function listRuns() {
    return openDb().prepare("SELECT * FROM runs ORDER BY started_at DESC").all().map(rowToRun);
}
/**
 * Atomically transition a run to `lost` ONLY if it is still active. Returns
 * false when the supervisor won the race and already wrote a terminal row -
 * callers must not clobber that truth (reap TOCTOU).
 */
export function markLost(id) {
    const result = openDb()
        .prepare("UPDATE runs SET exit = 'lost', ended_at = ? WHERE id = ? AND exit IN ('running', 'queued')")
        .run(new Date().toISOString(), id);
    return Number(result.changes) > 0;
}
export function insertEvent(runId, kind, payload) {
    const insert = () => openDb()
        .prepare(`INSERT INTO events (run_id, seq, ts, kind, payload)
         VALUES (?, 1 + COALESCE((SELECT MAX(seq) FROM events WHERE run_id = ?), 0), ?, ?, ?)`)
        .run(runId, runId, new Date().toISOString(), kind, JSON.stringify(payload ?? {}));
    try {
        insert();
    }
    catch {
        insert(); // lost a seq race with another writer; the retry recomputes MAX(seq)
    }
}
export function eventsAfter(runId, afterSeq) {
    const rows = openDb()
        .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq")
        .all(runId, afterSeq);
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
