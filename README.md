# Entient Spend

**AI spend visibility for Claude Code — a reconciliation-grade cost report from the Anthropic Admin API, plus an advisory pressure-signal report from local metering.**

Two surfaces, kept distinct on purpose:

- **Reconciliation-grade** — `entient-spend cost-report` pulls actual billed dollars from Anthropic's `/v1/organizations/cost_report` (Admin API). Authoritative; use this when you need to answer "what did I actually pay?"
- **Advisory pressure-signal** — `entient-spend reconcile`, the dashboard, and the waste report estimate spend client-side from local metering using a token × price table. Useful for spotting runaway sessions and attributing tracked usage to project / tool / day — but **not invoice truth**. Token-price estimates can drift ±10–15% from the invoice and coverage gaps exist.

It also ships optional enforcement hooks for Claude Code that cap runaway-waste sessions and preserve context across compactions.

> **Naming:** Entient Spend is **not** the Entient Gateway. Gateway is a separate product surface (compute-collapse proxy with signed receipts) reserved under `@entient/gateway`. Spend reads from Gateway's metering data but does not stand in for it.

---

## Install

```bash
npm install -g @entient/spend
entient-spend install    # optional: register Claude Code hooks
```

Requires Node.js 16+.

---

## What it does

### 1. Reconciliation-grade cost report (Admin API)

```
entient-spend setup                          # store your Anthropic Admin API key
entient-spend cost-report --last 30d         # actual billed dollars from /v1/organizations/cost_report
```

These are the dollars Anthropic charged. Authoritative; aligned to the invoice.

### 2. Advisory pressure-signal report (local metering)

```
entient-spend                                # interactive dashboard (last 7d)
entient-spend reconcile ~/claude-audit-billing.json   # cross-reference against extension export
```

Estimates client-side from local metering using a token × price table. Useful for attributing tracked usage to project / tool / day:

```
Invoice $15.74  Mar 24    [advisory estimate]
  API usage that day: 4.2M tokens (tracked metering)
  → ENTIENT gateway MCP: 3.1M tok  Agent project  2:31pm–4:47pm
  → label_forwards.py:  1.1M tok  (untracked — estimated)
  Triggered when running total crossed $30 threshold
```

**Not invoice truth.** Token-price estimates can drift ±10–15%; coverage gaps exist for untracked direct API callers. For invoice reconciliation use `entient-spend cost-report`.

### 3. Waste report (session-level diagnostics)

```
entient-spend                 # last 7 days
entient-spend --last 30d
entient-spend --json          # machine-readable
```

Shows per-session token counts, waste factors, complexity tiers, and model recommendations.

### 4. Optional enforcement hooks (Claude Code)

```
entient-spend install                        # adds 4 hooks to ~/.claude/settings.json
entient-spend install --shadow               # observe-only — logs, never blocks
entient-spend uninstall                      # removes only entient-spend hooks
```

| Hook | Event | Action |
|------|-------|--------|
| `--hook prompt` | UserPromptSubmit | Measures waste factor (current / baseline). Blocks at threshold. |
| `--hook tool` | PostToolUse | Exits on runaway sessions. |
| `--hook compact` | PreCompact | Saves project + git state to `~/.entient-spend/last-session.md`. |
| `--hook start` | SessionStart | Injects saved context if < 48h old. |

---

## All commands

Reconciliation-grade commands are marked **(authoritative)**. Everything else is **(advisory)** — directional pressure-signal only, not invoice truth.

| Command | Surface | What it does |
|---|---|---|
| `entient-spend` | advisory | Interactive dashboard (prompt mix + daily spend + worst sessions) |
| `entient-spend hud` | advisory | Live 2s-refresh HUD — inferences deferred, tokens saved, $ saved (requires ENTIENT Gateway running) |
| `entient-spend --last 30d` | advisory | Plain-text waste report for the window |
| `entient-spend --json` | advisory | Machine-readable report |
| `entient-spend --report` | advisory | Writes a standalone HTML report |
| `entient-spend install` | — | Register 4 hooks in `~/.claude/settings.json` |
| `entient-spend install --shadow` | — | Register hooks in observe-only mode |
| `entient-spend install-autorestart` | — | Set up auto-rotate sessions (Windows) |
| `entient-spend uninstall` | — | Remove entient-spend hooks |
| `entient-spend status` | — | Hook install state + current session waste factor |
| `entient-spend shadow-report` | — | Summary of shadow-mode events |
| `entient-spend doctor` | — | Scan for Claude Code versions with known cache bugs |
| `entient-spend setup` | — | Store Anthropic API key (and optional Admin key) |
| `entient-spend cost-report [--last 30d]` | **authoritative** | Actual billed dollars from Anthropic `/v1/organizations/cost_report` (Admin API). Reconciliation-grade. |
| `entient-spend billing [--last 30d]` | advisory | Token-estimated daily charges from `/v1/usage` (client-side priced) |
| `entient-spend reconcile <export-file>` | advisory | Cross-reference an entient-spend extension export against local metering, token-estimated |
| `entient-spend redundancy [session-file]` | advisory | Walk tool-use blocks, hit the ExecutionGate, report redundant calls |
| `entient-spend gate-stats` | — | JSON dump of ExecutionGate stats |

---

## Configuration

`~/.entient-spend/config.json` (auto-created):

```json
{
  "threshold": 5,
  "saveThreshold": 3,
  "minTurns": 15,
  "baselineTurns": 5,
  "windowTurns": 5,
  "mode": "enforce"
}
```

**Escape hatch:** `ENTIENT_SPEND_SKIP=1` disables blocking for a single session.

---

## Migrating from `claude-audit` or `@entient/gateway`

See [MIGRATION.md](./MIGRATION.md).

---

## License

MIT
