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
      started_at TEXT NOT NULL,
      ended_at TEXT,
      cost_usd REAL,
      cost_basis TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      budget_usd REAL,
      max_minutes REAL,
      max_idle_minutes REAL,
      auth_mode TEXT NOT NULL,
      gateway TEXT,
      pid INTEGER,
      supervisor_pid INTEGER,
      stderr_path TEXT NOT NULL,
      artifacts TEXT NOT NULL,
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
    -- Attributed, append-only review receipts against a run. No migrations
    -- exist in this project by design (CREATE TABLE IF NOT EXISTS is the
    -- whole mechanism) - this table sits alongside runs/events the same way,
    -- and its schema is settled deliberately: there is no migration path to
    -- fix it later once real fleets are writing rows.
    --
    -- Principles (load-bearing; do not "fix" these in a way that violates them):
    --   - GENUINELY append-only - no UPDATE statement in this codebase ever
    --     targets this table, full stop. A correction is a NEW row (higher
    --     seq), never a mutation of an old one - there is no
    --     updateAssessment. This is why delivery bookkeeping for
    --     [notify.assessment] (the "notified" flag) lives in the SEPARATE
    --     "assessment_notifications" table below, keyed (run_id,
    --     assessment_seq), instead of as a column here: a mutable delivery
    --     flag on this table would UPDATE a judgment row in place every time
    --     a push claim was taken or released, contradicting "append-only" at
    --     the literal SQL level even though no CLI path ever edited the
    --     judgment fields themselves. Splitting it out makes the immutability
    --     true of the actual schema, not just of the code that happens to
    --     call it today.
    --   - pending_review is the ABSENCE of any row for a run, not a stored
    --     value. There is no disposition called "pending"; "mc ls"/"mc show"
    --     compute it by finding zero rows for a terminal run.
    --   - mc validates STRUCTURE only, never the judgment. "--disposition
    --     accepted" with contradictory or absent evidence is accepted anyway
    --     - rubber-stamping is permitted by design. Attribution ("reviewer",
    --     "observed") gives PROVENANCE (who claimed what, from where), not
    --     trust in the claim itself. mc is not, and must never become, a
    --     judge of quality. The CHECK constraints below enforce only
    --     STRUCTURE (a non-blank reviewer, one of the three literal
    --     dispositions) - never anything about whether the judgment is
    --     right, and they exist as defense in depth alongside the identical
    --     validation in cli.ts's "mc assess", since this schema has no
    --     migration path to add them later.
    --   - "reviewer" is an asserted identity: mandatory on every insert, never
    --     defaulted from the OS user or anything else - see "observed" below
    --     for why those are kept separate. Whitespace-only is rejected (both
    --     here, via CHECK, and in cli.ts before it ever reaches this table).
    --   - "observed" is what MC ITSELF independently saw while recording the
    --     assessment (the executing os user@host) - kept as its own column,
    --     distinct from "reviewer", so a false or aliased "--by" claim is at
    --     least checkable against what actually ran the command, without
    --     mc ever pretending to arbitrate between the two.
    --   - No internal mc code path may ever INSERT (or UPDATE) a row here.
    --     "mc assess" (a human- or orchestrator-invoked CLI command) is the
    --     only writer that may ever exist for this table. The supervisor,
    --     "mc reap", "mc kill", the notify seams - none of them may write a
    --     judgment here on mc's own initiative. (The notify seam DOES write
    --     to "assessment_notifications" below - that is delivery bookkeeping
    --     about a judgment, never the judgment itself.)
    CREATE TABLE IF NOT EXISTS assessments (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      reviewer TEXT NOT NULL CHECK (length(trim(reviewer)) > 0),
      disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'retry', 'blocked')),
      checkpoint_sha TEXT,
      evidence TEXT NOT NULL,
      note TEXT,
      observed TEXT,
      PRIMARY KEY (run_id, seq)
    );
    -- Delivery bookkeeping for assessment rows, split out from "assessments"
    -- above specifically so that table stays genuinely append-only (see its
    -- comment). One row per assessment, created lazily on first delivery
    -- attempt (a brand-new assessment simply has no row here yet, which
    -- COALESCEs to "not yet notified" everywhere this is read - see
    -- claimAssessmentNotify/setAssessmentNotified/unnotifiedAssessments).
    CREATE TABLE IF NOT EXISTS assessment_notifications (
      run_id TEXT NOT NULL,
      assessment_seq INTEGER NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, assessment_seq)
    );
  `);
    return db;
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
    "spec_path", "workdir", "session_id", "exit", "started_at", "ended_at",
    "cost_usd", "cost_basis", "tokens_in", "tokens_out", "budget_usd", "max_minutes", "max_idle_minutes",
    "auth_mode", "gateway", "pid", "supervisor_pid", "stderr_path", "artifacts", "notified",
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
/**
 * Atomically claim the notify obligation for a run: flips `notified` 0 -> 1
 * and returns whether THIS caller won the race. Mirrors markLost's
 * compare-and-swap shape. Without this, two callers racing on the same
 * terminal run (the supervisor's own exit path vs a concurrent `mc reap` or
 * a read command's inline reap) both read a stale `notified: false` and both
 * dispatch the hook. Only the claim winner may proceed to dispatch; see
 * notify.ts for how a total delivery failure releases the claim again.
 */
export function claimNotify(id) {
    const result = openDb()
        .prepare("UPDATE runs SET notified = 1 WHERE id = ? AND notified = 0")
        .run(id);
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
function rowToAssessment(row) {
    return { ...row, evidence: JSON.parse(row.evidence), notified: row.notified === 1 };
}
// Every SELECT against `assessments` joins its delivery state in from
// `assessment_notifications` (LEFT JOIN + COALESCE to 0) rather than reading
// a column on `assessments` itself - see that table's comment for why the
// split exists. A brand-new assessment has no row in the notifications table
// yet, which COALESCEs to "not notified" - exactly the right default for a
// row nothing has attempted to delivery yet.
const ASSESSMENT_SELECT = `
  SELECT a.run_id, a.seq, a.ts, a.reviewer, a.disposition, a.checkpoint_sha, a.evidence, a.note, a.observed,
         COALESCE(n.notified, 0) AS notified
  FROM assessments a
  LEFT JOIN assessment_notifications n ON n.run_id = a.run_id AND n.assessment_seq = a.seq
