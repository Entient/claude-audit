#!/usr/bin/env node
/**
 * claude-audit — Claude Code Subscription Waste Analyzer
 *
 * Reads ~/.claude/history.jsonl (local, never uploaded) and shows:
 *   - Which sessions wasted money on the wrong model tier
 *   - ACK/continuation prompts that didn't need Sonnet/Opus
 *   - Sessions with context bloat (replay cost)
 *   - Per-session recommendations: start on Haiku, escalate at turn N
 *
 * No gateway, no proxy, no data upload. Runs entirely local.
 *
 * Usage:
 *   npx claude-audit                  # last 7 days
 *   npx claude-audit --last 30d
 *   npx claude-audit --last 24h
 *   npx claude-audit --json
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { last: "7d", json: false };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--last" || args[i] === "-l") && args[i + 1]) opts.last = args[++i];
    else if (args[i].startsWith("--last=")) opts.last = args[i].slice(7);
    else if (args[i] === "--json") opts.json = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: claude-audit [--last 7d|24h|30d] [--json]");
      process.exit(0);
    }
  }
  return opts;
}

function parseWindow(s) {
  const m = s.match(/^(\d+)(h|d|w)$/i);
  if (!m) throw new Error(`Invalid --last value: ${s}. Use 24h, 7d, 30d etc.`);
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const hours = unit === "h" ? n : unit === "d" ? n * 24 : n * 168;
  return { hours, since: new Date(Date.now() - hours * 3_600_000) };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLAUDE_HISTORY  = path.join(os.homedir(), ".claude", "history.jsonl");
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

// ---------------------------------------------------------------------------
// Prompt complexity classifiers
// ---------------------------------------------------------------------------

const CONTINUATION_RE = /^(proceed|continue|do it|go ahead|yes|no|ok|good|both|all|now do|next|great|sounds|done|sure|right|correct|perfect|got it|makes sense|agreed)\b/i;
const SHORT_ACK       = 8;
const HIGH_RE         = /traceback|error:|exception:|nameerror|typeerror|assertionerror|```|architect|implement|refactor|generate code|write.*test|update.*spec/i;
const LOW_RE          = /^(where is|what is|what are|what was|did you|does the|how do|can you show|rename it|it wasn.t)/i;

function classifyPromptComplexity(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  const wordCount = t.split(/\s+/).length;
  const hasHigh = HIGH_RE.test(t);
  if (hasHigh) return "high";
  if (CONTINUATION_RE.test(t) || (!hasHigh && wordCount <= SHORT_ACK)) return "continuation";
  if (LOW_RE.test(t)) return "low";
  return "medium";
}

function readConfiguredModel() {
  try {
    const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
    return s.model || "sonnet";
  } catch (_) { return "sonnet"; }
}

// ---------------------------------------------------------------------------
// Read ~/.claude/history.jsonl
// ---------------------------------------------------------------------------

function readSubscriptionActivity(since) {
  if (!fs.existsSync(CLAUDE_HISTORY)) {
    return { available: false, reason: "~/.claude/history.jsonl not found" };
  }

  const sinceMs  = since.getTime();
  const sessions = {};
  const daily    = {};
  const projects = {};
  const complexity = { continuation: 0, low: 0, medium: 0, high: 0, empty: 0 };
  let total = 0;

  try {
    const raw = fs.readFileSync(CLAUDE_HISTORY, { encoding: "utf8" });
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      const ts = rec.timestamp || 0;
      if (ts < sinceMs) continue;

      const sid  = rec.sessionId || "unknown";
      const proj = path.basename(rec.project || "unknown");
      const day  = new Date(ts).toISOString().slice(0, 10);
      const cat  = classifyPromptComplexity(rec.display || "");

      if (!sessions[sid]) sessions[sid] = {
        project: proj, prompts: 0, firstTs: ts, lastTs: ts,
        complexity: {}, firstHighTurn: -1, first5: [],
      };

      const turnIdx = sessions[sid].prompts;
      if (sessions[sid].first5.length < 5) sessions[sid].first5.push(cat);
      if (cat === "high" && sessions[sid].firstHighTurn === -1) sessions[sid].firstHighTurn = turnIdx;

      sessions[sid].prompts++;
      sessions[sid].lastTs = Math.max(sessions[sid].lastTs, ts);
      sessions[sid].complexity[cat] = (sessions[sid].complexity[cat] || 0) + 1;

      daily[day]      = (daily[day]     || 0) + 1;
      projects[proj]  = (projects[proj] || 0) + 1;
      complexity[cat] = (complexity[cat] || 0) + 1;
      total++;
    }
  } catch (e) {
    return { available: false, reason: e.message };
  }

  const configuredModel = readConfiguredModel();
  const topSessions = Object.entries(sessions)
    .map(([sid, s]) => ({ sid, ...s }))
    .sort((a, b) => b.prompts - a.prompts);

  const haikuEligible = (complexity.continuation || 0) + (complexity.low || 0);
  const wasteAnalysis = analyzeSessionWaste(topSessions.slice(0, 10), configuredModel);

  return {
    available: true,
    totalPrompts: total,
    configuredModel,
    complexity,
    haikuEligible,
    dailyCounts: daily,
    topProjects: Object.entries(projects).sort((a, b) => b[1] - a[1]).slice(0, 8),
    topSessions: topSessions.slice(0, 10),
    wasteAnalysis,
  };
}

// ---------------------------------------------------------------------------
// Session waste classification
// ---------------------------------------------------------------------------

const MODEL_COST_PER_M = { opus: 15.00, sonnet: 3.00, haiku: 0.80 };

function analyzeSessionWaste(topSessions, configuredModel) {
  return topSessions.map(session => {
    const t  = session.prompts;
    const cx = session.complexity || {};

    const ackCount   = cx.continuation || 0;
    const lowCount   = cx.low          || 0;
    const highCount  = cx.high         || 0;
    const haikuCount = ackCount + lowCount;

    const ackPct   = t > 0 ? ackCount   / t : 0;
    const highPct  = t > 0 ? highCount  / t : 0;
    const haikuPct = t > 0 ? haikuCount / t : 0;

    const durationMs  = session.lastTs - session.firstTs;
    const durationHrs = durationMs / 3_600_000;

    let longContextRisk;
    if (t > 40 || durationHrs > 2)        longContextRisk = "high";
    else if (t > 15 || durationHrs > 0.5) longContextRisk = "medium";
    else                                   longContextRisk = "low";

    const first5High    = (session.first5 || []).filter(c => c === "high").length;
    const firstHighTurn = session.firstHighTurn != null ? session.firstHighTurn : -1;
    const opensHard     = first5High >= 2 || (firstHighTurn >= 0 && firstHighTurn < 5);

    let recommendedStartModel, escalation;
    if (firstHighTurn === -1) {
      recommendedStartModel = "haiku";
      escalation = "no escalation needed — no complex prompts found";
    } else if (opensHard) {
      recommendedStartModel = "sonnet";
      escalation = `sonnet from start (first complex prompt at turn ${firstHighTurn})`;
    } else if (firstHighTurn > 10) {
      recommendedStartModel = "haiku";
      escalation = `start on haiku, escalate to sonnet at turn ${firstHighTurn}`;
    } else {
      recommendedStartModel = "sonnet";
      escalation = `sonnet from turn ${firstHighTurn} (complexity arrives early)`;
    }

    const wasteTypes = [];
    if (haikuPct >= 0.50 && configuredModel !== "haiku") wasteTypes.push("wrong_model");
    if (ackPct  >= 0.35 && t > 12)                       wasteTypes.push("session_bloat");
    if (longContextRisk === "high")                       wasteTypes.push("context_replay");

    const configCostPerM  = MODEL_COST_PER_M[configuredModel] || MODEL_COST_PER_M["sonnet"];
    const haikuCostPerM   = MODEL_COST_PER_M["haiku"];
    const estimatedWaste  = haikuCount * 300 / 1_000_000 * (configCostPerM - haikuCostPerM);

    return {
      sid: session.sid, project: session.project,
      prompts: t, firstTs: session.firstTs, lastTs: session.lastTs,
      durationHrs: Math.round(durationHrs * 10) / 10,
      ackPct:   Math.round(ackPct   * 100),
      highPct:  Math.round(highPct  * 100),
      haikuPct: Math.round(haikuPct * 100),
      longContextRisk, recommendedStartModel, escalation,
      wasteTypes,
      estimatedWaste: Math.round(estimatedWaste * 10000) / 10000,
    };
  });
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

const W = 62;
const hr  = (ch = "-") => ch.repeat(W);
const row = (label, value) => `  ${label.padEnd(32)} ${value}`;

function formatReport(sub, window) {
  const lines = [];

  lines.push(hr("="));
  lines.push(`  CLAUDE CODE WASTE REPORT  (last ${window})`);
  lines.push(hr("="));

  if (!sub.available) {
    lines.push(`  ERROR: ${sub.reason}`);
    lines.push(hr("="));
    return lines.join("\n");
  }

  const t = sub.totalPrompts;
  const c = sub.complexity;
  const haiku    = sub.haikuEligible;
  const haikuPct = t > 0 ? (haiku / t * 100).toFixed(0) : 0;
  const model    = sub.configuredModel;

  // Top-line summary
  lines.push(row("  Configured model", model));
  lines.push(row("  Total prompts", `${t.toLocaleString()} (last ${window})`));
  lines.push(row("  Haiku-eligible prompts", `${haiku} (${haikuPct}%) — ran on ${model} unnecessarily`));
  lines.push("");

  // Complexity breakdown
  lines.push("  Prompt complexity breakdown:");
  const order = [
    ["continuation", "ACK / continuation  (Haiku-trivial)"],
    ["low",          "Low complexity      (Haiku-ok)      "],
    ["medium",       "Medium              (ambiguous)     "],
    ["high",         "High complexity     (Sonnet needed) "],
  ];
  for (const [key, label] of order) {
    const n   = c[key] || 0;
    const pct = t > 0 ? (n / t * 100).toFixed(1) : "0.0";
    const bar = "#".repeat(Math.round(n / t * 22));
    lines.push(`    ${label}  ${String(n).padStart(4)}  (${pct}%)  ${bar}`);
  }
  lines.push("");

  if ((model === "sonnet" || model === "opus") && haiku > 0) {
    lines.push(`  [!] ${haiku} prompts (${haikuPct}%) didn't need ${model}.`);
    lines.push(`      Switching those to Haiku saves ~${Math.round(haiku * 300 / 1_000_000 * (MODEL_COST_PER_M[model] - MODEL_COST_PER_M["haiku"]) * 10000) / 10000} USD (API) or`);
    lines.push(`      a proportional fraction of your subscription limit.`);
    lines.push("");
  }

  // Daily activity
  lines.push("  Daily prompt activity:");
  for (const [day, count] of Object.entries(sub.dailyCounts).sort()) {
    const bar = "#".repeat(Math.min(Math.round(count / 5), 28));
    lines.push(`    ${day}  ${String(count).padStart(4)}  ${bar}`);
  }
  lines.push("");

  // Top projects
  lines.push("  Top projects:");
  for (const [proj, count] of sub.topProjects.slice(0, 6)) {
    lines.push(`    ${String(count).padStart(4)}  ${proj}`);
  }
  lines.push("");

  // Session waste analysis
  lines.push(hr());
  lines.push("  SESSION WASTE ANALYSIS");
  lines.push(hr());
  lines.push("");

  if (model === "opus") {
    lines.push("  [!!] ALL SESSIONS RAN ON OPUS — even ACKs cost 5x Sonnet, ~19x Haiku");
    lines.push("");
  }

  const wa = sub.wasteAnalysis || [];
  if (wa.length === 0) {
    lines.push("  (no sessions with enough prompts to analyze)");
  }

  wa.forEach((s, idx) => {
    const dt = new Date(s.lastTs).toISOString().slice(0, 16).replace("T", " ");
    lines.push(`  ${idx + 1}. [${s.sid.slice(0, 8)}]  ${s.project}  ${dt}`);
    lines.push(`     ${s.prompts} prompts over ${s.durationHrs}h  |  ACK: ${s.ackPct}%  High: ${s.highPct}%  Haiku-ok: ${s.haikuPct}%`);

    const risk = s.longContextRisk === "high" ? "[HIGH]" : s.longContextRisk === "medium" ? "[MED]" : "[LOW]";
    lines.push(`     Context risk: ${risk}  |  Recommendation: ${s.recommendedStartModel.toUpperCase()} — ${s.escalation}`);

    if (s.wasteTypes.length === 0) {
      lines.push("     No significant waste pattern detected.");
    } else {
      const labels = {
        wrong_model:    `wrong model (${s.haikuPct}% haiku-eligible, est. ~$${s.estimatedWaste.toFixed(4)} excess)`,
        session_bloat:  `session bloat (${s.ackPct}% ACKs — each replays full context)`,
        context_replay: `context replay (${s.durationHrs}h session, turns 30+ cost 10k-30k tokens each)`,
      };
      lines.push(`     Waste: ${s.wasteTypes.map(w => labels[w]).join(" + ")}`);
      if (s.wasteTypes.length >= 2) lines.push(`     [!!] Triple-cost event — model tier + bloat + context all compounding.`);
    }
    lines.push("");
  });

  // How to act
  lines.push(hr());
  lines.push("  HOW TO ACT ON THIS");
  lines.push(hr());
  lines.push("  1. Start exploratory sessions on Haiku:  /model haiku");
  lines.push("  2. Switch to Sonnet when real complexity arrives (see turn # above)");
  lines.push("  3. Use /compact before sessions exceed 30 turns to reset context");
  lines.push("  4. Split long sessions — a fresh session is cheaper than replay");
  lines.push("");
  lines.push("  Want automated enforcement?");
  lines.push("  → entient.ai  (routes each prompt to the right model automatically)");
  lines.push("");

  lines.push(hr("="));
  lines.push(`  Generated ${new Date().toISOString()}`);
  lines.push(`  Data source: ${CLAUDE_HISTORY}`);
  lines.push(hr("="));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts  = parseArgs();
  const { since } = parseWindow(opts.last);

  const sub = readSubscriptionActivity(since);

  if (opts.json) {
    console.log(JSON.stringify({ window: opts.last, subscription: sub }, null, 2));
    return;
  }

  console.log(formatReport(sub, opts.last));
}

main();
