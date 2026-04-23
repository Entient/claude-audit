#!/usr/bin/env node
// Producer-side contract tests for the spend_pressure/<session_id>.json artifact.
// Verifies shape, schema stamp, session_id parsing, atomic write semantics.
// Consumer-side validation is in Agent/test_pressure_signal_consumer.py.

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const {
  buildPressurePayload,
  emitPressureSignal,
  pressureSignalPath,
  sweepStalePressureFiles,
  PRESSURE_SIGNAL_DIR,
  PRESSURE_SCHEMA,
  PRESSURE_TTL_S,
} = require("./audit.js");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else      { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── buildPressurePayload: pure shape ─────────────────────────────────────────
{
  const fakeFile = "C:/fake/12345678-1234-1234-1234-123456789abc.jsonl";
  const w = { turns: 177, baseline: 169012, current: 542141, factor: 3.2, blocked: false };
  const p = buildPressurePayload(fakeFile, w, 99);

  t("payload schema stamp",       p.schema === PRESSURE_SCHEMA);
  t("payload ts is iso string",   typeof p.ts === "string" && /^\d{4}-\d{2}-\d{2}T/.test(p.ts));
  t("payload session_id parsed",  p.session_id === "12345678-1234-1234-1234-123456789abc");
  t("payload session_file set",   p.session_file === fakeFile);
  t("payload ttl_seconds",        p.ttl_seconds === PRESSURE_TTL_S);
  t("payload producer name",      p.producer === "entient-spend");
  t("payload producer version",   typeof p.producer_version === "string" && p.producer_version.length > 0);
  t("payload.pressure.factor",    p.pressure.factor === 3.2);
  t("payload.pressure.turn_count",p.pressure.turn_count === 177);
  t("payload.pressure.baseline",  p.pressure.baseline_tokens_per_turn === 169012);
  t("payload.pressure.current",   p.pressure.current_tokens_per_turn === 542141);
  t("payload.pressure.cache_read",p.pressure.cache_read_pct === 99);
}

// ── buildPressurePayload: below-minTurns returns null ────────────────────────
{
  const p = buildPressurePayload("C:/fake/x.jsonl", { turns: 3, factor: 1, blocked: false }, null);
  t("below minTurns → null payload", p === null);

  const p2 = buildPressurePayload("C:/fake/x.jsonl", null, null);
  t("null w → null payload", p2 === null);
}

// ── buildPressurePayload: non-UUID file name → null session_id ───────────────
{
  const p = buildPressurePayload("C:/not-a-uuid-name.jsonl",
    { turns: 50, baseline: 1000, current: 2000, factor: 2.0 }, null);
  t("non-uuid filename → null session_id", p.session_id === null);
}

// ── emitPressureSignal: writes valid JSON at partitioned path ────────────────
{
  const sid = "abcdef12-1111-2222-3333-abcdef123456";
  const fakeFile = `C:/fake/${sid}.jsonl`;
  const w = { turns: 42, baseline: 50000, current: 150000, factor: 3.0 };
  const res = emitPressureSignal(fakeFile, w, 85);
  const expectedPath = pressureSignalPath(sid);

  t("emit ok=true",               res.ok === true);
  t("emit path matches partition",res.path === expectedPath);
  t("partitioned path inside DIR",res.path.startsWith(PRESSURE_SIGNAL_DIR));
  t("partitioned filename",       path.basename(res.path) === `${sid}.json`);
  t("file exists on disk",        fs.existsSync(res.path));

  const on_disk = JSON.parse(fs.readFileSync(res.path, "utf8"));
  t("on-disk schema",             on_disk.schema === PRESSURE_SCHEMA);
  t("on-disk session_id",         on_disk.session_id === sid);
  t("on-disk factor",             on_disk.pressure.factor === 3.0);
  t("on-disk cache_read_pct",     on_disk.pressure.cache_read_pct === 85);
  t("on-disk pretty-printed",     fs.readFileSync(res.path, "utf8").includes("\n  "));

  // Atomic write: no leftover .tmp at the partitioned path
  t("no leftover .tmp after emit", !fs.existsSync(res.path + ".tmp"));
}

// ── emitPressureSignal: two distinct sessions do not collide ─────────────────
{
  const sidA = "aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa";
  const sidB = "bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb";
  const w = { turns: 10, baseline: 1000, current: 2000, factor: 2.0 };
  const rA = emitPressureSignal(`C:/fake/${sidA}.jsonl`, w, 50);
  const rB = emitPressureSignal(`C:/fake/${sidB}.jsonl`, w, 50);
  t("sessionA emit ok",            rA.ok === true);
  t("sessionB emit ok",            rB.ok === true);
  t("distinct paths",              rA.path !== rB.path);
  const a = JSON.parse(fs.readFileSync(rA.path, "utf8"));
  const b = JSON.parse(fs.readFileSync(rB.path, "utf8"));
  t("sessionA file has its sid",   a.session_id === sidA);
  t("sessionB file has its sid",   b.session_id === sidB);
}

// ── emitPressureSignal: below-minTurns returns ok:false ──────────────────────
{
  const res = emitPressureSignal("C:/fake/x.jsonl", { turns: 2, factor: 1 }, null);
  t("below-minTurns → ok=false", res.ok === false);
  t("below-minTurns reason",     /below_minTurns/.test(res.error || ""));
}

// ── emitPressureSignal: null session_id (non-UUID filename) → ok:false ───────
{
  // buildPressurePayload returns payload.session_id=null when name isn't UUID.
  // emitPressureSignal must refuse to partition-write a null session.
  const res = emitPressureSignal("C:/fake/not-a-uuid.jsonl",
    { turns: 50, baseline: 1000, current: 2000, factor: 2.0 }, null);
  t("null session_id → ok=false", res.ok === false);
  t("null session_id reason",     /no_session_id/.test(res.error || ""));
}

// ── sweepStalePressureFiles: removes files older than 2*TTL ──────────────────
{
  // Plant a stale file and a fresh file; confirm only stale is swept
  fs.mkdirSync(PRESSURE_SIGNAL_DIR, { recursive: true });
  const stale = path.join(PRESSURE_SIGNAL_DIR, "stale-sweep-test.json");
  const fresh = path.join(PRESSURE_SIGNAL_DIR, "fresh-sweep-test.json");
  fs.writeFileSync(stale, "{}", "utf8");
  fs.writeFileSync(fresh, "{}", "utf8");
  // Rewind stale's mtime by > 2*TTL
  const oldMs = Date.now() - (2 * PRESSURE_TTL_S * 1000 + 60_000);
  fs.utimesSync(stale, oldMs / 1000, oldMs / 1000);

  sweepStalePressureFiles();
  t("stale file swept",  !fs.existsSync(stale));
  t("fresh file kept",   fs.existsSync(fresh));
  try { fs.unlinkSync(fresh); } catch (_) {}
}

console.log(`\n${fail === 0 ? "OK" : "FAIL"}  ${pass}/${pass + fail} pressure-signal producer cases pass`);
process.exit(fail === 0 ? 0 : 1);
