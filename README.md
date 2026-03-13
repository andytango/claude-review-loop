# claude-review-loop

Automated code review and swarm remediation plugin for Claude Code. Spawns adversarial reviewer agents to examine your changes, presents findings interactively for your decision, then dispatches fixer agents to remediate approved issues.

## How it works

1. **Review** — Spawns 4 specialist agents in parallel (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer) to examine all changes on your branch
2. **Triage** — Presents each finding interactively. For each one, you choose: approve, modify, defer, or dismiss
3. **Plan** — Enters plan mode to build a remediation plan for approved findings, grouped by file
4. **Fix** — Dispatches fixer agents to implement the approved fixes, parallelizing across files
5. **Re-audit** — Optionally re-runs the review loop to verify fixes and catch regressions

## Installation

```bash
claude /plugin install claude-review-loop
```

Or install from source:

```bash
claude --plugin-dir /path/to/claude-review-loop
```

## Usage

From any branch with changes relative to `main`/`master`:

```
/review-loop
```

The plugin will detect your changes, run the review, and guide you through the rest interactively.

## Prerequisites

Parallel agent teams must be enabled in your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

## Required permissions

The plugin needs these tool permissions. Add to your `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(date *)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)"
    ]
  }
}
```

## Plugin structure

```
claude-review-loop/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── agents/
│   ├── reviewer.md          # Adversarial reviewer agent (delegates to 4 specialists)
│   └── fixer.md             # Focused remediation agent
├── skills/
│   └── review-loop/
│       └── SKILL.md         # Main orchestrator skill
├── templates/
│   └── review-report.md     # Markdown report template
└── .gitignore
```

## Output files

The plugin creates these files in your project root (all gitignored):

- `.review-TIMESTAMP.md` — Human-readable review report
- `.review-state.json` — Session state tracking cycles, counts, and progress

## License

MIT
