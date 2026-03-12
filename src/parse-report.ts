import fs from 'node:fs';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { Action, DiffSummary, Finding, ReviewReport, Severity } from './types.js';
import { ReviewReportSchema } from './types.js';

/** Error types that can occur when parsing a review report */
export type ParseError =
  | { reason: 'file_not_found'; path: string }
  | { reason: 'invalid_format'; message: string }
  | { reason: 'validation_error'; message: string };

/** Summary statistics computed from a parsed report */
export interface ReportSummary {
  blocking: number;
  advisory: number;
  approved: number;
  modified: number;
  deferred: number;
  dismissed: number;
  unannotated: number;
}

/** A successfully parsed report with computed summary */
export interface ParsedReport {
  report: ReviewReport;
  summary: ReportSummary;
}

/**
 * Extracts the branch name from the report header.
 * @param content - Raw markdown content
 * @returns The branch name or null if not found
 */
function extractBranch(content: string): string | null {
  const match = /\*\*Branch\*\*:\s*(.+)/.exec(content);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extracts the date from the report header.
 * @param content - Raw markdown content
 * @returns The date string or null if not found
 */
function extractDate(content: string): string | null {
  const match = /\*\*Date\*\*:\s*(.+)/.exec(content);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extracts the diff summary from the report header.
 * @param content - Raw markdown content
 * @returns The parsed DiffSummary or null if not found
 */
function extractDiffSummary(content: string): DiffSummary | null {
  const match =
    /\*\*Diff Summary\*\*:\s*(\d+)\s+files?\s+changed,\s*(\d+)\s+insertions?\(\+\),\s*(\d+)\s+deletions?\(-\)/.exec(
      content,
    );
  if (!match) {
    return null;
  }
  return {
    filesChanged: Number(match[1]),
    insertions: Number(match[2]),
    deletions: Number(match[3]),
  };
}

/**
 * Splits the report content into individual finding sections.
 * @param content - Raw markdown content
 * @returns Array of finding section strings with their header
 */
function splitFindings(content: string): string[] {
  const sections: string[] = [];
  const regex = /### Finding \d+:/g;
  const matches: number[] = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(content)) !== null) {
    matches.push(m.index);
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!;
    const end = i + 1 < matches.length ? matches[i + 1]! : content.length;
    sections.push(content.slice(start, end));
  }

  return sections;
}

/**
 * Parses the action checkbox state from a finding section.
 * @param section - A single finding's markdown text
 * @param humanNotes - Parsed human notes for use with modify action
 * @returns The parsed Action or null if no checkbox is checked
 */
function parseAction(section: string, humanNotes: string | null): Action | null {
  const approveMatch = /- \[x\] Approve/i.exec(section);
  if (approveMatch) {
    return { type: 'approve' };
  }

  const modifyMatch = /- \[x\] Modify/i.exec(section);
  if (modifyMatch) {
    return { type: 'modify', notes: humanNotes ?? '' };
  }

  const deferMatch = /- \[x\] Defer/i.exec(section);
  if (deferMatch) {
    return { type: 'defer' };
  }

  const dismissMatch = /- \[x\] Dismiss/i.exec(section);
  if (dismissMatch) {
    return { type: 'dismiss' };
  }

  return null;
}

/**
 * Extracts text between two section markers in a finding.
 * @param section - A single finding's markdown text
 * @param startMarker - The start marker (e.g., "**Issue**:")
 * @param endMarker - The end marker (e.g., "**Suggestion**:")
 * @returns The extracted text, trimmed, or null if not found
 */
function extractBetween(section: string, startMarker: string, endMarker: string): string | null {
  const startIdx = section.indexOf(startMarker);
  if (startIdx === -1) {
    return null;
  }
  const afterStart = startIdx + startMarker.length;
  const endIdx = section.indexOf(endMarker, afterStart);
  if (endIdx === -1) {
    return null;
  }
  return section.slice(afterStart, endIdx).trim();
}

/**
 * Extracts text from a section marker to the end of the finding section.
 * @param section - A single finding's markdown text
 * @param marker - The marker to find
 * @returns The extracted text, trimmed, or null if not found
 */
