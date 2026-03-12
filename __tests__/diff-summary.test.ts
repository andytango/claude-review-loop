import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecFileException } from 'node:child_process';

// Mock child_process.execFile before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { computeDiffSummary, main, isDirectRun } from '../src/diff-summary.js';

const mockedExecFile = vi.mocked(execFile);

/**
 * Helper to make the mocked execFile call back with given stdout.
 */
function mockExecFileSuccess(stdout: string): void {
  mockedExecFile.mockImplementation((_cmd, _args, callback) => {
    (callback as (error: ExecFileException | null, stdout: string, stderr: string) => void)(
      null,
      stdout,
      '',
    );
    return undefined as never;
  });
}

/**
 * Helper to make the mocked execFile call back with an error.
 */
function mockExecFileError(message: string): void {
  mockedExecFile.mockImplementation((_cmd, _args, callback) => {
    const error = new Error(message) as ExecFileException;
    error.code = 'ERR_CHILD_PROCESS';
    (callback as (error: ExecFileException | null, stdout: string, stderr: string) => void)(
      error,
      '',
      message,
    );
    return undefined as never;
  });
}

describe('computeDiffSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses a normal diff with insertions and deletions', async () => {
    mockExecFileSuccess(
      [
        ' src/foo.ts | 10 ++++------',
        ' src/bar.ts |  5 ++---',
        ' src/baz.ts |  3 +++',
        ' 3 files changed, 10 insertions(+), 5 deletions(-)',
      ].join('\n'),
    );

    const result = await computeDiffSummary('main');

    expect(result.isOk()).toBe(true);
    result.match(
      (summary) => {
        expect(summary).toEqual({
          filesChanged: 3,
          insertions: 10,
          deletions: 5,
        });
      },
      () => {
        throw new Error('Expected ok result');
      },
    );
  });

  it('parses a diff with only insertions (no deletions)', async () => {
    mockExecFileSuccess(
      [' src/new.ts | 20 ++++++++++++++++++++', ' 1 file changed, 20 insertions(+)'].join('\n'),
    );

    const result = await computeDiffSummary('main');

    expect(result.isOk()).toBe(true);
    result.match(
      (summary) => {
        expect(summary).toEqual({
          filesChanged: 1,
          insertions: 20,
          deletions: 0,
        });
      },
      () => {
        throw new Error('Expected ok result');
      },
    );
  });

  it('parses a diff with only deletions (no insertions)', async () => {
    mockExecFileSuccess(
      [' src/old.ts | 15 ---------------', ' 1 file changed, 15 deletions(-)'].join('\n'),
    );

    const result = await computeDiffSummary('main');

    expect(result.isOk()).toBe(true);
    result.match(
      (summary) => {
        expect(summary).toEqual({
          filesChanged: 1,
          insertions: 0,
          deletions: 15,
        });
      },
      () => {
        throw new Error('Expected ok result');
      },
    );
  });

  it('handles an empty diff (no changes)', async () => {
    mockExecFileSuccess('');

    const result = await computeDiffSummary('main');

    expect(result.isOk()).toBe(true);
    result.match(
      (summary) => {
        expect(summary).toEqual({
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
        });
      },
      () => {
        throw new Error('Expected ok result');
      },
    );
  });

  it('handles binary files in diff output', async () => {
    mockExecFileSuccess(
      [
        ' src/app.ts    | 5 +++--',
        ' assets/img.png | Bin 0 -> 1234 bytes',
        ' 2 files changed, 3 insertions(+), 2 deletions(-)',
      ].join('\n'),
    );

    const result = await computeDiffSummary('main');

    expect(result.isOk()).toBe(true);
    result.match(
      (summary) => {
        expect(summary).toEqual({
          filesChanged: 2,
          insertions: 3,
          deletions: 2,
        });
      },
      () => {
        throw new Error('Expected ok result');
      },
    );
  });

  it('handles renamed files in diff output', async () => {
    mockExecFileSuccess(
      [
        ' src/{old-name.ts => new-name.ts} | 2 +-',
        ' src/other.ts                     | 8 ++++++++',
        ' 2 files changed, 9 insertions(+), 1 deletion(-)',
      ].join('\n'),
    );

    const result = await computeDiffSummary('main');

    expect(result.isOk()).toBe(true);
    result.match(
      (summary) => {
        expect(summary).toEqual({
          filesChanged: 2,
          insertions: 9,
          deletions: 1,
        });
      },
      () => {
        throw new Error('Expected ok result');
      },
    );
  });

  it('returns a git_error on non-zero exit code', async () => {
    mockExecFileError('Command failed: git diff --stat main');

    const result = await computeDiffSummary('main');

    expect(result.isErr()).toBe(true);
    result.match(
      () => {
        throw new Error('Expected err result');
      },
      (error) => {
        expect(error.reason).toBe('git_error');
        expect(error.message).toContain('Command failed');
      },
    );
  });

  it('returns invalid_merge_base for unknown revision', async () => {
    mockExecFileError("fatal: bad revision 'nonexistent-branch'");

    const result = await computeDiffSummary('nonexistent-branch');

    expect(result.isErr()).toBe(true);
    result.match(
      () => {
        throw new Error('Expected err result');
      },
      (error) => {
        expect(error.reason).toBe('invalid_merge_base');
        expect(error.message).toContain('bad revision');
      },
    );
  });

  it('returns no_git_repo when not in a git repository', async () => {
    mockExecFileError('fatal: not a git repository (or any of the parent directories): .git');

    const result = await computeDiffSummary('main');

    expect(result.isErr()).toBe(true);
    result.match(
      () => {
        throw new Error('Expected err result');
      },
      (error) => {
        expect(error.reason).toBe('no_git_repo');
        expect(error.message).toContain('not a git repository');
      },
    );
  });

  it('returns invalid_merge_base for unknown revision errors', async () => {
    mockExecFileError("fatal: unknown revision 'abc123'");

    const result = await computeDiffSummary('abc123');

    expect(result.isErr()).toBe(true);
    result.match(
      () => {
        throw new Error('Expected err result');
      },
      (error) => {
        expect(error.reason).toBe('invalid_merge_base');
      },
    );
  });

  it('returns invalid_merge_base for invalid object errors', async () => {
    mockExecFileError('fatal: invalid object abc123');

    const result = await computeDiffSummary('abc123');

    expect(result.isErr()).toBe(true);
    result.match(
      () => {
        throw new Error('Expected err result');
      },
      (error) => {
        expect(error.reason).toBe('invalid_merge_base');
      },
    );
  });

  it('classifies non-Error objects as git_error', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (error: ExecFileException | null, stdout: string, stderr: string) => void)(
        'string error' as unknown as ExecFileException,
        '',
        '',
      );
      return undefined as never;
    });

    const result = await computeDiffSummary('main');

    expect(result.isErr()).toBe(true);
    result.match(
      () => {
        throw new Error('Expected err result');
      },
      (error) => {
        expect(error.reason).toBe('git_error');
      },
    );
  });

  it('passes correct arguments to execFile', async () => {
    mockExecFileSuccess(' 1 file changed, 1 insertion(+)');

    await computeDiffSummary('feature-branch');

    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['diff', '--stat', 'feature-branch'],
      expect.any(Function),
    );
  });

  it('handles singular "file changed" and "insertion/deletion"', async () => {
    mockExecFileSuccess(' 1 file changed, 1 insertion(+), 1 deletion(-)');

    const result = await computeDiffSummary('main');

    expect(result.isOk()).toBe(true);
    result.match(
      (summary) => {
        expect(summary).toEqual({
          filesChanged: 1,
          insertions: 1,
          deletions: 1,
        });
      },
      () => {
        throw new Error('Expected ok result');
      },
    );
  });
});

