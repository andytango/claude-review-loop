import { z } from 'zod';

/** Severity levels for review findings */
export type Severity = 'blocking' | 'advisory';

/** Zod schema for Severity */
export const SeveritySchema = z.enum(['blocking', 'advisory']);

/** An action annotation applied by a human to a finding */
export type Action =
  | { type: 'approve' }
  | { type: 'modify'; notes: string }
  | { type: 'defer' }
  | { type: 'dismiss' };

/** Zod schema for Action */
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }),
  z.object({ type: z.literal('modify'), notes: z.string() }),
  z.object({ type: z.literal('defer') }),
  z.object({ type: z.literal('dismiss') }),
]);

/** A single review finding with optional human annotation */
export interface Finding {
  index: number;
  title: string;
  severity: Severity;
  file: string;
  line: number | null;
  issue: string;
  suggestion: string;
  action: Action | null;
  humanNotes: string | null;
}

/** Zod schema for Finding */
export const FindingSchema = z.object({
  index: z.number().int().min(1),
  title: z.string().min(1),
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().min(1).nullable(),
  issue: z.string().min(1),
  suggestion: z.string().min(1),
  action: ActionSchema.nullable(),
  humanNotes: z.string().nullable(),
});

/** Summary statistics from a git diff */
export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Zod schema for DiffSummary */
export const DiffSummarySchema = z.object({
  filesChanged: z.number().int().min(0),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});

/** A structured review report containing findings and metadata */
export interface ReviewReport {
  branchName: string;
  date: string;
  diffSummary: DiffSummary;
  findings: Finding[];
}

/** Zod schema for ReviewReport */
export const ReviewReportSchema = z.object({
  branchName: z.string().min(1),
  date: z.string().min(1),
  diffSummary: DiffSummarySchema,
  findings: z.array(FindingSchema),
});

/** A record of one review cycle iteration */
export interface ReviewCycle {
  iteration: number;
  timestamp: string;
  reportPath: string;
  findingsCount: number;
  blockingCount: number;
  approvedCount: number;
  fixedCount: number;
}

/** Zod schema for ReviewCycle */
export const ReviewCycleSchema = z.object({
  iteration: z.number().int().min(1),
  timestamp: z.string().min(1),
  reportPath: z.string().min(1),
  findingsCount: z.number().int().min(0),
  blockingCount: z.number().int().min(0),
  approvedCount: z.number().int().min(0),
  fixedCount: z.number().int().min(0),
});

/** Persistent state tracking all review cycles */
export interface ReviewState {
  cycles: ReviewCycle[];
  totalFixed: number;
  totalDeferred: number;
  totalDismissed: number;
}

/** Zod schema for ReviewState */
export const ReviewStateSchema = z.object({
  cycles: z.array(ReviewCycleSchema),
  totalFixed: z.number().int().min(0),
  totalDeferred: z.number().int().min(0),
  totalDismissed: z.number().int().min(0),
});

/** A single parallelism stream grouping findings that must be applied sequentially */
export interface ParallelStream {
  id: number;
  findings: Finding[];
  files: string[];
  canParallelize: boolean;
}

/** A plan describing how to parallelize remediation across streams */
export interface ParallelismPlan {
  streams: ParallelStream[];
  totalStreams: number;
  parallelStreams: number;
  sequentialStreams: number;
}

/** Zod schema for ParallelStream */
export const ParallelStreamSchema = z.object({
  id: z.number().int().min(1),
  findings: z.array(FindingSchema),
  files: z.array(z.string()),
  canParallelize: z.boolean(),
});

/** Zod schema for ParallelismPlan */
export const ParallelismPlanSchema = z.object({
  streams: z.array(ParallelStreamSchema),
  totalStreams: z.number().int().min(0),
  parallelStreams: z.number().int().min(0),
  sequentialStreams: z.number().int().min(0),
});