function extractAfter(section: string, marker: string): string | null {
  const idx = section.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  const afterMarker = idx + marker.length;
  let rest = section.slice(afterMarker);
  // Stop at the section divider (---) if present
  const dividerIdx = rest.indexOf('\n---');
  if (dividerIdx !== -1) {
    rest = rest.slice(0, dividerIdx);
  }
  rest = rest.trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Parses a single finding section into a Finding object.
 * @param section - A single finding's markdown text
 * @returns Result containing the parsed Finding or a ParseError
 */
function parseFinding(section: string): Result<Finding, ParseError> {
  const headerMatch = /### Finding (\d+):\s*(.+)/.exec(section);
  if (!headerMatch) {
    return err({ reason: 'invalid_format', message: 'Missing finding header' });
  }
  const index = Number(headerMatch[1]);
  const title = headerMatch[2]!.trim();

  const severityMatch = /- \*\*Severity\*\*:\s*(blocking|advisory)/i.exec(section);
  if (!severityMatch) {
    return err({
      reason: 'invalid_format',
      message: `Finding ${String(index)}: missing or invalid severity`,
    });
  }
  const severity = severityMatch[1]!.toLowerCase() as Severity;

  const fileMatch = /- \*\*File\*\*:\s*`([^`]+)`/.exec(section);
  if (!fileMatch) {
    return err({
      reason: 'invalid_format',
      message: `Finding ${String(index)}: missing file path`,
    });
  }
  const file = fileMatch[1]!;

  const lineMatch = /- \*\*Line\*\*:\s*(.+)/.exec(section);
  let line: number | null = null;
  if (lineMatch) {
    const lineStr = lineMatch[1]!.trim();
    if (lineStr.toLowerCase() !== 'n/a') {
      line = Number(lineStr);
    }
  }

  const issue = extractBetween(section, '**Issue**:', '**Suggestion**:');
  if (!issue) {
    return err({
      reason: 'invalid_format',
      message: `Finding ${String(index)}: missing issue text`,
    });
  }

  const suggestion = extractBetween(section, '**Suggestion**:', '**Action**');
  if (!suggestion) {
    return err({
      reason: 'invalid_format',
      message: `Finding ${String(index)}: missing suggestion text`,
    });
  }

  const humanNotes = extractAfter(section, '**Human notes**:');
  const action = parseAction(section, humanNotes);

  return ok({
    index,
    title,
    severity,
    file,
    line,
    issue,
    suggestion,
    action,
    humanNotes,
  });
}

/**
 * Computes summary statistics from parsed findings.
 * @param findings - Array of parsed findings
 * @returns Summary counts by severity and action type
 */
function computeSummary(findings: Finding[]): ReportSummary {
  const summary: ReportSummary = {
    blocking: 0,
    advisory: 0,
    approved: 0,
    modified: 0,
    deferred: 0,
    dismissed: 0,
    unannotated: 0,
  };

  for (const finding of findings) {
    if (finding.severity === 'blocking') {
      summary.blocking++;
    } else {
      summary.advisory++;
    }

    if (finding.action === null) {
      summary.unannotated++;
    } else {
      switch (finding.action.type) {
        case 'approve':
          summary.approved++;
          break;
        case 'modify':
          summary.modified++;
          break;
        case 'defer':
          summary.deferred++;
          break;
        case 'dismiss':
          summary.dismissed++;
          break;
      }
    }
  }

  return summary;
}

/**
 * Parses a review report Markdown string into structured data.
 * @param content - The raw Markdown content of a review report
 * @returns Result containing the parsed report and summary, or a ParseError
 * @example
 * const result = parseReport(markdownString);
 * result.match(
 *   (parsed) => console.log(parsed.summary),
 *   (error) => console.error(error.reason),
 * );
 */
export function parseReport(content: string): Result<ParsedReport, ParseError> {
  const branchName = extractBranch(content);
  if (!branchName) {
    return err({ reason: 'invalid_format', message: 'Missing branch name' });
  }

  const date = extractDate(content);
  if (!date) {
    return err({ reason: 'invalid_format', message: 'Missing date' });
  }

  const diffSummary = extractDiffSummary(content);
  if (!diffSummary) {
    return err({ reason: 'invalid_format', message: 'Missing or invalid diff summary' });
  }

  const findingSections = splitFindings(content);
  const findings: Finding[] = [];

  for (const section of findingSections) {
    const result = parseFinding(section);
    if (result.isErr()) {
      return err(result.error);
    }
    findings.push(result.value);
  }

  const report: ReviewReport = {
    branchName,
    date,
    diffSummary,
    findings,
  };

  const validation = ReviewReportSchema.safeParse(report);
  if (!validation.success) {
    return err({
      reason: 'validation_error',
      message: validation.error.message,
    });
  }

  const summary = computeSummary(findings);

  return ok({ report, summary });
}

/**
 * Reads a report file from disk and parses it.
 * @param filePath - Path to the Markdown report file
 * @returns Result containing the parsed report or a ParseError
 */
export function parseReportFile(filePath: string): Result<ParsedReport, ParseError> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return err({ reason: 'file_not_found', path: filePath });
  }
  return parseReport(content);
}

/* v8 ignore start -- CLI entry point cannot be tested via vitest imports */
const scriptUrl = import.meta.url;
const arg1 = process.argv[1];
if (arg1 && scriptUrl.endsWith(arg1.replace(/\\/g, '/'))) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node parse-report.js <path>');
    process.exit(1);
  }

  const result = parseReportFile(filePath);
  result.match(
    (parsed) => {
      console.log(JSON.stringify(parsed, null, 2));
    },
    (error) => {
      console.error(JSON.stringify(error, null, 2));
      process.exit(1);
    },
  );
}
