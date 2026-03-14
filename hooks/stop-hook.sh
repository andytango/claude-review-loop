#!/bin/bash

# Review Loop Stop Hook
# Prevents session exit when fixes have been applied but not yet verified
# by a fresh review cycle. Reads .review-state.json for the "needsReview" flag.

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

# Fixes were applied but not yet verified. Block exit and re-trigger review.

# Read the merge base from state (saved during setup)
MERGE_BASE=$(jq -r '.mergeBase // ""' "$STATE_FILE" 2>/dev/null || echo "")
CYCLE_COUNT=$(jq -r '.cycles | length' "$STATE_FILE" 2>/dev/null || echo "0")

# Clear the flag so the next review cycle can set it again after fixing
# (prevents infinite re-triggers if the review itself fails)
TEMP_FILE="${STATE_FILE}.tmp.$$"
jq '.needsReview = false' "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# Build the prompt to re-inject
PROMPT="Fixes were applied in cycle $CYCLE_COUNT but have NOT been verified yet. You MUST run a fresh review now.

Run /review-loop to start the verification review. The merge base is: $MERGE_BASE

Do NOT skip this. Do NOT present a summary. Start the review immediately."

SYSTEM_MSG="🔄 Review loop: Fixes applied in cycle $CYCLE_COUNT need verification. Re-running review."

# Block exit and feed prompt back
jq -n \
  --arg prompt "$PROMPT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'

exit 0
