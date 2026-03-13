# claude-review-loop

Automated code review and swarm remediation plugin for Claude Code. Uses [agent teams](https://docs.anthropic.com/en/docs/claude-code) to spawn adversarial reviewer specialists, present findings interactively for your decision, then dispatch fixer agents to remediate approved issues.

## How it works

1. **Review** — Creates a review team with 4 specialist teammates running in parallel: code quality, silent failure analysis, test coverage, and type design review
2. **Triage** — Presents each finding interactively. For each one, you choose: approve, modify, defer, or dismiss
3. **Plan** — Enters plan mode to build a remediation plan for approved findings, grouped by file
4. **Fix** — Creates a fixer team to remediate approved findings in parallel across files
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

Agent teams must be enabled in your Claude Code settings (`~/.claude/settings.json`):

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
├── skills/
│   └── review-loop/
│       └── SKILL.md         # Main orchestrator skill
├── templates/
│   └── review-report.md     # Markdown report template
└── .gitignore
```

The orchestrator skill (SKILL.md) manages the entire workflow: creating teams, assigning tasks, spawning teammates, collecting results, and cleaning up. All specialist prompts and fixer instructions are defined inline.

## Output files

The plugin creates these files in your project root (all gitignored):

- `.review-TIMESTAMP.md` — Human-readable review report with findings and action checkboxes
- `.review-state.json` — Session state tracking cycles, counts, and progress

## License

MIT
