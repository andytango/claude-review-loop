import { ok, err } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { Finding, ParallelismPlan, ParallelStream } from './types.js';

/** Error returned when parallelism planning fails */
export type PlanError = { reason: 'empty_findings'; message: string };

/** Error returned when CLI input processing fails */
export type CliInputError =
  | { reason: 'empty_input'; message: string }
  | { reason: 'parse_error'; message: string }
  | { reason: 'not_array'; message: string }
  | { reason: 'empty_findings'; message: string };

/**
 * Groups approved findings into parallel/sequential remediation streams.
 *
 * Findings touching different files can be fixed in parallel (separate streams).
 * Findings touching the same file must be fixed sequentially (same stream).
 *
 * @param findings - Array of findings to plan parallelism for
 * @returns A Result containing the ParallelismPlan or a PlanError
 * @example
 * const result = planParallelism([finding1, finding2]);
 * result.match(
 *   (plan) => console.log(plan.totalStreams),
 *   (error) => console.error(error.message),
 * );
 */
export function planParallelism(findings: Finding[]): Result<ParallelismPlan, PlanError> {
  if (findings.length === 0) {
    return err({ reason: 'empty_findings', message: 'Cannot plan parallelism for empty findings array' });
  }

  const fileToFindings = new Map<string, Finding[]>();

  for (const finding of findings) {
    const existing = fileToFindings.get(finding.file);
    if (existing) {
      existing.push(finding);
    } else {
      fileToFindings.set(finding.file, [finding]);
    }
  }

  const streams: ParallelStream[] = [];
  let streamId = 1;

  for (const [file, groupedFindings] of fileToFindings) {
    const sortedFindings = [...groupedFindings].sort((a, b) => a.index - b.index);
    streams.push({
      id: streamId,
      findings: sortedFindings,
      files: [file],
      canParallelize: true,
    });
    streamId++;
  }

  const totalStreams = streams.length;

  const plan: ParallelismPlan = {
    streams,
    totalStreams,
    parallelStreams: totalStreams,
    sequentialStreams: 0,
  };

  return ok(plan);
}

/**
 * Processes raw CLI input string and returns a ParallelismPlan or a CliInputError.
 *
 * Handles parsing, validation, and delegation to planParallelism.
 *
 * @param input - Raw string input (expected to be JSON array of findings)
 * @returns A Result containing the ParallelismPlan or a CliInputError
 */
export function processCliInput(input: string): Result<ParallelismPlan, CliInputError> {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return err({ reason: 'empty_input', message: 'No input provided on stdin' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return err({ reason: 'parse_error', message: 'Invalid JSON input' });
  }

  if (!Array.isArray(parsed)) {
    return err({ reason: 'not_array', message: 'Input must be a JSON array' });
  }

  const findings = parsed as Finding[];
  return planParallelism(findings);
}

/* v8 ignore start -- CLI entry point, tested via integration */
/**
 * CLI entry point: reads JSON array of findings from stdin, outputs plan JSON to stdout.
 *
 * Exits with code 0 on success, 1 on error.
 */
async function main(): Promise<void> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  const input = Buffer.concat(chunks).toString('utf-8');
  const result = processCliInput(input);

  result.match(
    (plan) => {
      process.stdout.write(JSON.stringify(plan) + '\n');
    },
    (cliError) => {
      process.stdout.write(JSON.stringify({ error: cliError }) + '\n');
      process.exitCode = 1;
    },
  );
}

const isCliEntryPoint =
  typeof process !== 'undefined' && process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);

if (isCliEntryPoint) {
  main();
}
/* v8 ignore stop */
