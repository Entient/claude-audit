#!/usr/bin/env node
// Smoke test for saveSessionContext enrichment: structured dirty state,
// inferred objective / next action, ready boolean + reason, and the
// CLEAR_RECOMMENDED gate's underlying readiness signal.

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const {
  saveSessionContext,
  inferObjective,
  inferNextAction,
  getStructuredDirty,
  _readinessCheck,
} = require("./audit.js");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else      { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── _readinessCheck ──────────────────────────────────────────────────────────
{
  const full = _readinessCheck({
    branch: "master", headSubject: "last commit", hasLastActivity: true,
    objective: "do X", nextAction: "then Y",
  });
  t("readiness: all present → ready true", full.ready === true && full.readyReason === null);

  const missing = _readinessCheck({
    branch: null, headSubject: null, hasLastActivity: false,
    objective: null, nextAction: null,
  });
  t("readiness: all missing → ready false",
    missing.ready === false && /branch/.test(missing.readyReason) && /inferred-next-action/.test(missing.readyReason));

  const partial = _readinessCheck({
    branch: "master", headSubject: "c", hasLastActivity: true,
    objective: "obj", nextAction: null,
  });
  t("readiness: next action missing → ready false, reason names it",
    partial.ready === false && /inferred-next-action/.test(partial.readyReason));
}

// ── inferObjective / inferNextAction ─────────────────────────────────────────
{
  const none = inferObjective(null);
  t("objective: null input → null", none === null);

  const single = inferObjective(
    "I'll fix the authentication bug in the login flow. Then I'll run the test suite to verify."
  );
  t("objective: first sentence extracted", typeof single === "string" && /authentication bug/.test(single));

  const twoExcerpts =
    "Continuing work on gate consumer parity. Added fixture rows.\n\n---\n\n" +
    "Next: run the comparison harness against BrockPC and record the verdict.";
  const obj = inferObjective(twoExcerpts);
  t("objective: uses oldest excerpt", obj && /gate consumer parity/.test(obj));

  const next = inferNextAction(twoExcerpts);
  t("next action: explicit Next: captured",
    next && /comparison harness/.test(next), `got: ${next}`);

  const implicit = inferNextAction("I finished the sweep. I still need to update the registry entry.");
  t("next action: falls back to last sentence",
    implicit && /registry entry/.test(implicit), `got: ${implicit}`);
}

// ── getStructuredDirty on a throwaway repo ───────────────────────────────────
{
  const { execSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ess-dirty-"));
  try {
    execSync("git init -q", { cwd: tmp });
    execSync("git config user.email a@b.c", { cwd: tmp });
    execSync("git config user.name test", { cwd: tmp });

    fs.writeFileSync(path.join(tmp, "baseline.txt"), "baseline\n");
    execSync("git add baseline.txt", { cwd: tmp });
    execSync("git commit -q -m base", { cwd: tmp });

    // Staged new file
    fs.writeFileSync(path.join(tmp, "staged.txt"), "staged\n");
    execSync("git add staged.txt", { cwd: tmp });
    // Unstaged edit to baseline
    fs.writeFileSync(path.join(tmp, "baseline.txt"), "baseline\nmore\n");
    // Untracked file
    fs.writeFileSync(path.join(tmp, "untracked.txt"), "raw\n");

    const d = getStructuredDirty(tmp);
    t("dirty: staged contains staged.txt",   d.staged.includes("staged.txt"));
    t("dirty: unstaged contains baseline.txt", d.unstaged.includes("baseline.txt"));
    t("dirty: untracked contains untracked.txt", d.untracked.includes("untracked.txt"));
    t("dirty: total counts all three buckets", d.total === 3, `got ${d.total}`);

    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "ess-clean-"));
    execSync("git init -q", { cwd: clean });
    const dc = getStructuredDirty(clean);
    t("dirty: empty repo → all buckets empty",
      dc.total === 0 && dc.staged.length === 0 && dc.unstaged.length === 0 && dc.untracked.length === 0);

    const nonrepo = fs.mkdtempSync(path.join(os.tmpdir(), "ess-nonrepo-"));
    const dn = getStructuredDirty(nonrepo);
    t("dirty: non-repo → total 0, no throw", dn.total === 0);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── saveSessionContext end-to-end against a fixture session file ─────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ess-ctx-"));
  const sessionFile = path.join(tmp, "session.jsonl");
  const excerpt1 = "Continuing the continuation-policy doctrine fixes. Stage #3 is the enrichment pass on saveSessionContext.";
  const excerpt2 = "Next: add structured dirty state, inferred objective, and inferred next action, then gate CLEAR_RECOMMENDED on ready.";
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ role: "assistant", content: [{ type: "text", text: excerpt1 }] }),
    JSON.stringify({ role: "user", content: "ok" }),
    JSON.stringify({ role: "assistant", content: [{ type: "text", text: excerpt2 }] }),
  ].join("\n"), "utf8");

  const origCwd = process.cwd();
  const origProj = process.env.CLAUDE_PROJECT_DIR;
  // Point saveSessionContext at the entient-spend repo itself (real git repo,
  // has branch + HEAD commit). That keeps the test hermetic enough while
  // exercising all the real helpers.
  const repo = path.resolve(__dirname);
  process.env.CLAUDE_PROJECT_DIR = repo;
  try {
    const out = saveSessionContext(sessionFile, { turns: 42, factor: 8, current: 50_000, baseline: 6_000 });

    t("ctx: ok=true",                      out.ok === true);
    t("ctx: project resolved",             typeof out.project === "string" && out.project.length > 0);
    t("ctx: branch captured",              typeof out.branch === "string" && out.branch.length > 0);
    t("ctx: dirty is object",              out.dirty && typeof out.dirty === "object" && Array.isArray(out.dirty.staged));
    t("ctx: modifiedCount === dirty.total", out.modifiedCount === out.dirty.total);
    t("ctx: headSubject non-null",         typeof out.headSubject === "string" && out.headSubject.length > 0);
    t("ctx: hasLastActivity true",         out.hasLastActivity === true);
    t("ctx: objective inferred from oldest excerpt",
      typeof out.objective === "string" && /continuation-policy/.test(out.objective));
    t("ctx: nextAction picked up Next: line",
      typeof out.nextAction === "string" && /structured dirty state/.test(out.nextAction),
      `got: ${out.nextAction}`);
    t("ctx: ready true when all fields present",
      out.ready === true && out.readyReason === null);

    // On-disk render sanity: file exists, has the new sections.
    const disk = fs.readFileSync(out.contextPath, "utf8");
    t("disk: Dirty state section present",        /## Dirty state/.test(disk));
    t("disk: Inferred continuity section present", /## Inferred continuity/.test(disk));
    t("disk: handoff-ready line says yes",        /Handoff ready:\*\*\s+yes/.test(disk));

    // Now exercise the un-ready path — empty session file → no activity → no
    // inferred objective / next action → ready must be false with reason.
    const emptyFile = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(emptyFile, "", "utf8");
    const unready = saveSessionContext(emptyFile, { turns: 1, factor: 2, current: 20_000, baseline: 10_000 });
    t("unready: ok=true (still writes file)",     unready.ok === true);
    t("unready: ready=false",                     unready.ready === false);
    t("unready: reason lists missing inputs",
      /inferred-objective/.test(unready.readyReason) && /inferred-next-action/.test(unready.readyReason));
    const unreadyDisk = fs.readFileSync(unready.contextPath, "utf8");
    t("unready disk: handoff-ready line says no with reason", /Handoff ready:\*\*\s+no — missing:/.test(unreadyDisk));
  } finally {
    if (origProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProj;
    process.chdir(origCwd);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log(`\n${fail === 0 ? "OK" : "FAIL"}  ${pass}/${pass + fail} saveSessionContext enrichment cases pass`);
process.exit(fail === 0 ? 0 : 1);
