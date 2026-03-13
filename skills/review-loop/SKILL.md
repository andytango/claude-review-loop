---
name: review-loop
description: Automated code review and swarm remediation — reviews changes, presents findings for human annotation, then dispatches fixer agents
---

# Review Loop Orchestrator

You are the orchestrator for the review-loop workflow. Follow these phases step-by-step, in order. Do not skip phases unless explicitly instructed.

IMPORTANT RULES:
- Do NOT use shell command substitution `$(...)` or backtick substitution in bash commands. Read output, note the value, pass it as a literal string in subsequent commands.
- Only use the Bash tool for git commands and `date`. For everything else, use the dedicated tools: Read, Write, Edit, Glob.
- Do NOT use `cat`, `ls`, `test`, `mkdir`, or any other shell utility — use Read/Write/Glob instead.
- Do NOT append shell redirections like `2>/dev/null` to commands. If a command fails, handle the error from the output.

---

## Phase 1 — Detect Changes

Determine the default branch and compute the diff against it.

**Step 1.1** — Detect the default branch:

```bash
git symbolic-ref refs/remotes/origin/HEAD
```

If it produces output like `refs/remotes/origin/main`, the default branch is `main`. If it errors, try:

```bash
git rev-parse --verify origin/main
```

If that succeeds, the default branch is `main`. Otherwise, the default branch is `master`. Remember this value.

**Step 1.2** — Compute the merge base (substitute the actual default branch name):

```bash
git merge-base HEAD origin/main
```

Remember the output commit hash as the "merge base".

**Step 1.3** — Get the diff summary (substitute the actual merge base hash):

```bash
git diff --stat MERGE_BASE_HASH_HERE
```

If the output is empty, inform the user: **"No changes to review. Nothing to do."** — then **STOP**.

**Step 1.4** — Initialize or load the state file. Use the Read tool to read `.review-state.json`. If it does not exist (Read returns an error), use the Write tool to create it with:

```json
{
  "cycles": [],
  "totalFixed": 0,
  "totalDeferred": 0,
  "totalDismissed": 0
}
```

If it already exists, remember the current state.

---

## Phase 2 — Check for Existing Annotated Review

Before spawning a new reviewer, check whether a previous review report exists and has been annotated.

**Step 2.1** — Use the Glob tool with pattern `.review-*.md` to find existing review reports. If none found, proceed to **Phase 3**.

**Step 2.2** — Read the most recent report (by filename timestamp) using the Read tool. Parse the Markdown content to extract findings. Each finding is a `### Finding N: {title}` section containing:

- **Severity**: `**Severity:** blocking` or `**Severity:** advisory`
- **File**: `**File:** path/to/file:line`
- **Issue**: text after `**Issue:**`
- **Suggestion**: text after `**Suggestion:**`
- **Action checkboxes**: `- [x] Approve`, `- [x] Modify`, `- [x] Defer`, `- [x] Dismiss` (checked) vs `- [ ]` (unchecked)
- **Human notes**: text after `**Human notes:**`

Count findings by action. Determine: approved, modified, deferred, dismissed, unannotated counts.

**Step 2.3** — Evaluate:

- If approved > 0 or modified > 0: skip to **Phase 5**.
- If all unannotated: proceed to **Phase 4**.
- If all deferred/dismissed: inform user no remediation needed, proceed to **Phase 8**.
- Otherwise: proceed to **Phase 3**.

---

## Phase 3 — Spawn Reviewer

Generate a fresh code review report.

**Step 3.1** — Generate a timestamp:

```bash
date +"%Y%m%d-%H%M%S"
```

The report path will be `.review-TIMESTAMP.md` (substitute the actual timestamp).

**Step 3.2** — Spawn the `reviewer` subagent using the Agent tool.

Provide the following context:
- The merge base hash from Step 1.2
- The report template path: `${CLAUDE_PLUGIN_ROOT}/templates/review-report.md`
- The output file path: `.review-TIMESTAMP.md` (actual timestamp)
- Instruction: Review all changes between the merge base and HEAD, write findings to the output file using the template format

Wait for the reviewer subagent to complete.

**Step 3.3** — Verify the report was written by reading it with the Read tool. If not generated, inform the user and **STOP**.

---

## Phase 4 — Interactive Finding Review

Present each finding to the user interactively using the AskUserQuestion tool. Do NOT ask the user to edit a Markdown file.

**Step 4.1** — Read the generated report using the Read tool. Parse findings as described in Step 2.2.

**Step 4.2** — Display overview: total findings, blocking count, advisory count. Then say: "Let's walk through each finding. I'll ask for your decision on each one."

