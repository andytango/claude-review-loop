---
name: review-loop
description: Automated code review and swarm remediation — reviews changes, presents findings for human annotation, then dispatches a fixer team to remediate
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

## Phase 3 — Review Team

Create a review team to audit the changes using specialist agents.

**Step 3.1** — Generate a timestamp:

```bash
date +"%Y%m%d-%H%M%S"
```

The report path will be `.review-TIMESTAMP.md` (substitute the actual timestamp).

**Step 3.2** — Create the review team using TeamCreate:

```
team_name: "review-TIMESTAMP"
description: "Code review team for changes between merge base and HEAD"
```

**Step 3.3** — Create review tasks using TaskCreate. Create one task per specialist:

1. **Task: "Code quality review"** — Description: "Review changes from git diff MERGE_BASE for bugs, logic errors, null handling, race conditions, security issues, and adherence to project guidelines. Use Read/Grep/Glob only — no Bash except git commands. Report findings with title, severity, file, line, issue, and suggestion."

2. **Task: "Silent failure analysis"** — Description: "Examine changes from git diff MERGE_BASE for silent failures, empty catch blocks, swallowed errors, missing error propagation, and inadequate error handling. Use Read/Grep/Glob only — no Bash except git commands. Report findings with title, severity, file, line, issue, and suggestion."

3. **Task: "Test coverage analysis"** — Description: "Analyze test coverage for changes in git diff MERGE_BASE. Identify critical untested paths, missing edge case coverage, and gaps in error handling tests. Use Read/Grep/Glob only — no Bash except git commands. Report findings with title, severity, file, line, issue, and suggestion."

4. **Task: "Type design review"** — Description: "Review new or modified types in git diff MERGE_BASE for invariant strength, encapsulation quality, and design issues. Use Read/Grep/Glob only — no Bash except git commands. Report findings with title, severity, file, line, issue, and suggestion."

**Step 3.4** — Spawn 4 reviewer teammates using the Agent tool. Spawn ALL 4 in a single response. For each, use:
- `team_name`: "review-TIMESTAMP"
- `name`: "code-reviewer", "silent-failure-hunter", "test-analyzer", "type-analyzer"
- `subagent_type`: "Explore" (read-only agents — they should not edit files)
- `prompt`: Tell each teammate to check TaskList, claim their task, complete the review, mark the task completed, and send their findings back via SendMessage.

**Step 3.5** — Wait for all 4 teammates to complete their tasks. Messages from teammates are delivered automatically.

**Step 3.6** — Synthesize findings from all teammates. Deduplicate — if multiple specialists found the same issue, merge into one finding. For each unique finding, determine severity (blocking or advisory).

**Step 3.7** — Write the review report to `.review-TIMESTAMP.md` using the template at `${CLAUDE_PLUGIN_ROOT}/templates/review-report.md`. Fill in all findings using the template format. Leave all action checkboxes unchecked.

**Step 3.8** — Shut down the review team:
- Send `shutdown_request` to each teammate via SendMessage
- Call TeamDelete to clean up

**Step 3.9** — Verify the report by reading it with the Read tool. If empty or no findings, tell the user the code looks clean and proceed to **Phase 8**.

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
- Different files → separate parallel streams
- Same file → same stream (sequential)

**Step 5.4** — Enter plan mode using the EnterPlanMode tool. Present the remediation plan:

For each stream:
- Stream ID, files touched
- Findings to address (title, severity, issue)
- Human notes for "modify" findings

Summary: total streams, parallel vs sequential count, overview of changes.

The user reviews and approves before proceeding to Phase 6.

---

## Phase 6 — Fixer Team

Create a fixer team to remediate the approved findings. Do NOT fix findings yourself — always delegate to the team.

**Step 6.1** — Create the fixer team using TeamCreate:

```
team_name: "fix-TIMESTAMP"
description: "Fixer team for remediating approved review findings"
```

**Step 6.2** — Create one task per approved/modified finding using TaskCreate. Each task should include:
- The finding title, file, line, issue, and suggestion
- For "modify" findings: the human's notes on the desired approach
- Instruction: "Make minimal changes — fix only what the finding describes. Do not refactor surrounding code. Respect the human's notes over the reviewer's suggestion. Use Read/Edit/Write/Grep/Glob only — no Bash except git commands."

If multiple findings touch the same file, create a single task containing all findings for that file and note they must be applied sequentially.

**Step 6.3** — Spawn fixer teammates using the Agent tool. Spawn ALL teammates in a single response for maximum parallelism. For each stream (group of findings on independent files), spawn one teammate:
- `team_name`: "fix-TIMESTAMP"
- `name`: "fixer-1", "fixer-2", etc.
- `subagent_type`: "general-purpose" (these agents need to edit files)
- `prompt`: Tell each teammate to check TaskList, claim their task, implement the fix, mark the task completed, and send a summary of changes via SendMessage. Include the tool rules: "ONLY use Bash for git commands. Do NOT use cat, ls, test, head, tail via Bash. Do NOT use 2>/dev/null or shell redirections. Use Read to read files, Glob to find files, Grep to search."

**Step 6.4** — Wait for all fixer teammates to complete. Messages are delivered automatically.

**Step 6.5** — Collect results from teammate messages. Report to the user:
- Which findings were successfully fixed
- Which findings encountered issues
- Which files were modified

**Step 6.6** — Shut down the fixer team:
- Send `shutdown_request` to each teammate via SendMessage
- Call TeamDelete to clean up

**Step 6.7** — Update `.review-state.json`: update latest cycle's `fixedCount` and the `totalFixed`, `totalDeferred`, `totalDismissed` counters. Read then Write.

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
- **Teammate idle**: This is normal — teammates go idle after each turn. Send a message to wake them if needed.
- **Team cleanup**: Always shut down teammates and call TeamDelete before proceeding to the next phase.
