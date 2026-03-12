import { execFile } from 'node:child_process';
import { ResultAsync, ok } from 'neverthrow';
import type { DiffSummary } from './types.js';

/** Discriminated union for diff computation errors */
export type DiffError =
  | { reason: 'no_git_repo'; message: string }
  | { reason: 'invalid_merge_base'; message: string }
  | { reason: 'git_error'; message: string };

/**
 * Parses the summary line from `git diff --stat` output.
 *
 * The summary line has the format:
 *   " N files changed, M insertions(+), P deletions(-)"
 * Some parts may be absent (e.g., no deletions if there are only additions).
 * An empty diff produces no summary line at all.
 *
 * @param output - The full stdout from `git diff --stat`
 * @returns A DiffSummary with parsed counts
 */
/**
 * Extracts a numeric value from a regex match's first capture group.
 * Returns 0 if there is no match.
 *
 * @param text - The text to match against
 * @param pattern - The regex pattern with a numeric capture group
 * @returns The parsed integer, or 0 if no match
 */
function extractCount(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  if (match === null) {
    return 0;
  }
  const captured = match[1];
  /* v8 ignore next -- capture group always exists when regex matches */
  return captured !== undefined ? parseInt(captured, 10) : 0;
}

function parseDiffStat(output: string): DiffSummary {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }

  const lines = trimmed.split('\n');
  /* v8 ignore next -- split always returns at least one element */
  const summaryLine = lines[lines.length - 1] ?? '';

  const filesChanged = extractCount(summaryLine, /(\d+)\s+files?\s+changed/);
  const insertions = extractCount(summaryLine, /(\d+)\s+insertions?\(\+\)/);
  const deletions = extractCount(summaryLine, /(\d+)\s+deletions?\(-\)/);

  return { filesChanged, insertions, deletions };
}

/**
 * Wraps `child_process.execFile` in a Promise that resolves with stdout/stderr.
 *
 * @param command - The command to execute
 * @param args - Arguments to pass to the command
 * @returns A promise resolving to { stdout, stderr }
 */
function execFilePromise(
  command: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Classifies a git error into a specific DiffError variant based on the
 * error message and stderr output.
 *
 * @param error - The error thrown by execFile
 * @returns A typed DiffError
 */
function classifyGitError(error: unknown): DiffError {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('not a git repository')) {
    return { reason: 'no_git_repo', message };
  }

  if (
    lowerMessage.includes('unknown revision') ||
    lowerMessage.includes('bad revision') ||
    lowerMessage.includes('invalid object')
  ) {
    return { reason: 'invalid_merge_base', message };
  }

  return { reason: 'git_error', message };
}

/**
 * Computes a diff summary by running `git diff --stat` against the given merge base.
 *
 * @param mergeBase - The merge base commit reference to diff against
 * @returns A ResultAsync containing either a DiffSummary or a DiffError
 *
 * @example
 * ```typescript
 * const result = await computeDiffSummary('main');
 * result.match(
 *   (summary) => console.log(summary),
 *   (error) => console.error(error.reason, error.message),
 * );
 * ```
 */
export function computeDiffSummary(mergeBase: string): ResultAsync<DiffSummary, DiffError> {
  return ResultAsync.fromPromise(
    execFilePromise('git', ['diff', '--stat', mergeBase]),
    classifyGitError,
  ).andThen((result) => {
    const summary = parseDiffStat(result.stdout);
    return ok(summary);
  });
}

/**
 * CLI entry point. When this module is run directly, it reads the merge base
 * from `process.argv[2]` (defaulting to "main"), computes the diff summary,
 * and outputs JSON to stdout.
 */
export async function main(): Promise<void> {
  const mergeBase = process.argv[2] ?? 'main';
  const result = await computeDiffSummary(mergeBase);

  result.match(
    (summary) => {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    },
    (error) => {
      process.stderr.write(JSON.stringify({ error: error.reason, message: error.message }) + '\n');
      process.exitCode = 1;
    },
  );
}

/**
 * Detects whether this module is being run as a CLI entry point.
 *
 * @param metaUrl - The import.meta.url of this module
 * @param argv1 - The process.argv[1] value (script path)
 * @returns True if the module is being executed directly
 */
export function isDirectRun(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  const normalizedArgv = argv1.replace(/\\/g, '/');
  return metaUrl.endsWith(normalizedArgv);
}

/* v8 ignore next 3 -- CLI bootstrap, tested via isDirectRun + main separately */
if (isDirectRun(import.meta.url, process.argv[1])) {
  void main();
}
