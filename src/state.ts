import * as fs from 'fs/promises';
import * as path from 'path';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';
import type { ReviewCycle, ReviewState } from './types.js';
import { ReviewStateSchema } from './types.js';

/** Discriminated union of errors that can occur during state operations */
export type StateError =
  | { reason: 'file_not_found'; path: string }
  | { reason: 'invalid_state'; message: string }
  | { reason: 'io_error'; message: string }
  | { reason: 'already_exists'; path: string };

const STATE_FILE = 'state.json';

/**
 * Returns the full path to the state.json file within the given directory
 * @param dir - Directory containing the state file
 * @returns Absolute path to state.json
 */
function statePath(dir: string): string {
  return path.join(dir, STATE_FILE);
}

/**
 * Creates an empty ReviewState
 * @returns A fresh ReviewState with no cycles and zeroed counters
 */
function emptyState(): ReviewState {
  return {
    cycles: [],
    totalFixed: 0,
    totalDeferred: 0,
    totalDismissed: 0,
  };
}

/**
 * Reads and validates a state.json file from the given directory
 * @param filePath - Full path to the state.json file
 * @returns The parsed and validated ReviewState, or a StateError
 */
function readStateFile(filePath: string): ResultAsync<ReviewState, StateError> {
  return ResultAsync.fromPromise(
    fs.readFile(filePath, 'utf-8'),
    (e): StateError => {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { reason: 'file_not_found', path: filePath };
      }
      return { reason: 'io_error', message: String(err.message) };
    },
  ).andThen((content) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return errAsync<ReviewState, StateError>({
        reason: 'invalid_state',
        message: `Failed to parse JSON in ${filePath}`,
      });
    }

    const result = ReviewStateSchema.safeParse(parsed);
    if (!result.success) {
      return errAsync<ReviewState, StateError>({
        reason: 'invalid_state',
        message: `Zod validation failed: ${result.error.message}`,
      });
    }

    return okAsync(result.data);
  });
}

/**
 * Writes a ReviewState to state.json in the given directory
 * @param filePath - Full path to the state.json file
 * @param state - The ReviewState to persist
 * @returns The written ReviewState, or a StateError
 */
function writeStateFile(
  filePath: string,
  state: ReviewState,
): ResultAsync<ReviewState, StateError> {
  return ResultAsync.fromPromise(
    fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8'),
    (e): StateError => ({
      reason: 'io_error',
      message: String((e as Error).message),
    }),
  ).map(() => state);
}

/**
 * Initializes a new state.json file with an empty ReviewState.
 * Fails if the file already exists.
 * @param dir - Directory where state.json will be created
 * @returns The newly created empty ReviewState, or a StateError
 * @example
 * const result = await initState('/tmp/review');
 * // result.isOk() => true, result.value => { cycles: [], totalFixed: 0, ... }
 */
export function initState(
  dir: string,
): ResultAsync<ReviewState, StateError> {
  const fp = statePath(dir);

  return ResultAsync.fromPromise(
    fs.access(fp).then(
      () => true,
      () => false,
    ),
    /* c8 ignore next */
    (): StateError => ({ reason: 'io_error', message: 'Unexpected error checking file existence' }),
  ).andThen((exists) => {
    if (exists) {
      return errAsync<ReviewState, StateError>({
        reason: 'already_exists',
        path: fp,
      });
    }
    return writeStateFile(fp, emptyState());
  });
}

/**
 * Reads the current state, appends a new review cycle, updates counters,
 * writes the updated state back, and returns it.
 * @param dir - Directory containing state.json
 * @param cycle - The ReviewCycle to append
 * @returns The updated ReviewState after adding the cycle, or a StateError
 * @example
 * const cycle = { iteration: 1, timestamp: '2026-01-01', reportPath: 'report.json', findingsCount: 5, blockingCount: 2, approvedCount: 1, fixedCount: 2 };
 * const result = await addCycle('/tmp/review', cycle);
 */
export function addCycle(
  dir: string,
  cycle: ReviewCycle,
): ResultAsync<ReviewState, StateError> {
  const fp = statePath(dir);

  return readStateFile(fp).andThen((state) => {
    const updated: ReviewState = {
      cycles: [...state.cycles, cycle],
      totalFixed: state.totalFixed + cycle.fixedCount,
      totalDeferred: state.totalDeferred,
      totalDismissed: state.totalDismissed,
    };
    return writeStateFile(fp, updated);
  });
}

