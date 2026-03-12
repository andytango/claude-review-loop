---
name: review
description: Automated code review and swarm remediation — reviews changes, presents findings for human annotation, then dispatches fixer agents
---

# Review Swarm Orchestrator

You are the orchestrator for the review-swarm workflow. Follow these phases step-by-step, in order. Do not skip phases unless explicitly instructed.

---

## Phase 1 — Detect Changes

Determine the default branch and compute the diff against it.

**Step 1.1** — Detect the default branch:

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
```

If that command produces no output, fall back to checking which branch exists:

```bash
git rev-parse --verify origin/main >/dev/null 2>&1 && DEFAULT_BRANCH=main || DEFAULT_BRANCH=master
```

**Step 1.2** — Compute the merge base:

```bash
MERGE_BASE=$(git merge-base HEAD "origin/${DEFAULT_BRANCH}")
```

**Step 1.3** — Run the diff summary:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/diff-summary.js "${MERGE_BASE}"
```

If the diff summary reports 0 files changed, inform the user: **"No changes to review against `<default-branch>`. Nothing to do."** — then **STOP**.

**Step 1.4** — Initialize the review-swarm working directory:

```bash
mkdir -p .review-swarm
node ${CLAUDE_PLUGIN_ROOT}/dist/state.js init .review-swarm
```

Ignore any "already exists" errors from the state init command — this is expected on subsequent runs.

---

## Phase 2 — Check for Existing Annotated Review

Before spawning a new reviewer, check whether a previous review report exists and has been annotated.

**Step 2.1** — Look for the most recent review report:

```bash
ls -t .review-swarm/review-*.md 2>/dev/null | head -1
```

If no report file is found, proceed to **Phase 3**.

**Step 2.2** — Parse the existing report:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/parse-report.js <path-to-report>
```

**Step 2.3** — Evaluate the parsed summary:

- If there are findings with action "approve" or "modify" (approved > 0 or modified > 0): skip directly to **Phase 5** using this report.
- If all findings have no action set (all unannotated): inform the user that the report at `<path>` has not been annotated yet. Remind them to open the file, check one action checkbox per finding, and re-invoke `/review-swarm:review` when done. Then **STOP**.
- If all findings are "defer" or "dismiss" with none approved or modified: inform the user that no findings require remediation and proceed to **Phase 8**.
- Otherwise: proceed to **Phase 3** for a fresh review.

---

## Phase 3 — Spawn Reviewer

Generate a fresh code review report.

**Step 3.1** — Generate a timestamp:

```bash
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
```

This produces a value like `20260312-143052`.

**Step 3.2** — Define the output path:

```
REPORT_PATH=".review-swarm/review-${TIMESTAMP}.md"
```

**Step 3.3** — Spawn the `reviewer` subagent using the Agent tool.

Provide the following context to the subagent:
- The merge base hash: `${MERGE_BASE}`
- The report template path: `${CLAUDE_PLUGIN_ROOT}/templates/review-report.md`
- The output file path: `${REPORT_PATH}`
- Instruction: Review all changes between the merge base and HEAD, write findings to the output file using the template format

Wait for the reviewer subagent to complete before proceeding.

**Step 3.4** — Verify the report was written:

```bash
test -f "${REPORT_PATH}" && echo "Report generated" || echo "ERROR: Report not generated"
```

If the report was not generated, inform the user of the error and **STOP**.

---

## Phase 4 — Present Findings and Wait

Present the review findings to the user and wait for their annotations.

**Step 4.1** — Parse the generated report:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/parse-report.js "${REPORT_PATH}"
```

**Step 4.2** — Present the summary to the user in a readable format:

Display:
- Total number of findings
- Number of blocking findings
- Number of advisory findings
- A brief numbered list of finding titles with their severity, e.g.:
  1. **[blocking]** Missing null check in `parseInput`
  2. **[advisory]** Unused import in `utils.ts`