**Step 4.3** — For each finding, collect the user's decision using the AskUserQuestion tool.

Process findings in batches of up to 4. For each finding:

- **header**: `"Finding N"`
- **question**: `"[SEVERITY] TITLE\nFile: PATH:LINE\n\nIssue: ISSUE_SUMMARY\nSuggestion: SUGGESTION_SUMMARY\n\nWhat action should be taken?"`
- **options**:
  1. label: `"Approve"`, description: `"Fix as suggested by the reviewer"`
  2. label: `"Modify"`, description: `"Fix with a different approach (you'll provide notes)"`
  3. label: `"Defer"`, description: `"Acknowledged but not fixing now"`
  4. label: `"Dismiss"`, description: `"Disagree — not an issue"`

Use the `preview` field to show relevant code context and the reviewer's suggested fix.

If the user selected "Modify", use a follow-up AskUserQuestion to collect modification notes. If the user selects "Other", treat the free-text as modification notes.

**Step 4.4** — Update the review Markdown file using the Edit tool, checking the appropriate action checkbox for each finding:
- "Approve": `- [ ] Approve` → `- [x] Approve`
- "Modify": `- [ ] Modify` → `- [x] Modify` and add notes under `**Human notes**:`
- "Defer": `- [ ] Defer` → `- [x] Defer`
- "Dismiss": `- [ ] Dismiss` → `- [x] Dismiss`

**Step 4.5** — Update `.review-state.json`. Read it with the Read tool, add a new cycle to the `cycles` array:

```json
{
  "iteration": CYCLE_NUMBER,
  "timestamp": "ACTUAL_TIMESTAMP",
  "reportPath": ".review-ACTUAL_TIMESTAMP.md",
  "findingsCount": TOTAL_FINDINGS,
  "blockingCount": BLOCKING_COUNT,
  "approvedCount": APPROVED_COUNT,
  "fixedCount": 0
}
```

Write back with the Write tool.

**Step 4.6** — Present a decision summary table, then:
- If any approved or modified: proceed to **Phase 5**.
- If all deferred or dismissed: proceed to **Phase 8**.

---

## Phase 5 — Plan Remediation

Build a remediation plan and get user approval via plan mode.

**Step 5.1** — Read the annotated report with the Read tool. Parse findings as in Step 2.2.

**Step 5.2** — Collect findings where action is `approve` or `modify`. If none, skip to **Phase 8**.

**Step 5.3** — Group findings into parallel streams by file path:
- Different files → separate parallel streams (`canParallelize: true`)
- Same file → same stream (sequential)

**Step 5.4** — Enter plan mode using the EnterPlanMode tool. Present the remediation plan:

For each stream:
- Stream ID, files touched
- Findings to address (title, severity, issue)
- Human notes for "modify" findings
- Whether it runs in a worktree

Summary: total streams, parallel vs sequential count, overview of changes.

The user reviews and approves before proceeding to Phase 6.

---

## Phase 6 — Dispatch Fixer Agents

**Step 6.1** — For each stream, spawn a `fixer` subagent via the Agent tool with:
- Findings assigned (title, file, line, issue, suggestion)
- Human annotations for "modify" actions
- File paths to modify

Use `isolation: "worktree"` for parallelizable streams. Run non-parallelizable streams sequentially.

**Step 6.2** — Wait for all fixers to complete.

**Step 6.3** — Report results: which findings were fixed, which had issues, which files changed.

**Step 6.4** — Update `.review-state.json`: update latest cycle's `fixedCount` and the `totalFixed`, `totalDeferred`, `totalDismissed` counters. Read then Write.

---

## Phase 7 — Re-audit

**Step 7.1** — Inform the user all fixes have been applied.

**Step 7.2** — Ask if they want another review cycle.
- **Yes**: return to **Phase 3** with a new timestamp.
- **No**: proceed to **Phase 8**.

---

## Phase 8 — Completion

**Step 8.1** — Read `.review-state.json`. Compute totals from the state data.

**Step 8.2** — Present final summary: cycles completed, total findings, fixed, deferred, dismissed.

**Step 8.3** — Inform the user the session is complete.

---

## Edge Case Handling

- **No changes detected**: Phase 1 stops early.
- **No findings**: Tell user code looks clean, proceed to Phase 8.
- **Already annotated report**: Phase 2 skips to Phase 5.
- **All deferred/dismissed**: Skip remediation, go to Phase 8.
- **Fixer failure**: Report failure for that finding, continue other streams.
- **State file missing/corrupt**: Re-create with empty defaults.
