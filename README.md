# claude-review-loop

Automated code review and swarm remediation plugin for Claude Code. Spawns adversarial reviewer subagents, presents findings interactively with selectable fix options, then dispatches an [agent team](https://docs.anthropic.com/en/docs/claude-code) to remediate approved issues. Loops until clean.

## How it works

1. **Review** — Spawns 4 specialist agents from the [PR Review Toolkit](https://github.com/anthropics/claude-code-plugins) in parallel (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer) to examine your branch diff with fresh eyes
2. **Triage** — Presents each finding interactively with the reviewer's suggested fixes as selectable options. Pick a fix, defer, dismiss, or type your own approach
3. **Plan** — Enters plan mode to build a remediation plan, explicitly dispatching to an agent team
4. **Fix** — Creates a fixer agent team to remediate approved findings in parallel across files
5. **Loop** — Automatically re-runs the review to verify fixes and catch regressions. Repeats until the review finds zero issues or you defer/dismiss everything

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

1. **PR Review Toolkit** plugin must be installed (provides the specialist review agents):

```bash
claude /plugin install pr-review-toolkit
```

2. Agent teams must be enabled in your Claude Code settings (`~/.claude/settings.json`):

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
├── hooks/
│   ├── hooks.json           # Stop hook registration
│   └── stop-hook.sh         # Enforces loop after fixes
├── skills/
│   └── review-loop/
│       └── SKILL.md         # Main orchestrator skill
├── templates/
│   └── review-report.md     # Markdown report template
└── .gitignore
```

The orchestrator uses a hybrid approach: **PR Review Toolkit agents** for review (with confidence scoring and structured output) and **agent teams** for fixes (coordinated parallel writes with task tracking). A stop hook enforces the loop — if the agent tries to exit after fixes, the hook blocks and re-injects the review prompt.

## Output files

The plugin creates these files in your project root (all gitignored):

- `.review-TIMESTAMP.md` — Human-readable review report with findings and action checkboxes
- `.review-state.json` — Session state tracking cycles, counts, and progress

## License

MIT