/**
 * Reads and returns the current ReviewState from the given directory.
 * @param dir - Directory containing state.json
 * @returns The current ReviewState, or a StateError
 * @example
 * const result = await getState('/tmp/review');
 * if (result.isOk()) console.log(result.value.cycles.length);
 */
export function getState(
  dir: string,
): ResultAsync<ReviewState, StateError> {
  return readStateFile(statePath(dir));
}

/**
 * Returns a human-readable summary string of all review cycles in the state.
 * @param state - The ReviewState to summarize
 * @returns A formatted multi-line summary string
 * @example
 * const summary = summarizeState(state);
 * console.log(summary);
 */
export function summarizeState(state: ReviewState): string {
  const lines: string[] = [];
  lines.push(`Review State Summary`);
  lines.push(`====================`);
  lines.push(`Total cycles: ${state.cycles.length}`);
  lines.push(`Total fixed: ${state.totalFixed}`);
  lines.push(`Total deferred: ${state.totalDeferred}`);
  lines.push(`Total dismissed: ${state.totalDismissed}`);

  if (state.cycles.length > 0) {
    lines.push('');
    lines.push('Cycles:');
    for (const cycle of state.cycles) {
      lines.push(
        `  #${cycle.iteration} [${cycle.timestamp}] - ${cycle.findingsCount} findings, ${cycle.blockingCount} blocking, ${cycle.fixedCount} fixed (${cycle.reportPath})`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Formats a StateError into a human-readable string for CLI output.
 * @param error - The StateError to format
 * @returns A formatted error string
 */
function formatStateError(error: StateError): string {
  if ('path' in error) {
    return `Error: ${error.reason} - ${error.path}`;
  }
  return `Error: ${error.reason} - ${error.message}`;
}

/**
 * CLI entry point. Parses process.argv and dispatches to the appropriate function.
 * Subcommands: init, add-cycle, get, summary
 * @param args - CLI arguments (typically process.argv.slice(2))
 * @returns A promise that resolves when the command completes
 */
export async function runCli(args: string[]): Promise<void> {
  const subcommand = args[0];
  const dir = args[1];

  if (!subcommand || !dir) {
    console.error('Usage: state <init|add-cycle|get|summary> <dir> [json]');
    process.exitCode = 1;
    return;
  }

  switch (subcommand) {
    case 'init': {
      const result = await initState(dir);
      result.match(
        (state) => console.log(JSON.stringify(state, null, 2)),
        (error) => {
          console.error(formatStateError(error));
          process.exitCode = 1;
        },
      );
      break;
    }
    case 'add-cycle': {
      const json = args[2];
      if (!json) {
        console.error('Usage: state add-cycle <dir> <json>');
        process.exitCode = 1;
        return;
      }
      let cycle: ReviewCycle;
      try {
        cycle = JSON.parse(json) as ReviewCycle;
      } catch {
        console.error('Error: invalid JSON for cycle');
        process.exitCode = 1;
        return;
      }
      const result = await addCycle(dir, cycle);
      result.match(
        (state) => console.log(JSON.stringify(state, null, 2)),
        (error) => {
          console.error(formatStateError(error));
          process.exitCode = 1;
        },
      );
      break;
    }
    case 'get': {
      const result = await getState(dir);
      result.match(
        (state) => console.log(JSON.stringify(state, null, 2)),
        (error) => {
          console.error(formatStateError(error));
          process.exitCode = 1;
        },
      );
      break;
    }
    case 'summary': {
      const result = await getState(dir);
      result.match(
        (state) => console.log(summarizeState(state)),
        (error) => {
          console.error(formatStateError(error));
          process.exitCode = 1;
        },
      );
      break;
    }
    default: {
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exitCode = 1;
    }
  }
}

/* c8 ignore start -- CLI entry point guard */
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/state.js') || process.argv[1].endsWith('\\state.js'));

if (isDirectRun) {
  void runCli(process.argv.slice(2));
}
/* c8 ignore stop */
