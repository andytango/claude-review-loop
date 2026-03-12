import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ReviewCycle, ReviewState } from '../src/types.js';
import { initState, addCycle, getState, summarizeState, runCli } from '../src/state.js';

function makeCycle(overrides: Partial<ReviewCycle> = {}): ReviewCycle {
  return {
    iteration: 1,
    timestamp: '2026-01-15T10:00:00Z',
    reportPath: 'reports/review-1.json',
    findingsCount: 5,
    blockingCount: 2,
    approvedCount: 1,
    fixedCount: 2,
    ...overrides,
  };
}

describe('state', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('initState', () => {
    it('creates state.json with empty state', async () => {
      const result = await initState(tmpDir);
      expect(result.isOk()).toBe(true);

      const state = result._unsafeUnwrap();
      expect(state).toEqual({
        cycles: [],
        totalFixed: 0,
        totalDeferred: 0,
        totalDismissed: 0,
      });

      // Verify file was actually written
      const content = await fs.readFile(path.join(tmpDir, 'state.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual(state);
    });

    it('returns io_error when directory does not exist (write failure)', async () => {
      const result = await initState(path.join(tmpDir, 'nonexistent', 'subdir'));
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().reason).toBe('io_error');
    });

    it('returns already_exists error if state.json already exists', async () => {
      await initState(tmpDir);
      const result = await initState(tmpDir);

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('already_exists');
      expect((error as { reason: 'already_exists'; path: string }).path).toContain('state.json');
    });
  });

  describe('addCycle', () => {
    beforeEach(async () => {
      await initState(tmpDir);
    });

    it('appends a cycle and increments fixedCount', async () => {
      const cycle = makeCycle();
      const result = await addCycle(tmpDir, cycle);

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.cycles).toHaveLength(1);
      expect(state.cycles[0]).toEqual(cycle);
      expect(state.totalFixed).toBe(2);
      expect(state.totalDeferred).toBe(0);
      expect(state.totalDismissed).toBe(0);
    });

    it('accumulates multiple cycles correctly', async () => {
      const cycle1 = makeCycle({ iteration: 1, fixedCount: 3 });
      const cycle2 = makeCycle({ iteration: 2, fixedCount: 5, timestamp: '2026-01-15T11:00:00Z' });
      const cycle3 = makeCycle({ iteration: 3, fixedCount: 1, timestamp: '2026-01-15T12:00:00Z' });

      await addCycle(tmpDir, cycle1);
      await addCycle(tmpDir, cycle2);
      const result = await addCycle(tmpDir, cycle3);

      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.cycles).toHaveLength(3);
      expect(state.totalFixed).toBe(9); // 3 + 5 + 1
    });

    it('returns file_not_found error when state.json is missing', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-empty-'));
      try {
        const result = await addCycle(emptyDir, makeCycle());
        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().reason).toBe('file_not_found');
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('getState', () => {
    it('reads valid state', async () => {
      await initState(tmpDir);
      const cycle = makeCycle();
      await addCycle(tmpDir, cycle);

      const result = await getState(tmpDir);
      expect(result.isOk()).toBe(true);
      const state = result._unsafeUnwrap();
      expect(state.cycles).toHaveLength(1);
      expect(state.totalFixed).toBe(2);
    });

    it('returns file_not_found for missing state.json', async () => {
      const result = await getState(tmpDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().reason).toBe('file_not_found');
    });

    it('returns io_error when directory is not readable', async () => {
      // Create state.json as a directory to trigger a non-ENOENT IO error on read
      const stateJsonPath = path.join(tmpDir, 'state.json');
      await fs.mkdir(stateJsonPath);

      const result = await getState(tmpDir);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      // Reading a directory as a file triggers an EISDIR error
      expect(error.reason).toBe('io_error');
    });

    it('returns invalid_state for corrupt JSON', async () => {
      await fs.writeFile(path.join(tmpDir, 'state.json'), '{not valid json!!!', 'utf-8');

      const result = await getState(tmpDir);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_state');
      expect((error as { reason: 'invalid_state'; message: string }).message).toContain('Failed to parse JSON');
    });

    it('returns invalid_state for valid JSON that fails Zod validation', async () => {
      const invalidState = { cycles: 'not an array', totalFixed: 'bad' };
      await fs.writeFile(
        path.join(tmpDir, 'state.json'),
        JSON.stringify(invalidState),
        'utf-8',
      );

      const result = await getState(tmpDir);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.reason).toBe('invalid_state');
      expect((error as { reason: 'invalid_state'; message: string }).message).toContain('Zod validation failed');
    });
  });

  describe('summarizeState', () => {
    it('formats empty state correctly', () => {
      const state: ReviewState = {
        cycles: [],
        totalFixed: 0,
        totalDeferred: 0,
        totalDismissed: 0,
      };

      const summary = summarizeState(state);
      expect(summary).toContain('Review State Summary');
      expect(summary).toContain('Total cycles: 0');
      expect(summary).toContain('Total fixed: 0');
      expect(summary).toContain('Total deferred: 0');
      expect(summary).toContain('Total dismissed: 0');
      expect(summary).not.toContain('Cycles:');
    });

    it('formats state with cycles correctly', () => {
      const state: ReviewState = {
        cycles: [
          makeCycle({ iteration: 1 }),
          makeCycle({ iteration: 2, timestamp: '2026-01-15T11:00:00Z', findingsCount: 3, blockingCount: 1, fixedCount: 1 }),
        ],
        totalFixed: 3,
        totalDeferred: 1,
        totalDismissed: 2,
      };

      const summary = summarizeState(state);
      expect(summary).toContain('Total cycles: 2');
      expect(summary).toContain('Total fixed: 3');
      expect(summary).toContain('Total deferred: 1');
      expect(summary).toContain('Total dismissed: 2');
      expect(summary).toContain('Cycles:');
      expect(summary).toContain('#1');
      expect(summary).toContain('#2');
      expect(summary).toContain('5 findings');
      expect(summary).toContain('3 findings');
    });
  });

  describe('runCli', () => {
    it('handles missing arguments', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli([]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('handles unknown subcommand', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['unknown', tmpDir]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown subcommand'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('init subcommand creates state', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runCli(['init', tmpDir]);

      expect(logSpy).toHaveBeenCalled();
      const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as ReviewState;
      expect(output.cycles).toEqual([]);
      logSpy.mockRestore();
    });

    it('init subcommand reports io_error for nonexistent parent dir', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['init', path.join(tmpDir, 'nonexistent', 'deep')]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('io_error'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('init subcommand reports error when already exists', async () => {
      await initState(tmpDir);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['init', tmpDir]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('already_exists'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('add-cycle subcommand adds cycle', async () => {
      await initState(tmpDir);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const cycle = makeCycle();
      await runCli(['add-cycle', tmpDir, JSON.stringify(cycle)]);

      expect(logSpy).toHaveBeenCalled();
      const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as ReviewState;
      expect(output.cycles).toHaveLength(1);
      logSpy.mockRestore();
    });

    it('add-cycle subcommand reports error for missing json arg', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['add-cycle', tmpDir]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('add-cycle subcommand reports error for invalid json', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['add-cycle', tmpDir, '{bad json']);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('add-cycle subcommand reports error when state.json missing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['add-cycle', tmpDir, JSON.stringify(makeCycle())]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('file_not_found'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('get subcommand outputs state', async () => {
      await initState(tmpDir);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runCli(['get', tmpDir]);

      expect(logSpy).toHaveBeenCalled();
      const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as ReviewState;
      expect(output.cycles).toEqual([]);
      logSpy.mockRestore();
    });

    it('get subcommand reports error when state.json missing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['get', '/nonexistent/path']);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('file_not_found'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('get subcommand reports error for corrupt state.json', async () => {
      await fs.writeFile(path.join(tmpDir, 'state.json'), 'not json', 'utf-8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['get', tmpDir]);
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('invalid_state'));
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });

    it('summary subcommand outputs human-readable text', async () => {
      await initState(tmpDir);
      await addCycle(tmpDir, makeCycle());
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runCli(['summary', tmpDir]);

      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('Review State Summary');
      expect(output).toContain('Total cycles: 1');
      logSpy.mockRestore();
    });

    it('summary subcommand reports error when state.json missing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await runCli(['summary', '/nonexistent/path']);
      expect(process.exitCode).toBe(1);
      errorSpy.mockRestore();
      process.exitCode = undefined as unknown as number;
    });
  });
});
