# claude-audit

Find out where your Claude Code quota actually went.

```
npx claude-audit
```

No install required. Reads your local `~/.claude/` files. Nothing leaves your machine.

---

## What it shows

**Waste report** — which sessions burned quota and why:
- How many of your prompts were simple enough for Haiku but ran on Sonnet
- Which sessions turned into confirmation loops ("ok", "proceed", "go ahead") that re-sent your entire history on every turn
- Sessions where context grew so large each turn cost 10-20x more than it should
- Per-session recommendation: which model to start on, which turn to escalate

**Doctor check** — scans for known issues:
```
npx claude-audit doctor
```
Detects if your sessions ran on Claude Code versions 2.1.69–2.1.89, which had a broken prompt cache causing 10-20x token burn. Shows how many sessions were affected and roughly how many tokens were consumed under the bug.

---

## Commands

| Command | What it does |
|---|---|
| `claude-audit` | Waste report (last 7 days) |
| `claude-audit --last 30d` | Extend the window |
| `claude-audit doctor` | Scan for cache bugs and version issues |
| `claude-audit install` | Register enforcement hooks — blocks sessions when waste gets too high |
| `claude-audit uninstall` | Remove hooks |
| `claude-audit status` | Show hook status and current session waste factor |

---

## Enforcement (optional)

```
claude-audit install
```

Registers hooks into Claude Code. When a session hits 10x waste (configurable), it blocks before burning more tokens, saves your context, and injects it into your next session automatically.

Set `CLAUDE_AUDIT_SKIP=1` to bypass for a session.

Config at `~/.claude-audit/config.json`:
```json
{
  "threshold": 10,
  "minTurns": 20
}
```

---

## Requirements

Node.js 16+. Works with Claude Code CLI, VS Code extension, JetBrains extension.

---

## Want automatic enforcement?

**[entient.ai](https://entient.ai)** — routes each prompt to the right model automatically, and deflects repeated patterns entirely. No manual switching, no session rotation needed.

---

MIT License. Not affiliated with Anthropic.