**Step 4.3** — Determine the current iteration number from any previous cycles in state, then record this cycle:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/state.js add-cycle .review-swarm '{"iteration":N,"timestamp":"TIMESTAMP","reportPath":"REPORT_PATH","findingsCount":X,"blockingCount":Y,"approvedCount":0,"fixedCount":0}'
```

Replace `N`, `TIMESTAMP`, `REPORT_PATH`, `X`, `Y` with actual values.

**Step 4.4** — Instruct the user:

Tell them:
1. Open the review report at the file path `.review-swarm/review-{timestamp}.md`
2. For each finding, check **exactly one** action checkbox:
   - `[x] Approve` — Fix as suggested (or with modifications noted below)
   - `[x] Modify` — Fix with a different approach (describe in "Human notes")
   - `[x] Defer` — Acknowledged but not fixing now
   - `[x] Dismiss` — Disagree, not an issue
3. For "Modify" actions, add notes in the **Human notes** section describing the desired approach
4. When finished annotating, re-invoke `/review-swarm:review`

**STOP HERE.** Do not proceed to Phase 5. The user must annotate the report and re-invoke the skill.

---

## Phase 5 — Parse Annotations and Plan Remediation

The user has annotated the review report. Parse annotations and build a remediation plan.

**Step 5.1** — Parse the annotated report:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/parse-report.js "${REPORT_PATH}"
```

**Step 5.2** — Collect all findings where action is `approve` or `modify`. These are the findings that need remediation.

If no findings need remediation (all deferred or dismissed), inform the user and skip to **Phase 8**.

**Step 5.3** — Feed the approved findings to the parallelism planner:

```bash
echo '<approved-findings-json>' | node ${CLAUDE_PLUGIN_ROOT}/dist/parallelism-planner.js
```

Where `<approved-findings-json>` is the JSON array of findings with action `approve` or `modify`.

**Step 5.4** — Present the parallelism plan to the user:

Display:
- Total number of streams
- Number of parallel streams vs. sequential streams
- For each stream: the stream ID, which files it touches, and the finding titles it will address

Ask the user for confirmation before proceeding to Phase 6. If they decline, **STOP**.

---

## Phase 6 — Dispatch Fixer Agents

Spawn fixer subagents to remediate the approved findings.

**Step 6.1** — For each stream in the parallelism plan, spawn a `fixer` subagent using the Agent tool.

For each subagent, provide:
- The specific findings assigned to this stream (including title, file, line, issue, suggestion)
- Any human annotations from "modify" actions (the notes describing the desired approach)
- The file paths the fixer should modify

For streams where `canParallelize` is `true`, use `isolation: "worktree"` so they work in independent worktrees without conflicting.

For streams where `canParallelize` is `false`, run them sequentially in the main worktree.

**Step 6.2** — Wait for all fixer subagents to complete.

**Step 6.3** — Collect results and report to the user:

Display:
- Which findings were successfully fixed
- Which findings encountered issues during remediation
- Any files that were modified

---

## Phase 7 — Re-audit

After fixes have been applied, offer to run another review cycle.

**Step 7.1** — Inform the user that all dispatched fixes have been applied.

**Step 7.2** — Ask the user if they want to run another review cycle to verify the fixes and catch any regressions.

- If **yes**: return to **Phase 3** with a new timestamp. This creates a fresh review report covering the updated code.
- If **no**: proceed to **Phase 8**.

---

## Phase 8 — Completion

Summarize the entire review session and wrap up.

**Step 8.1** — Get the full state summary:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/state.js summary .review-swarm
```

**Step 8.2** — Present the final summary to the user:

- Total number of review cycles completed
- Total findings across all cycles
- Total findings fixed
- Total findings deferred
- Total findings dismissed

**Step 8.3** — Inform the user that the review-swarm session is complete. The `.review-swarm/` directory contains all review reports and state for reference.

---

## Edge Case Handling

- **No changes detected**: Phase 1 stops early with a clear message.
- **No findings in review**: If the reviewer produces a report with 0 findings, tell the user the code looks clean and proceed to Phase 8.
- **Report already annotated on re-invocation**: Phase 2 detects this and skips directly to Phase 5.
- **All findings deferred or dismissed**: Skip remediation entirely and go to Phase 8.
- **Fixer agent failure**: Report the failure for the specific finding, do not abort the entire session. Continue with other streams.
- **State init "already exists" error**: This is expected on subsequent runs — ignore it silently.
- **Missing `${CLAUDE_PLUGIN_ROOT}`**: If the environment variable is not set, inform the user that the review-swarm plugin is not properly installed and **STOP**.