describe('main (CLI entry point)', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = ['node', 'diff-summary.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('outputs JSON to stdout on success with default merge base', async () => {
    mockExecFileSuccess(' 2 files changed, 5 insertions(+), 3 deletions(-)');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await main();

    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['diff', '--stat', 'main'],
      expect.any(Function),
    );
    expect(writeSpy).toHaveBeenCalledWith(
      JSON.stringify({ filesChanged: 2, insertions: 5, deletions: 3 }, null, 2) + '\n',
    );
    writeSpy.mockRestore();
  });

  it('uses custom merge base from process.argv[2]', async () => {
    process.argv = ['node', 'diff-summary.js', 'develop'];
    mockExecFileSuccess(' 1 file changed, 1 insertion(+)');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await main();

    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['diff', '--stat', 'develop'],
      expect.any(Function),
    );
    writeSpy.mockRestore();
  });

  it('writes error to stderr and sets exitCode on failure', async () => {
    mockExecFileError('fatal: not a git repository (or any of the parent directories): .git');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await main();

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as { error: string; message: string };
    expect(parsed.error).toBe('no_git_repo');
    expect(process.exitCode).toBe(1);
    stderrSpy.mockRestore();
    process.exitCode = undefined;
  });
});

describe('isDirectRun', () => {
  it('returns true when metaUrl ends with the normalized argv1', () => {
    expect(isDirectRun('file:///home/user/project/dist/diff-summary.js', '/home/user/project/dist/diff-summary.js')).toBe(true);
  });

  it('returns false when argv1 is undefined', () => {
    expect(isDirectRun('file:///home/user/project/dist/diff-summary.js', undefined)).toBe(false);
  });

  it('returns false when metaUrl does not end with argv1', () => {
    expect(isDirectRun('file:///home/user/project/dist/diff-summary.js', '/other/script.js')).toBe(false);
  });

  it('normalizes backslashes in argv1 on Windows', () => {
    expect(isDirectRun('file:///C:/project/dist/diff-summary.js', 'C:\\project\\dist\\diff-summary.js')).toBe(true);
  });
});
