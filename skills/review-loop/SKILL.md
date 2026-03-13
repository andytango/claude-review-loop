---
name: review-loop
description: Automated code review and swarm remediation — reviews changes, presents findings for human annotation, then dispatches a fixer team to remediate. Loops until clean.
---

# Review Loop Orchestrator

You are the orchestrator for the review-loop workflow. Follow these phases step-by-step, in order. Do not skip phases unless explicitly instructed.

**THIS IS A LOOP, NOT A LINEAR SEQUENCE.** After every remediation (Phase 6), you MUST loop back to Phase 3 for a fresh review. You are NOT done when fixes are applied. The workflow only terminates when Phase 3 finds zero issues OR the human approves zero fixes in Phase 4. Re-read this paragraph after completing Phase 6.

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
- **Suggestions**: numbered list after `**Suggestions:**`
- **Action checkboxes**: `- [x] Approve (suggestion N)`, `- [x] Defer`, `- [x] Dismiss` (checked) vs `- [ ]` (unchecked)
- **Human notes**: text after `**Human notes:**`

Count findings by action. Determine: approved, deferred, dismissed, unannotated counts.

**Step 2.3** — Evaluate:

- If approved > 0: skip to **Phase 5**.
- If all unannotated: proceed to **Phase 4**.
- If all deferred/dismissed: inform user no remediation needed, proceed to **Phase 7**.
- Otherwise: proceed to **Phase 3**.

---

## Phase 3 — Review (Subagents)

Spawn specialist subagents to audit the changes. Use the Agent tool to fan out 4 read-only reviewers in parallel and collect their findings.

**Step 3.1** — Generate a timestamp:

```bash
date +"%Y%m%d-%H%M%S"
```

The report path will be `.review-TIMESTAMP.md` (substitute the actual timestamp).

**Step 3.2** — Get the full diff for context:

```bash
git diff MERGE_BASE_HASH_HERE
```

Remember this diff output — you will include relevant portions in each specialist's prompt.

**Step 3.3** — Spawn 4 specialist subagents using the Agent tool. Spawn ALL 4 in a single response for maximum parallelism. For each, use:
- `subagent_type`: `"Explore"` (read-only agents — they should not edit files)
- `description`: short label for the specialist

Each specialist's prompt must include:
- The merge base hash
- The list of changed files (from the diff stat)
- The tool rules: "ONLY use Bash for git commands. Do NOT use cat, ls, test, head, tail via Bash. Do NOT use 2>/dev/null or shell redirections. Use Read to read files, Glob to find files, Grep to search."
- Instruction to return findings as a structured list with: title, severity (blocking/advisory), file, line, issue, and **one or more suggested fixes** (numbered). When multiple valid approaches exist, list them as alternatives so the user can choose.

The 4 specialists:

1. **"code-quality-review"** — "Review changes from git diff MERGE_BASE for bugs, logic errors, null handling, race conditions, security issues, and adherence to project guidelines. For each issue found, report: title, severity (blocking or advisory), file path, line number, issue description, and one or more numbered suggested fixes. If there are multiple reasonable approaches, list each as a separate numbered suggestion."

2. **"silent-failure-analysis"** — "Examine changes from git diff MERGE_BASE for silent failures, empty catch blocks, swallowed errors, missing error propagation, and inadequate error handling. For each issue found, report: title, severity (blocking or advisory), file path, line number, issue description, and one or more numbered suggested fixes. If there are multiple reasonable approaches, list each as a separate numbered suggestion."

3. **"test-coverage-analysis"** — "Analyze test coverage for changes in git diff MERGE_BASE. Identify critical untested paths, missing edge case coverage, and gaps in error handling tests. For each issue found, report: title, severity (blocking or advisory), file path, line number, issue description, and one or more numbered suggested fixes. If there are multiple reasonable approaches, list each as a separate numbered suggestion."

4. **"type-design-review"** — "Review new or modified types in git diff MERGE_BASE for invariant strength, encapsulation quality, and design issues. For each issue found, report: title, severity (blocking or advisory), file path, line number, issue description, and one or more numbered suggested fixes. If there are multiple reasonable approaches, list each as a separate numbered suggestion."

**Step 3.4** — Collect results from all 4 subagents. Each returns its findings directly.

**Step 3.5** — Synthesize findings from all subagents. Deduplicate — if multiple specialists found the same issue, merge into one finding (combine their suggestions into a numbered list of alternatives). For each unique finding, determine severity (blocking or advisory). Preserve all distinct suggested fixes — do not collapse alternatives into one.

**Step 3.6** — Write the review report to `.review-TIMESTAMP.md` using the template at `${CLAUDE_PLUGIN_ROOT}/templates/review-report.md`. Fill in all findings using the template format. For the **Suggestions** field, list each alternative fix as a numbered item. If a finding has only one suggestion, list just that one. Leave all action checkboxes unchecked.

**Step 3.7** — Verify the report by reading it with the Read tool. If empty or no findings, tell the user the code looks clean and proceed to **Phase 7**.

---

## Phase 4 — Interactive Finding Review

Present each finding to the user interactively using the AskUserQuestion tool. Do NOT ask the user to edit a Markdown file.

**Step 4.1** — Read the generated report using the Read tool. Parse findings as described in Step 2.2.

**Step 4.2** — Display overview: total findings, blocking count, advisory count. Then say: "Let's walk through each finding. I'll ask for your decision on each one."

