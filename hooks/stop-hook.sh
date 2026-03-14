#!/bin/bash

# Review Loop Stop Hook
# Prevents session exit when fixes have been applied but not yet verified.
# Feeds the review prompt back directly (same pattern as ralph-loop).

set -euo pipefail

STATE_FILE=".review-state.json"

# No state file — allow exit
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Check if needsReview flag is set
NEEDS_REVIEW=$(jq -r '.needsReview // false' "$STATE_FILE" 2>/dev/null || echo "false")

if [[ "$NEEDS_REVIEW" != "true" ]]; then
  # No pending review — allow exit
  exit 0
fi

# Read loop state
MERGE_BASE=$(jq -r '.mergeBase // ""' "$STATE_FILE" 2>/dev/null || echo "")
CYCLE_COUNT=$(jq -r '.cycles | length' "$STATE_FILE" 2>/dev/null || echo "0")

if [[ -z "$MERGE_BASE" ]]; then
  echo "⚠️  Review loop: No merge base in state file. Allowing exit." >&2
  exit 0
fi

# Clear the flag BEFORE re-injecting to prevent infinite re-triggers
# if the review itself fails. The skill sets it back to true after the
# next fix cycle.
TEMP_FILE="${STATE_FILE}.tmp.$$"
jq '.needsReview = false' "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# Build the full review prompt — this is what gets fed back to Claude.
# Same pattern as ralph-loop: the reason field IS the prompt.
read -r -d '' PROMPT << 'PROMPT_EOF' || true
You just applied fixes in a review-loop cycle. Those fixes have NOT been verified. You must run a fresh review NOW.

## What to do

Run the review steps below. This is cycle CYCLE_NUMBER.

### Step 1 — Generate a timestamp
Run: date +"%Y%m%d-%H%M%S"

### Step 2 — Get the diff
Run: git diff MERGE_BASE_PLACEHOLDER

### Step 3 — Spawn 4 specialist subagents from the PR Review Toolkit
Spawn ALL 4 in a single response using the Agent tool. Reference each by its plugin-qualified name:

1. pr-review-toolkit:code-reviewer — "Review changes from git diff MERGE_BASE_PLACEHOLDER. Provide one or more numbered suggested fixes per issue."
2. pr-review-toolkit:silent-failure-hunter — "Examine changes from git diff MERGE_BASE_PLACEHOLDER. Provide one or more numbered suggested fixes per issue."
3. pr-review-toolkit:pr-test-analyzer — "Analyze test coverage for git diff MERGE_BASE_PLACEHOLDER. Provide one or more numbered suggested fixes per gap."
4. pr-review-toolkit:type-design-analyzer — "Review types in git diff MERGE_BASE_PLACEHOLDER. Provide one or more numbered suggested fixes per concern."

### Step 4 — Synthesize and write report
Deduplicate findings. Write report to .review-TIMESTAMP.md using the template. Leave all action checkboxes unchecked.

### Step 5 — If zero findings
Tell the user the code is clean. Update .review-state.json to set "needsReview": false. Present final summary and stop.

### Step 6 — If findings exist, triage interactively
Present each finding using AskUserQuestion with:
- header: "Finding N of TOTAL"
- question: "[SEVERITY] TITLE\nFile: PATH:LINE\n\nIssue: DESCRIPTION\n\nWhy this matters: IMPACT"
- preview: Read 5-10 lines of actual source code around the issue
- options: One per suggested fix ("Fix: summary"), plus "Defer" and "Dismiss"

### Step 7 — After triage
- If any approved: Enter plan mode, then create a fixer agent team (TeamCreate), create tasks (TaskCreate), spawn fixer teammates, collect results, shut down team. Then set "needsReview": true in .review-state.json. The stop hook will catch you again if needed.
- If all deferred/dismissed: Set "needsReview": false in .review-state.json. Present final summary and stop.

IMPORTANT: Do NOT use cat, ls, mkdir, or shell utilities. Use Read/Write/Edit/Glob/Grep tools. Do NOT add 2>/dev/null to commands.
PROMPT_EOF

# Substitute the actual values into the prompt
PROMPT="${PROMPT//MERGE_BASE_PLACEHOLDER/$MERGE_BASE}"
PROMPT="${PROMPT//CYCLE_NUMBER/$((CYCLE_COUNT + 1))}"

SYSTEM_MSG="🔄 Review loop cycle $((CYCLE_COUNT + 1)): Fixes from cycle $CYCLE_COUNT need verification. Running fresh review."

# Block exit and feed the full review prompt back
jq -n \
  --arg prompt "$PROMPT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'

exit 0
