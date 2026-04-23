#!/usr/bin/env node
/**
 * Test: _readSessionSavings must scope by session_id when provided.
 *
 * Scenario: two concurrent Claude Code sessions write deflect events to
 * the shared governance_events.jsonl. Pre-fix, each session's warning-
 * light banner counted the other's deflects. Post-fix, each banner
 * should count only its own session's events.
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

// Point the module at a temp governance log BEFORE requiring audit.js.
// The module caches ENTIENT_GOV_LOG at top-level via `const`.
const TMP_LOG = path.join(
  os.tmpdir(),
  `entient_spend_gov_${process.pid}_${Date.now()}.jsonl`,
);
process.env.ENTIENT_GOV_LOG = TMP_LOG;

const { _readSessionSavings, AVG_USD_PER_INFERENCE } = require("./audit.js");

function writeLog(events) {
  const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  // Prepend a dummy first line because _readSessionSavings does lines.shift()
  // (first line may be byte-truncated in real tail-read). Without the shim,
  // the first real event would be discarded.
  fs.writeFileSync(TMP_LOG, "dummy-first-line-shifted-off\n" + lines);
}

function cleanup() {
  try { fs.unlinkSync(TMP_LOG); } catch (_) {}
}

try {
  const T0 = 1000;
  const SID_A = "session-aaaa";
  const SID_B = "session-bbbb";

  // Mixed deflects — both sessions active, both writing after T0.
  const events = [
    // Before sinceTs — should never count even without session filter
    { ts: T0 - 100, type: "deflect", data: { session_id: SID_A, confidence: 0.9 } },

    // Session A deflects
    { ts: T0 + 10, type: "deflect",          data: { session_id: SID_A, confidence: 0.9 } },
    { ts: T0 + 20, type: "deflect_measured", data: { session_id: SID_A, status: "ok", input_cost_usd_avoided: 0.03 } },
    { ts: T0 + 30, type: "deflect",          data: { session_id: SID_A, confidence: 0.8 } },

    // Session B deflects — leakage source pre-fix
    { ts: T0 + 15, type: "deflect",          data: { session_id: SID_B, confidence: 0.7 } },
    { ts: T0 + 25, type: "deflect_measured", data: { session_id: SID_B, status: "ok", input_cost_usd_avoided: 0.07 } },
    { ts: T0 + 35, type: "deflect_measured", data: { session_id: SID_B, status: "ok", input_cost_usd_avoided: 0.05 } },

    // Non-deflect event — must be ignored regardless of filter
    { ts: T0 + 40, type: "forward",          data: { session_id: SID_A, confidence: 0.2 } },

    // deflect_measured with status!=ok — must be ignored
    { ts: T0 + 50, type: "deflect_measured", data: { session_id: SID_A, status: "error" } },

    // Deflect with no session_id in data — should be excluded under filtering
    { ts: T0 + 55, type: "deflect",          data: { confidence: 0.6 } },
  ];
  writeLog(events);

  // ── Case 1: Session A only ────────────────────────────────────────
  const savedA = _readSessionSavings(T0, SID_A);
  assert.strictEqual(savedA.count, 3, `A.count expected 3, got ${savedA.count}`);
  assert.strictEqual(savedA.measured, true, "A.measured should be true (1 measured hit)");
  // A's USD: 1 deflect (AVG) + 1 measured (0.03) + 1 deflect (AVG) = 2*AVG + 0.03
  const expectedA = 2 * AVG_USD_PER_INFERENCE + 0.03;
  assert.ok(Math.abs(savedA.usd - expectedA) < 1e-9,
    `A.usd expected ${expectedA}, got ${savedA.usd}`);

  // ── Case 2: Session B only ────────────────────────────────────────
  const savedB = _readSessionSavings(T0, SID_B);
  assert.strictEqual(savedB.count, 3, `B.count expected 3, got ${savedB.count}`);
  assert.strictEqual(savedB.measured, true, "B.measured should be true (2 measured hits)");
  const expectedB = 1 * AVG_USD_PER_INFERENCE + 0.07 + 0.05;
  assert.ok(Math.abs(savedB.usd - expectedB) < 1e-9,
    `B.usd expected ${expectedB}, got ${savedB.usd}`);

  // ── Case 3: sessionId=null → pre-fix semantic (cross-session sum) ─
  // Legacy callers that deliberately want everything (full billing report).
  const savedAll = _readSessionSavings(T0, null);
  // All 6 well-formed deflects with ts >= T0 + the no-sid one = 7
  assert.strictEqual(savedAll.count, 7,
    `All.count expected 7 (all valid deflects regardless of sid), got ${savedAll.count}`);

  // ── Case 4: unknown session id → zero ─────────────────────────────
  const savedNone = _readSessionSavings(T0, "session-nonexistent");
  assert.strictEqual(savedNone.count, 0, `None.count expected 0, got ${savedNone.count}`);
  assert.strictEqual(savedNone.usd, 0, `None.usd expected 0, got ${savedNone.usd}`);
  assert.strictEqual(savedNone.measured, false, "None.measured should be false");

  // ── Case 5: sinceTs=0 / null → early return ───────────────────────
  const savedZero = _readSessionSavings(0, SID_A);
  assert.strictEqual(savedZero.count, 0, "sinceTs=0 must early-return zero");

  // ── Case 6: missing log file → zero, no crash ─────────────────────
  cleanup();
  const savedMissing = _readSessionSavings(T0, SID_A);
  assert.strictEqual(savedMissing.count, 0, "missing log must return zero");

  console.log("OK  6/6 _readSessionSavings scoping cases pass");
  console.log(`    Session A: ${savedA.count} deflects, $${savedA.usd.toFixed(4)}`);
  console.log(`    Session B: ${savedB.count} deflects, $${savedB.usd.toFixed(4)}`);
  console.log(`    Unscoped : ${savedAll.count} deflects (backwards-compat path)`);
} catch (err) {
  cleanup();
  console.error("FAIL", err.message);
  console.error(err.stack);
  process.exit(1);
}
