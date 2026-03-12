import { describe, it, expect } from 'vitest';
import type { Finding } from '../src/types.js';
import { planParallelism, processCliInput } from '../src/parallelism-planner.js';
import type { PlanError } from '../src/parallelism-planner.js';

function makeFinding(overrides: Partial<Finding> & { index: number; file: string }): Finding {
  return {
    title: `Finding ${overrides.index}`,
    severity: 'advisory',
    line: null,
    issue: 'Some issue',
    suggestion: 'Some suggestion',
    action: null,
    humanNotes: null,
    ...overrides,
  };
}

describe('planParallelism', () => {
  it('should return an error for empty findings array', () => {
    const result = planParallelism([]);

    expect(result.isErr()).toBe(true);
    result.match(
      () => {
        throw new Error('Expected error');
      },
      (error: PlanError) => {
        expect(error.reason).toBe('empty_findings');
        expect(error.message).toBeTruthy();
      },
    );
  });

  it('should create a single stream for a single finding', () => {
    const finding = makeFinding({ index: 1, file: 'src/app.ts' });
    const result = planParallelism([finding]);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(1);
    expect(plan.parallelStreams).toBe(1);
    expect(plan.sequentialStreams).toBe(0);
    expect(plan.streams).toHaveLength(1);
    expect(plan.streams[0]!.id).toBe(1);
    expect(plan.streams[0]!.findings).toEqual([finding]);
    expect(plan.streams[0]!.files).toEqual(['src/app.ts']);
    expect(plan.streams[0]!.canParallelize).toBe(true);
  });

  it('should create separate parallel streams for findings in different files', () => {
    const f1 = makeFinding({ index: 1, file: 'src/a.ts' });
    const f2 = makeFinding({ index: 2, file: 'src/b.ts' });
    const f3 = makeFinding({ index: 3, file: 'src/c.ts' });

    const result = planParallelism([f1, f2, f3]);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(3);
    expect(plan.parallelStreams).toBe(3);
    expect(plan.sequentialStreams).toBe(0);
    expect(plan.streams).toHaveLength(3);

    expect(plan.streams[0]!.files).toEqual(['src/a.ts']);
    expect(plan.streams[0]!.findings).toEqual([f1]);
    expect(plan.streams[1]!.files).toEqual(['src/b.ts']);
    expect(plan.streams[1]!.findings).toEqual([f2]);
    expect(plan.streams[2]!.files).toEqual(['src/c.ts']);
    expect(plan.streams[2]!.findings).toEqual([f3]);
  });

  it('should group findings touching the same file into one stream', () => {
    const f1 = makeFinding({ index: 1, file: 'src/shared.ts', line: 10 });
    const f2 = makeFinding({ index: 2, file: 'src/shared.ts', line: 20 });
    const f3 = makeFinding({ index: 3, file: 'src/shared.ts', line: 30 });

    const result = planParallelism([f1, f2, f3]);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(1);
    expect(plan.parallelStreams).toBe(1);
    expect(plan.sequentialStreams).toBe(0);
    expect(plan.streams[0]!.findings).toEqual([f1, f2, f3]);
    expect(plan.streams[0]!.files).toEqual(['src/shared.ts']);
  });

  it('should handle a mix of same-file and different-file findings', () => {
    const f1 = makeFinding({ index: 1, file: 'src/a.ts' });
    const f2 = makeFinding({ index: 2, file: 'src/b.ts' });
    const f3 = makeFinding({ index: 3, file: 'src/a.ts' });
    const f4 = makeFinding({ index: 4, file: 'src/c.ts' });
    const f5 = makeFinding({ index: 5, file: 'src/b.ts' });

    const result = planParallelism([f1, f2, f3, f4, f5]);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(3);
    expect(plan.parallelStreams).toBe(3);
    expect(plan.sequentialStreams).toBe(0);

    const streamA = plan.streams.find((s) => s.files.includes('src/a.ts'));
    const streamB = plan.streams.find((s) => s.files.includes('src/b.ts'));
    const streamC = plan.streams.find((s) => s.files.includes('src/c.ts'));

    expect(streamA).toBeDefined();
    expect(streamA!.findings).toEqual([f1, f3]);

    expect(streamB).toBeDefined();
    expect(streamB!.findings).toEqual([f2, f5]);

    expect(streamC).toBeDefined();
    expect(streamC!.findings).toEqual([f4]);
  });

  it('should order findings by index within each stream', () => {
    const f3 = makeFinding({ index: 3, file: 'src/a.ts' });
    const f1 = makeFinding({ index: 1, file: 'src/a.ts' });
    const f2 = makeFinding({ index: 2, file: 'src/a.ts' });

    const result = planParallelism([f3, f1, f2]);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    const indices = plan.streams[0]!.findings.map((f) => f.index);
    expect(indices).toEqual([1, 2, 3]);
  });

  it('should assign sequential stream IDs starting from 1', () => {
    const findings = [
      makeFinding({ index: 1, file: 'src/x.ts' }),
      makeFinding({ index: 2, file: 'src/y.ts' }),
      makeFinding({ index: 3, file: 'src/z.ts' }),
    ];

    const result = planParallelism(findings);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    const ids = plan.streams.map((s) => s.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('should set canParallelize to true for all streams', () => {
    const findings = [
      makeFinding({ index: 1, file: 'src/a.ts' }),
      makeFinding({ index: 2, file: 'src/b.ts' }),
    ];

    const result = planParallelism(findings);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    for (const stream of plan.streams) {
      expect(stream.canParallelize).toBe(true);
    }
  });

  it('should handle findings with different severities in the same file', () => {
    const f1 = makeFinding({ index: 1, file: 'src/app.ts', severity: 'blocking' });
    const f2 = makeFinding({ index: 2, file: 'src/app.ts', severity: 'advisory' });

    const result = planParallelism([f1, f2]);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(1);
    expect(plan.streams[0]!.findings).toHaveLength(2);
  });

  it('should handle findings with actions', () => {
    const f1 = makeFinding({ index: 1, file: 'src/a.ts', action: { type: 'approve' } });
    const f2 = makeFinding({ index: 2, file: 'src/b.ts', action: { type: 'modify', notes: 'fix it' } });

    const result = planParallelism([f1, f2]);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(2);
  });
});

describe('processCliInput', () => {
  it('should return error for empty input', () => {
    const result = processCliInput('');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('empty_input');
  });

  it('should return error for whitespace-only input', () => {
    const result = processCliInput('   \n  \t  ');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('empty_input');
  });

  it('should return error for invalid JSON', () => {
    const result = processCliInput('not valid json {{{');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('parse_error');
  });

  it('should return error for non-array JSON', () => {
    const result = processCliInput('{"key": "value"}');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('not_array');
  });

  it('should return error for empty JSON array', () => {
    const result = processCliInput('[]');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('empty_findings');
  });

  it('should return plan for valid findings JSON', () => {
    const findings = [makeFinding({ index: 1, file: 'src/a.ts' }), makeFinding({ index: 2, file: 'src/b.ts' })];

    const result = processCliInput(JSON.stringify(findings));

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(2);
    expect(plan.parallelStreams).toBe(2);
  });

  it('should handle input with leading/trailing whitespace', () => {
    const findings = [makeFinding({ index: 1, file: 'src/a.ts' })];
    const input = '  \n' + JSON.stringify(findings) + '\n  ';

    const result = processCliInput(input);

    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();
    expect(plan.totalStreams).toBe(1);
  });
});
