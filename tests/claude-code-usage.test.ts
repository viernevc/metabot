import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  encodeClaudeProjectDirName,
  formatUsageTokenAmount,
  getClaudeUsageProjectRoots,
  groupUsageRowsByDate,
  mergeUsageRows,
  parseUsageArgs,
} from '../src/claude/claude-code-usage.js';

describe('claude-code-usage', () => {
  it('encodeClaudeProjectDirName matches Claude-style paths', () => {
    expect(encodeClaudeProjectDirName('C:\\git\\cc-plus')).toBe('C--git-cc-plus');
    if (os.platform() !== 'win32') {
      expect(encodeClaudeProjectDirName('/Users/foo/bar')).toBe('-Users-foo-bar');
    }
  });

  it('formatUsageTokenAmount uses comma grouping', () => {
    expect(formatUsageTokenAmount(1234567)).toBe('1,234,567');
    expect(formatUsageTokenAmount(999)).toBe('999');
    expect(formatUsageTokenAmount(1000)).toBe('1,000');
  });

  it('parseUsageArgs picks dates and remainder path', () => {
    const a = parseUsageArgs('');
    expect(a.startDate).toBe(a.endDate);

    const b = parseUsageArgs('2026-03-01 2026-03-05');
    expect(b.projectPath).toBeUndefined();
    expect(b.startDate).toBe('2026-03-01');
    expect(b.endDate).toBe('2026-03-05');

    const c = parseUsageArgs('/tmp/proj 2026-01-02');
    expect(c.projectPath).toBe('/tmp/proj');
    expect(c.startDate).toBe('2026-01-02');
    expect(c.endDate).toBe('2026-01-02');
  });

  it('getClaudeUsageProjectRoots respects METABOT_CLAUDE_USAGE_PROJECT_DIRS', () => {
    const a = path.join(os.tmpdir(), 'metabot-usage-extra-a');
    const b = path.join(os.tmpdir(), 'metabot-usage-extra-b');
    const prevDirs = process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS;
    const prevOnly = process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY;
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS = `${a},${b}`;
      delete process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY;
      const roots = getClaudeUsageProjectRoots();
      const ia = roots.indexOf(path.resolve(a));
      const ib = roots.indexOf(path.resolve(b));
      expect(ia).toBeGreaterThanOrEqual(0);
      expect(ib).toBeGreaterThan(ia);
      expect(roots.some((r) => r.includes('.claude'))).toBe(true);
    } finally {
      if (prevDirs === undefined) delete process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS;
      else process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS = prevDirs;
      if (prevOnly === undefined) delete process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY;
      else process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY = prevOnly;
      if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    }
  });

  it('mergeUsageRows sums by date and model; date desc then model asc', () => {
    const merged = mergeUsageRows([
      {
        date: '2026-05-01',
        model: 'm',
        inputTotal: 10,
        output: 2,
        cacheHit: 3,
        cacheMiss: 7,
      },
      {
        date: '2026-05-01',
        model: 'm',
        inputTotal: 5,
        output: 1,
        cacheHit: 1,
        cacheMiss: 4,
      },
      {
        date: '2026-05-03',
        model: 'other',
        inputTotal: 1,
        output: 1,
        cacheHit: 0,
        cacheMiss: 1,
      },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.date).toBe('2026-05-03');
    expect(merged[1]!.date).toBe('2026-05-01');
    expect(merged[1]!.model).toBe('m');
    expect(merged[1]!.inputTotal).toBe(15);
    expect(merged[1]!.output).toBe(3);
    expect(merged[1]!.cacheHit).toBe(4);
    expect(merged[1]!.cacheMiss).toBe(11);

    const multi = mergeUsageRows([
      {
        date: '2026-06-01',
        model: 'opus',
        inputTotal: 1,
        output: 1,
        cacheHit: 0,
        cacheMiss: 1,
      },
      {
        date: '2026-06-01',
        model: 'sonnet',
        inputTotal: 2,
        output: 0,
        cacheHit: 0,
        cacheMiss: 2,
      },
    ]);
    expect(multi).toHaveLength(2);
    expect(multi[0]!.model).toBe('opus');
    expect(multi[1]!.model).toBe('sonnet');
    expect(multi.every((r) => r.date === '2026-06-01')).toBe(true);
  });

  it('groupUsageRowsByDate aggregates summary per day', () => {
    const rows = mergeUsageRows([
      {
        date: '2026-06-01',
        model: 'a',
        inputTotal: 10,
        output: 1,
        cacheHit: 2,
        cacheMiss: 8,
      },
      {
        date: '2026-06-01',
        model: 'b',
        inputTotal: 5,
        output: 2,
        cacheHit: 0,
        cacheMiss: 5,
      },
      {
        date: '2026-06-02',
        model: 'a',
        inputTotal: 3,
        output: 1,
        cacheHit: 0,
        cacheMiss: 3,
      },
    ]);
    const groups = groupUsageRowsByDate(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.date).toBe('2026-06-02');
    expect(groups[0]!.summary.inputTotal).toBe(3);
    expect(groups[1]!.summary.inputTotal).toBe(15);
    expect(groups[1]!.byModel).toHaveLength(2);
  });
});
