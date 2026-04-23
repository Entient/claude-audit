#!/usr/bin/env node
// Producer-side contract tests for the spend_pressure.json artifact.
// Verifies shape, schema stamp, session_id parsing, atomic write semantics.
// Consumer-side validation is in Agent/test_pressure_signal_consumer.py.

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const {
  buildPressurePayload,
  emitPressureSignal,
  PRESSURE_SIGNAL,
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

// ── emitPressureSignal: writes valid JSON at canonical path ──────────────────
{
  const fakeFile = "C:/fake/abcdef12-1111-2222-3333-abcdef123456.jsonl";
  const w = { turns: 42, baseline: 50000, current: 150000, factor: 3.0 };
  const res = emitPressureSignal(fakeFile, w, 85);

  t("emit ok=true",               res.ok === true);
  t("emit path matches const",    res.path === PRESSURE_SIGNAL);
  t("file exists on disk",        fs.existsSync(PRESSURE_SIGNAL));

  const on_disk = JSON.parse(fs.readFileSync(PRESSURE_SIGNAL, "utf8"));
  t("on-disk schema",             on_disk.schema === PRESSURE_SCHEMA);
  t("on-disk session_id",         on_disk.session_id === "abcdef12-1111-2222-3333-abcdef123456");
  t("on-disk factor",             on_disk.pressure.factor === 3.0);
  t("on-disk cache_read_pct",     on_disk.pressure.cache_read_pct === 85);
  t("on-disk pretty-printed",     fs.readFileSync(PRESSURE_SIGNAL, "utf8").includes("\n  "));
}

// ── emitPressureSignal: atomic write (tmp gone afterward) ────────────────────
{
  const tmp = PRESSURE_SIGNAL + ".tmp";
  t("no leftover .tmp after emit", !fs.existsSync(tmp));
}

// ── emitPressureSignal: below-minTurns returns ok:false ──────────────────────
{
  const res = emitPressureSignal("C:/fake/x.jsonl", { turns: 2, factor: 1 }, null);
  t("below-minTurns → ok=false", res.ok === false);
  t("below-minTurns reason",     /below_minTurns/.test(res.error || ""));
}

console.log(`\n${fail === 0 ? "OK" : "FAIL"}  ${pass}/${pass + fail} pressure-signal producer cases pass`);
process.exit(fail === 0 ? 0 : 1);
