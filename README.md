# claude-audit

**Claude Code session enforcer + waste analyzer.**

Blocks sessions that are burning quota on bloated context. Saves your session state before compaction. Injects it back when you resume. Tells you where your subscription actually went.

```
npm install -g claude-audit
claude-audit install
```

---

## What it does

### 1. Enforcement hooks (automatic, after `install`)

| Hook | Event | Action |
|------|-------|--------|
| `--hook prompt` | UserPromptSubmit | Measures waste factor (current tokens / baseline). Blocks if ≥ 10x. |
| `--hook tool` | PostToolUse | Exits with code 2 to stop autonomous work on runaway sessions. |
| `--hook compact` | PreCompact | Saves project + git state + file list to `~/.claude-audit/last-session.md`. |
| `--hook start` | SessionStart | Injects saved context if < 48 hours old — continues where you left off. |

### 2. Waste report (no hooks needed)

```
claude-audit             # last 7 days
claude-audit --last 30d
claude-audit --json      # machine-readable
```

Shows:
- Per-session token counts and waste factors
- Complexity tier breakdown (simple / medium / complex)
- Model recommendations (when you ran Sonnet on a two-line task)
- Sessions that needed compaction

---

## Install

```bash
npm install -g claude-audit
claude-audit install    # adds 4 hooks to ~/.claude/settings.json
claude-audit status     # verify installation
```

**Safe with existing hooks** — `install` appends to your hook list without overwriting ENTIENT, clauditor, or any other hooks you have.

```bash
claude-audit uninstall  # removes only claude-audit hooks
```

---

## Configuration

`~/.claude-audit/config.json` (auto-created):

```json
{
  "threshold": 10,
  "minTurns": 20,
  "baselineTurns": 5,
  "windowTurns": 5
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `threshold` | `10` | Waste factor that triggers block (current avg / baseline avg) |
| `minTurns` | `20` | Minimum turns before enforcement kicks in |
| `baselineTurns` | `5` | Turns used to establish baseline token cost |
| `windowTurns` | `5` | Recent turns used to compute current token cost |

**Escape hatch:** `CLAUDE_AUDIT_SKIP=1` disables blocking for a single session.

---

## How waste factor works

Waste factor = average tokens/turn in the last N turns ÷ average tokens/turn in the first N turns.

A session starts lean (low baseline). As context bloats, each turn costs more tokens just to carry the history. A factor of 10x means your current turns cost 10x what they did at the start — most of that is dead context.

---

## Context preservation

Before Claude compacts your session, `claude-audit` saves:

```markdown
# Session Context — 2026-04-04T12:00:00Z
Project: C:\Users\Brock1\Desktop\Agent
Branch: master (abc1234)

## Modified files
- src/main.py
- README.md

## Session waste
Turns: 47 | Baseline: 1,200 tok/turn | Current: 4,800 tok/turn | Factor: 4.0x
```

On the next session start, this is injected as `additionalContext` — Claude resumes with full awareness of what was happening.

---

## Works alongside ENTIENT

If you use [ENTIENT](https://entient.ai) for operator deflection and spend accountability, `claude-audit install` coexists safely — both hook sets fire in sequence.

---

## License

MIT
