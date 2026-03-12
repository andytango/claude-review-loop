import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReport, parseReportFile } from '../src/parse-report.js';
import type { ParsedReport } from '../src/parse-report.js';

const fixturesDir = path.resolve(__dirname, 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

describe('parseReport', () => {
  describe('unannotated report', () => {
    it('should parse a report with no checkboxes marked', () => {
      const content = readFixture('unannotated.md');
      const result = parseReport(content);

      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();

      expect(parsed.report.branchName).toBe('feature/user-auth');
      expect(parsed.report.date).toBe('2026-03-10');
      expect(parsed.report.diffSummary).toEqual({
        filesChanged: 5,
        insertions: 120,
        deletions: 30,
      });
      expect(parsed.report.findings).toHaveLength(3);
    });

    it('should have all actions as null for unannotated findings', () => {
      const content = readFixture('unannotated.md');
      const parsed = parseReport(content)._unsafeUnwrap();

      for (const finding of parsed.report.findings) {
        expect(finding.action).toBeNull();
      }
    });

    it('should correctly parse finding details', () => {
      const content = readFixture('unannotated.md');
      const parsed = parseReport(content)._unsafeUnwrap();
      const finding1 = parsed.report.findings[0]!;

      expect(finding1.index).toBe(1);
      expect(finding1.title).toBe('SQL Injection in Login Query');
      expect(finding1.severity).toBe('blocking');
      expect(finding1.file).toBe('src/auth.ts');
      expect(finding1.line).toBe(42);
      expect(finding1.issue).toContain('SQL injection');
      expect(finding1.suggestion).toContain('parameterized queries');
    });
  });

  describe('fully annotated report', () => {
    it('should parse all action types correctly', () => {
      const content = readFixture('annotated.md');
      const parsed = parseReport(content)._unsafeUnwrap();

      const finding1 = parsed.report.findings[0]!;
      expect(finding1.action).toEqual({ type: 'approve' });

      const finding2 = parsed.report.findings[1]!;
      expect(finding2.action).toEqual({ type: 'dismiss' });

      const finding3 = parsed.report.findings[2]!;
      expect(finding3.action).toEqual({ type: 'modify', notes: 'Use try-catch instead of if-else' });
    });

    it('should parse human notes on dismiss action', () => {
      const content = readFixture('annotated.md');
      const parsed = parseReport(content)._unsafeUnwrap();
      const finding2 = parsed.report.findings[1]!;

      expect(finding2.humanNotes).toBe('Style is intentional');
    });
  });

  describe('partially annotated report', () => {
    it('should parse mix of annotated and unannotated findings', () => {
      const content = readFixture('partial.md');
      const parsed = parseReport(content)._unsafeUnwrap();

      expect(parsed.report.findings[0]!.action).toEqual({ type: 'approve' });
      expect(parsed.report.findings[1]!.action).toBeNull();
      expect(parsed.report.findings[2]!.action).toBeNull();
    });

    it('should have correct summary counts for partial annotation', () => {
      const content = readFixture('partial.md');
      const parsed = parseReport(content)._unsafeUnwrap();

      expect(parsed.summary.approved).toBe(1);
      expect(parsed.summary.unannotated).toBe(2);
      expect(parsed.summary.blocking).toBe(2);
      expect(parsed.summary.advisory).toBe(1);
    });
  });

  describe('malformed report', () => {
    it('should return error for missing severity', () => {
      const content = readFixture('malformed.md');
      const result = parseReport(content);

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      expect(error).toHaveProperty('message');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('Finding 1');
        expect(error.message).toContain('severity');
      }
    });
  });

  describe('report with no findings', () => {
    it('should parse successfully with empty findings array', () => {
      const content = readFixture('no-findings.md');
      const result = parseReport(content);

      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.report.findings).toHaveLength(0);
      expect(parsed.report.branchName).toBe('feature/clean-code');
      expect(parsed.report.date).toBe('2026-03-11');
    });

    it('should have all zero summary counts', () => {
      const content = readFixture('no-findings.md');
      const parsed = parseReport(content)._unsafeUnwrap();

      expect(parsed.summary).toEqual({
        blocking: 0,
        advisory: 0,
        approved: 0,
        modified: 0,
        deferred: 0,
        dismissed: 0,
        unannotated: 0,
      });
    });
  });

  describe('N/A line numbers', () => {
    it('should parse N/A line numbers as null', () => {
      const content = `# Code Review Report

**Branch**: feature/test
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 5 insertions(+), 2 deletions(-)

---

## Findings

### Finding 1: Missing Export

- **Severity**: advisory
- **File**: \`src/index.ts\`
- **Line**: N/A

**Issue**:
The module does not export its main function.

**Suggestion**:
Add an export statement for the main function.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)
- [ ] Modify — Fix with different approach (describe below)
- [ ] Defer — Acknowledged but not fixing now
- [ ] Dismiss — Disagree, not an issue

**Human notes**:
`;

      const parsed = parseReport(content)._unsafeUnwrap();
      expect(parsed.report.findings[0]!.line).toBeNull();
    });
  });

  describe('multiple findings with same file', () => {
    it('should parse findings that share the same file path', () => {
      const content = `# Code Review Report

**Branch**: feature/same-file
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 20 insertions(+), 5 deletions(-)

---

## Findings

### Finding 1: Issue A

- **Severity**: blocking
- **File**: \`src/auth.ts\`
- **Line**: 10

**Issue**:
First issue in auth.ts.

**Suggestion**:
Fix issue A.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)
- [ ] Modify — Fix with different approach (describe below)
- [ ] Defer — Acknowledged but not fixing now
- [ ] Dismiss — Disagree, not an issue

**Human notes**:

---

### Finding 2: Issue B

- **Severity**: advisory
- **File**: \`src/auth.ts\`
- **Line**: 25

**Issue**:
Second issue in auth.ts.

**Suggestion**:
Fix issue B.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)
- [ ] Modify — Fix with different approach (describe below)
- [ ] Defer — Acknowledged but not fixing now
- [ ] Dismiss — Disagree, not an issue

**Human notes**:
`;

      const parsed = parseReport(content)._unsafeUnwrap();
      expect(parsed.report.findings).toHaveLength(2);
      expect(parsed.report.findings[0]!.file).toBe('src/auth.ts');
      expect(parsed.report.findings[1]!.file).toBe('src/auth.ts');
      expect(parsed.report.findings[0]!.line).toBe(10);
      expect(parsed.report.findings[1]!.line).toBe(25);
    });
  });

  describe('modify action with human notes', () => {
    it('should include human notes in the modify action', () => {
      const content = readFixture('annotated.md');
      const parsed = parseReport(content)._unsafeUnwrap();
      const finding3 = parsed.report.findings[2]!;

      expect(finding3.action).toEqual({
        type: 'modify',
        notes: 'Use try-catch instead of if-else',
      });
      expect(finding3.humanNotes).toBe('Use try-catch instead of if-else');
    });
  });

  describe('summary counts', () => {
    it('should compute correct counts for unannotated report', () => {
      const content = readFixture('unannotated.md');
      const parsed = parseReport(content)._unsafeUnwrap();

      expect(parsed.summary).toEqual({
        blocking: 2,
        advisory: 1,
        approved: 0,
        modified: 0,
        deferred: 0,
        dismissed: 0,
        unannotated: 3,
      });
    });

    it('should compute correct counts for annotated report', () => {
      const content = readFixture('annotated.md');
      const parsed = parseReport(content)._unsafeUnwrap();

      expect(parsed.summary).toEqual({
        blocking: 2,
        advisory: 1,
        approved: 1,
        modified: 1,
        deferred: 0,
        dismissed: 1,
        unannotated: 0,
      });
    });
  });

  describe('error cases', () => {
    it('should return error for missing branch name', () => {
      const content = `# Code Review Report

**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)
`;

      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('branch');
      }
    });

    it('should return error for missing date', () => {
      const content = `# Code Review Report

**Branch**: feature/test
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)
`;

      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('date');
      }
    });

    it('should return error for missing diff summary', () => {
      const content = `# Code Review Report

**Branch**: feature/test
**Date**: 2026-03-10
`;

      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('diff summary');
      }
    });

    it('should return error for finding missing file path', () => {
      const content = `# Code Review Report

**Branch**: feature/test
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)

### Finding 1: Test

- **Severity**: blocking
- **Line**: 10

**Issue**:
Test issue.

**Suggestion**:
Test suggestion.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)
- [ ] Modify — Fix with different approach (describe below)
- [ ] Defer — Acknowledged but not fixing now
- [ ] Dismiss — Disagree, not an issue

**Human notes**:
`;

      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('file path');
      }
    });

    it('should return error for finding missing issue text', () => {
      const content = `# Code Review Report

**Branch**: feature/test
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)

### Finding 1: Test

- **Severity**: blocking
- **File**: \`src/test.ts\`
- **Line**: 10

**Suggestion**:
Test suggestion.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)

**Human notes**:
`;

      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('issue');
      }
    });

    it('should return error for finding missing suggestion text', () => {
      const content = `# Code Review Report

**Branch**: feature/test
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)

### Finding 1: Test

- **Severity**: blocking
- **File**: \`src/test.ts\`
- **Line**: 10

**Issue**:
Test issue.

**Suggestion**:

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)

**Human notes**:
`;

      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('suggestion');
      }
    });
  });

  describe('defer action', () => {
    it('should parse defer checkbox correctly', () => {
      const content = `# Code Review Report

**Branch**: feature/defer-test
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 5 insertions(+), 2 deletions(-)

### Finding 1: Low Priority Fix

- **Severity**: advisory
- **File**: \`src/utils.ts\`
- **Line**: 30

**Issue**:
Minor style issue.

**Suggestion**:
Refactor later.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)
- [ ] Modify — Fix with different approach (describe below)
- [x] Defer — Acknowledged but not fixing now
- [ ] Dismiss — Disagree, not an issue

**Human notes**:
`;

      const parsed = parseReport(content)._unsafeUnwrap();
      expect(parsed.report.findings[0]!.action).toEqual({ type: 'defer' });
      expect(parsed.summary.deferred).toBe(1);
    });
  });
});

  describe('validation error', () => {
    it('should return validation_error when Zod schema rejects data', () => {
      // A finding with an empty title would pass our regex but fail Zod min(1)
      // We can trigger this by having empty title after the colon
      const content = `# Code Review Report

**Branch**: feature/test
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)

### Finding 0: Valid Title

- **Severity**: blocking
- **File**: \`src/test.ts\`
- **Line**: 10

**Issue**:
Test issue.

**Suggestion**:
Test suggestion.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)
- [ ] Modify — Fix with different approach (describe below)
- [ ] Defer — Acknowledged but not fixing now
- [ ] Dismiss — Disagree, not an issue

**Human notes**:
`;

      // Finding index 0 fails Zod's min(1) constraint
      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('validation_error');
    });
  });

  describe('edge cases in extractAfter', () => {
    it('should return null when human notes marker is absent', () => {
      const content = `# Code Review Report

**Branch**: feature/no-notes
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)

### Finding 1: No Notes Section

- **Severity**: advisory
- **File**: \`src/foo.ts\`
- **Line**: 5

**Issue**:
Some issue.

**Suggestion**:
Some suggestion.

**Action** (check one):
- [x] Approve — Fix as suggested (or with modifications below)
- [ ] Modify — Fix with different approach (describe below)
- [ ] Defer — Acknowledged but not fixing now
- [ ] Dismiss — Disagree, not an issue
`;

      const parsed = parseReport(content)._unsafeUnwrap();
      expect(parsed.report.findings[0]!.humanNotes).toBeNull();
      expect(parsed.report.findings[0]!.action).toEqual({ type: 'approve' });
    });
  });

  describe('edge cases in extractBetween', () => {
    it('should handle missing Issue marker when Suggestion exists', () => {
      const content = `# Code Review Report

**Branch**: feature/test
**Date**: 2026-03-10
**Diff Summary**: 1 files changed, 1 insertions(+), 0 deletions(-)

### Finding 1: Test

- **Severity**: blocking
- **File**: \`src/test.ts\`
- **Line**: 10

**Suggestion**:
Test suggestion.

**Action** (check one):
- [ ] Approve — Fix as suggested (or with modifications below)

**Human notes**:
`;

      const result = parseReport(content);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_format');
      if (error.reason === 'invalid_format') {
        expect(error.message).toContain('issue');
      }
    });
  });

describe('parseReportFile', () => {
  it('should return file_not_found error for nonexistent file', () => {
    const result = parseReportFile('/tmp/nonexistent-report-xyz.md');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.reason).toBe('file_not_found');
    if (error.reason === 'file_not_found') {
      expect(error.path).toBe('/tmp/nonexistent-report-xyz.md');
    }
  });

  it('should parse a valid fixture file from disk', () => {
    const filePath = path.join(fixturesDir, 'annotated.md');
    const result = parseReportFile(filePath);

    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.report.findings).toHaveLength(3);
  });
});