**Step 4.3** — For each finding, collect the user's decision using the AskUserQuestion tool.

Process findings in batches of up to 4. Build the options dynamically based on the finding's suggestions:

- **header**: `"Finding N of TOTAL"`
- **question**: Build a rich context block:
  ```
  [SEVERITY] TITLE
  File: PATH:LINE

  Issue: ISSUE_DESCRIPTION (full description, not just a summary)

  Why this matters: BRIEF_EXPLANATION (1 sentence on the impact — e.g., "This could cause a runtime error when the response is empty" or "Callers will silently get stale data")
  ```
- **preview**: Use the Read tool to read the relevant lines from the source file BEFORE presenting the question. Include approximately 5-10 lines of surrounding context centred on the issue location. Show the actual code, not a paraphrase.
- **options**: Build this list dynamically:
  - For each numbered suggestion in the finding, add an option:
    - label: `"Fix: {short summary of suggestion}"`, description: `"{full suggestion text with enough detail that the user can evaluate it without reading the report}"`
  - Then always append these two:
    - label: `"Defer"`, description: `"Acknowledged but not fixing now"`
    - label: `"Dismiss"`, description: `"Disagree — not an issue"`
- The AskUserQuestion tool also allows free-text input via "Other". If the user types a custom response, treat it as a custom fix instruction.

Example: if a finding has 2 suggestions, the question and options would look like:

Question:
```
[blocking] Null dereference on API response
File: src/api/client.ts:42

Issue: The response object is accessed without checking for null. When the
API returns a 204 No Content, `response.data` will be undefined and the
subsequent `.map()` call will throw a TypeError.

Why this matters: This will crash the request handler for any endpoint that
returns an empty response.
```

Preview: (actual source lines 38-46 of src/api/client.ts)

Options:
1. "Fix: Add null check before access" — "Add `if (response.data != null)` guard before the `.map()` call on line 42. Return an empty array when data is null."
2. "Fix: Use optional chaining with fallback" — "Replace `response.data.map(...)` with `(response.data ?? []).map(...)` on line 42."
3. "Defer" — "Acknowledged but not fixing now"
4. "Dismiss" — "Disagree — not an issue"

**Step 4.4** — Update the review Markdown file using the Edit tool based on the user's choice:
- If user chose a fix suggestion: `- [ ] Approve (suggestion N)` → `- [x] Approve (suggestion N)` where N is the suggestion number they chose. Add the chosen suggestion text under `**Human notes**:` for clarity.
- If user typed a custom response (Other): `- [ ] Approve (suggestion 1)` → `- [x] Approve (suggestion 1)` and write the user's custom instruction under `**Human notes**:`
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
- If any approved: proceed to **Phase 5**.
- If all deferred or dismissed: proceed to **Phase 7**.

---

## Phase 5 — Plan Remediation

Build a remediation plan and get user approval via plan mode. The plan MUST specify that fixes will be dispatched to an agent team.

**Step 5.1** — Read the annotated report with the Read tool. Parse findings as in Step 2.2.

**Step 5.2** — Collect findings where action is `approve`. If none, skip to **Phase 7**.

**Step 5.3** — Group findings into parallel streams by file path:
- Different files → separate parallel streams
- Same file → same stream (sequential)

**Step 5.4** — Enter plan mode using the EnterPlanMode tool. Present the remediation plan:

For each stream:
- Stream ID, files touched
- Findings to address (title, severity, issue)
- Human notes (custom instructions or chosen suggestion number)

Summary: total streams, parallel vs sequential count, overview of changes.

State explicitly: **"These fixes will be dispatched to an agent team. Each stream will be assigned to a fixer teammate that runs in parallel."**

The user reviews and approves before proceeding to Phase 6.

---

## Phase 6 — Fixer Team

Create an agent team to remediate the approved findings. Do NOT fix findings yourself — always delegate to the team.

**Step 6.1** — Create the fixer team using TeamCreate:

```
team_name: "fix-TIMESTAMP"
description: "Fixer team for remediating approved review findings"
```

**Step 6.2** — Create one task per stream using TaskCreate. Each task should include:
- The finding title, file, line, issue, and the specific suggestion the user chose (by number or custom instruction from human notes)
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

**Step 6.8 — MANDATORY LOOP-BACK.** You are NOT done. The fixes must be verified. Inform the user: **"Fixes applied. Running a fresh review to verify fixes and catch regressions."** Then return to **Phase 3** immediately with a new timestamp. Do NOT proceed to Phase 7 (Completion). Do NOT ask the user whether to continue. Do NOT summarize or present a final message. Go directly back to Phase 3 Step 3.1 right now.

---

## Phase 7 — Completion

**Step 7.1** — Read `.review-state.json`. Compute totals from the state data.

**Step 7.2** — Present final summary: cycles completed, total findings, fixed, deferred, dismissed.

**Step 7.3** — Inform the user the session is complete.

---

## Edge Case Handling

- **No changes detected**: Phase 1 stops early.
- **No findings**: Tell user code looks clean, proceed to Phase 7.
- **Already annotated report**: Phase 2 skips to Phase 5.
- **All deferred/dismissed**: Skip remediation, go to Phase 7.
- **Fixer failure**: Report failure for that finding, continue other streams.
- **State file missing/corrupt**: Re-create with empty defaults.
- **Teammate idle**: This is normal — teammates go idle after each turn. Send a message to wake them if needed.
- **Team cleanup**: Always shut down teammates and call TeamDelete before proceeding to the next phase.