`;
/**
 * Append a new assessment row. There is deliberately no `updateAssessment` -
 * see the assessments table comment above: a correction is a new row with a
 * higher `seq`, never a mutation of an earlier one. The CHECK constraints on
 * `assessments` (non-blank reviewer, a real disposition) enforce structure at
 * the schema level too - this insert can throw if a caller ever bypasses
 * cli.ts's own validation.
 */
export function insertAssessment(runId, fields) {
    const ts = new Date().toISOString();
    const insert = () => openDb()
        .prepare(`INSERT INTO assessments (run_id, seq, ts, reviewer, disposition, checkpoint_sha, evidence, note, observed)
         VALUES (?, 1 + COALESCE((SELECT MAX(seq) FROM assessments WHERE run_id = ?), 0), ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, runId, ts, fields.reviewer, fields.disposition, fields.checkpoint_sha, JSON.stringify(fields.evidence), fields.note, fields.observed);
    let result;
    try {
        result = insert();
    }
    catch {
        // Mirrors insertEvent's retry exactly: lost a seq race with another
        // writer, so the retry recomputes MAX(seq). A CHECK-constraint violation
        // (blank reviewer, bad disposition - cli.ts should never produce one, but
        // this is defense in depth per the table comment) fails again identically
        // on the retry and propagates from there, same as any other permanent
        // failure would.
        result = insert();
    }
    const row = openDb().prepare(`${ASSESSMENT_SELECT} WHERE a.rowid = ?`).get(result.lastInsertRowid);
    return rowToAssessment(row);
}
/** All assessments for a run, oldest first - the full append-only history. */
export function assessmentsFor(runId) {
    return openDb().prepare(`${ASSESSMENT_SELECT} WHERE a.run_id = ? ORDER BY a.seq`).all(runId).map(rowToAssessment);
}
/**
 * The most recent assessment, or null. Callers must treat null as
 * pending_review, never as some other stored state - see the table comment:
 * pending_review is the ABSENCE of a row, not a value.
 */
export function latestAssessment(runId) {
    const rows = assessmentsFor(runId);
    return rows.length > 0 ? rows[rows.length - 1] : null;
}
/** Lazily create the delivery-state row for one assessment if it doesn't exist yet, defaulting to "not notified". */
function ensureAssessmentNotificationRow(runId, seq) {
    openDb()
        .prepare("INSERT OR IGNORE INTO assessment_notifications (run_id, assessment_seq, notified) VALUES (?, ?, 0)")
        .run(runId, seq);
}
/**
 * Atomically claim the notify obligation for ONE assessment: flips its
 * delivery-state row's `notified` 0 -> 1 and returns whether THIS caller won
 * the race. Mirrors claimNotify's compare-and-swap shape exactly, one level
 * down (per assessment instead of per run) - see notify.ts's notifyAssessment
 * for how a total delivery failure releases the claim again via
 * setAssessmentNotified. Operates on `assessment_notifications`, never on
 * `assessments` itself - see that table's comment for why.
 */
export function claimAssessmentNotify(runId, seq) {
    ensureAssessmentNotificationRow(runId, seq);
    const result = openDb()
        .prepare("UPDATE assessment_notifications SET notified = 1 WHERE run_id = ? AND assessment_seq = ? AND notified = 0")
        .run(runId, seq);
    return Number(result.changes) > 0;
}
export function setAssessmentNotified(runId, seq, notified) {
    ensureAssessmentNotificationRow(runId, seq);
    openDb()
        .prepare("UPDATE assessment_notifications SET notified = ? WHERE run_id = ? AND assessment_seq = ?")
        .run(notified ? 1 : 0, runId, seq);
}
/** Every assessment row still owed a delivery attempt - what `mc reap` retries. */
export function unnotifiedAssessments() {
    return openDb().prepare(`${ASSESSMENT_SELECT} WHERE COALESCE(n.notified, 0) = 0 ORDER BY a.run_id, a.seq`).all().map(rowToAssessment);
}
