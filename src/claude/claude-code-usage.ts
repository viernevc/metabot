/**
 * Aggregate Claude Code token usage from local transcript JSONL files under
 * ~/.claude/projects or ~/.config/claude/projects (see Claude Code docs).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

export type ClaudeUsageAggregateRow = {
  date: string;
  model: string;
  /** input_tokens + cache_read + cache_creation */
  inputTotal: number;
  output: number;
  cacheHit: number;
  /** input_tokens + cache_creation_input_tokens */
  cacheMiss: number;
};

export type ClaudeUsageQueryResult = {
  rows: ClaudeUsageAggregateRow[];
  scannedFiles: number;
  projectRoots: string[];
  /** When filtering by path: matched transcript directory */
  matchedProjectDir: string | null;
};

/** Match Claude Code's on-disk project folder naming (lossy; directory scan fallback helps). */
export function encodeClaudeProjectDirName(absPath: string): string {
  const resolved = path.resolve(absPath);
  const unified = resolved.replace(/\\/g, '/');
  const win = unified.match(/^([a-zA-Z]):\/(.*)$/);
  if (win && win[2] !== undefined) {
    const drive = win[1]!.toUpperCase();
    const rest = win[2].replace(/\//g, '-');
    return `${drive}--${rest}`;
  }
  if (unified.startsWith('/')) {
    return unified.replace(/\//g, '-');
  }
  return unified.replace(/\//g, '-');
}

export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Positional args: optional project path + optional `YYYY-MM-DD` dates (stripped from the string).
 * - No dates → today only.
 * - One date → that single day.
 * - Two or more dates → range from min to max date string.
 */
export function parseUsageArgs(args: string): { projectPath?: string; startDate: string; endDate: string } {
  const trimmed = args.trim().replace(/\s+/g, ' ');
  const dateRegex = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const dates: string[] = [];
  const rest = trimmed
    .replace(dateRegex, (_, d: string) => {
      dates.push(d);
      return ' ';
    })
    .trim();

  const today = localDateString(new Date());
  let startDate: string;
  let endDate: string;
  if (dates.length === 0) {
    startDate = endDate = today;
  } else if (dates.length === 1) {
    startDate = endDate = dates[0]!;
  } else {
    const sorted = [...dates].sort();
    startDate = sorted[0]!;
    endDate = sorted[sorted.length - 1]!;
  }

  const projectPath = rest.length > 0 ? rest : undefined;
  return { projectPath, startDate, endDate };
}

/**
 * Directories scanned for Claude Code `*.jsonl` transcripts (used by `/usage`).
 *
 * Unless `METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY` excludes them, always considers:
 * - `CLAUDE_CONFIG_DIR/projects` when set (matches Claude Code)
 * - `~/.claude/projects`, `~/.config/claude/projects`
 *
 * Env: `METABOT_CLAUDE_USAGE_PROJECT_DIRS` — comma-separated extra roots (prepended, deduped).
 * Env: `METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY` — `1`/`true` uses only dirs from
 * `METABOT_CLAUDE_USAGE_PROJECT_DIRS` (no defaults); if that list is empty, defaults apply.
 */
export function getClaudeUsageProjectRoots(): string[] {
  const extraRaw = process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS?.trim();
  const onlyCustom =
    process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY === '1'
    || /^true$/i.test(process.env.METABOT_CLAUDE_USAGE_PROJECT_DIRS_ONLY ?? '');

  const roots: string[] = [];
  if (extraRaw) {
    for (const part of extraRaw.split(',')) {
      const p = part.trim();
      if (p) roots.push(path.resolve(p));
    }
  }

  const useDefaults = !onlyCustom || !extraRaw;
  if (useDefaults) {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (cfg) roots.push(path.join(cfg, 'projects'));
    roots.push(path.join(os.homedir(), '.claude', 'projects'));
    roots.push(path.join(os.homedir(), '.config', 'claude', 'projects'));
  }

  return [...new Set(roots)];
}

function listJsonlFilesRecursive(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonlFilesRecursive(p, acc);
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
  }
}

function findProjectTranscriptDir(projectRoots: string[], absProjectPath: string): string | null {
  const encoded = encodeClaudeProjectDirName(absProjectPath);
  for (const root of projectRoots) {
    if (!fs.existsSync(root)) continue;
    const direct = path.join(root, encoded);
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    const hit = dirs.find((d) => d.toLowerCase() === encoded.toLowerCase());
    if (hit) {
      const candidate = path.join(root, hit);
      if (fs.statSync(candidate).isDirectory()) return candidate;
    }
  }
  return null;
}

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function looksLikeUsage(u: unknown): u is RawUsage {
  if (!u || typeof u !== 'object') return false;
  const o = u as RawUsage;
  return (
    typeof o.input_tokens === 'number'
    || typeof o.output_tokens === 'number'
    || typeof o.cache_read_input_tokens === 'number'
    || typeof o.cache_creation_input_tokens === 'number'
  );
}

function extractUsagePayload(obj: Record<string, unknown>): { usage: RawUsage; model?: string; isoTime?: string } | null {
  if (!shouldRecordUsage(obj)) return null;

  const isoTime =
    (typeof obj.timestamp === 'string' && obj.timestamp) ||
    (typeof obj.created_at === 'string' && obj.created_at) ||
    (typeof obj.time === 'string' && obj.time) ||
    undefined;

  // Assistant transcript shape
  if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object') {
    const msg = obj.message as Record<string, unknown>;
    const usage = msg.usage;
    if (looksLikeUsage(usage)) {
      const model = typeof msg.model === 'string' ? msg.model : undefined;
      return { usage, model, isoTime };
    }
  }

  // Top-level usage (some builds)
  if (looksLikeUsage(obj.usage)) {
    const model = typeof obj.model === 'string' ? obj.model : undefined;
    return { usage: obj.usage as RawUsage, model, isoTime };
  }

  // Stream events (Agent SDK / Claude Code)
  if (obj.event && typeof obj.event === 'object') {
    const ev = obj.event as Record<string, unknown>;
    if (ev.type === 'message_start' && ev.message && typeof ev.message === 'object') {
      const inner = ev.message as Record<string, unknown>;
      const usage = inner.usage;
      if (looksLikeUsage(usage)) {
        const model = typeof inner.model === 'string' ? inner.model : undefined;
        return { usage: usage as RawUsage, model, isoTime };
      }
    }
  }

  // Result / summary shapes
  if (obj.result && typeof obj.result === 'object') {
    const r = obj.result as Record<string, unknown>;
    if (looksLikeUsage(r.usage)) {
      const model = typeof r.model === 'string' ? r.model : undefined;
      return { usage: r.usage as RawUsage, model, isoTime };
    }
  }

  return null;
}

function shouldRecordUsage(obj: Record<string, unknown>): boolean {
  if (obj.type === 'message_delta') return false;
  if (obj.event && typeof obj.event === 'object') {
    const et = (obj.event as Record<string, unknown>).type;
    if (et === 'message_delta') return false;
  }
  return true;
}

function dateFromIso(iso: string | undefined, fallback: Date): string {
  if (!iso) return localDateString(fallback);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return localDateString(fallback);
  return localDateString(new Date(t));
}

async function processJsonlFile(
  filePath: string,
  startDate: string,
  endDate: string,
  onRow: (row: ClaudeUsageAggregateRow) => void,
): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const payload = extractUsagePayload(obj as Record<string, unknown>);
    if (!payload) continue;

    const u = payload.usage;
    const inputTok = num(u.input_tokens);
    const outTok = num(u.output_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreate = num(u.cache_creation_input_tokens);

    // Skip empty fragments (e.g. partial stream chunks with only zeros)
    if (!inputTok && !outTok && !cacheRead && !cacheCreate) continue;

    const date = dateFromIso(payload.isoTime, new Date());
    if (date < startDate || date > endDate) continue;

    const model = payload.model?.trim() || '(unknown)';
    const cacheMiss = inputTok + cacheCreate;
    const inputTotal = cacheMiss + cacheRead;

    onRow({
      date,
      model,
      inputTotal,
      output: outTok,
      cacheHit: cacheRead,
      cacheMiss,
    });
  }
}

/** Banking-style integer display (e.g. `1,234,567`). */
export function formatUsageTokenAmount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** One row per (date, model); tokens summed for that pair. Sort: newest date first, then model name. */
export function mergeUsageRows(rows: Iterable<ClaudeUsageAggregateRow>): ClaudeUsageAggregateRow[] {
  const map = new Map<string, ClaudeUsageAggregateRow>();
  for (const r of rows) {
    const key = `${r.date}\x00${r.model}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r });
    } else {
      prev.inputTotal += r.inputTotal;
      prev.output += r.output;
      prev.cacheHit += r.cacheHit;
      prev.cacheMiss += r.cacheMiss;
    }
  }
  return [...map.values()].sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    return byDate !== 0 ? byDate : a.model.localeCompare(b.model);
  });
}

export type UsageSummaryNumbers = {
  inputTotal: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
};

/** Per-day bucket: totals plus per-model rows (models sorted by name). Dates sorted newest first. */
export type UsageDateGroup = {
  date: string;
  summary: UsageSummaryNumbers;
  byModel: ClaudeUsageAggregateRow[];
};

export function groupUsageRowsByDate(rows: ClaudeUsageAggregateRow[]): UsageDateGroup[] {
  const byDate = new Map<string, ClaudeUsageAggregateRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  return dates.map((date) => {
    const models = [...(byDate.get(date) ?? [])].sort((a, b) => a.model.localeCompare(b.model));
    const summary = models.reduce(
      (acc, m) => ({
        inputTotal: acc.inputTotal + m.inputTotal,
        output: acc.output + m.output,
        cacheHit: acc.cacheHit + m.cacheHit,
        cacheMiss: acc.cacheMiss + m.cacheMiss,
      }),
      { inputTotal: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
    );
    return { date, summary, byModel: models };
  });
}

export async function aggregateClaudeCodeUsage(options: {
  projectPath?: string;
  startDate: string;
  endDate: string;
}): Promise<ClaudeUsageQueryResult> {
  const projectRoots = getClaudeUsageProjectRoots().filter((p) => fs.existsSync(p));
  const jsonlFiles: string[] = [];
  let matchedProjectDir: string | null = null;

  if (options.projectPath) {
    matchedProjectDir = findProjectTranscriptDir(projectRoots, options.projectPath);
    if (!matchedProjectDir) {
      return { rows: [], scannedFiles: 0, projectRoots, matchedProjectDir: null };
    }
    listJsonlFilesRecursive(matchedProjectDir, jsonlFiles);
  } else {
    for (const root of projectRoots) {
      listJsonlFilesRecursive(root, jsonlFiles);
    }
  }

  const collected: ClaudeUsageAggregateRow[] = [];

  for (const file of jsonlFiles) {
    await processJsonlFile(file, options.startDate, options.endDate, (partial) => {
      collected.push({
        date: partial.date,
        model: partial.model,
        inputTotal: partial.inputTotal,
        output: partial.output,
        cacheHit: partial.cacheHit,
        cacheMiss: partial.cacheMiss,
      });
    });
  }

  return {
    rows: mergeUsageRows(collected),
    scannedFiles: jsonlFiles.length,
    projectRoots,
    matchedProjectDir,
  };
}

export function formatClaudeUsageMarkdown(result: ClaudeUsageQueryResult): string {
  const lines: string[] = [];
  if (result.rows.length === 0) {
    lines.push('_所选日期范围内没有匹配的用量记录。_');
    lines.push('');
    lines.push(
      `已扫描 **${result.scannedFiles}** 个 JSONL 文件。数据目录：${result.projectRoots.length ? result.projectRoots.map((p) => `\`${p}\``).join('，') : '_未找到 Claude Code projects 目录_'}`,
    );
    return lines.join('\n');
  }

  lines.push(
    '| 日期 | Model | 输入token | 输出token | 输入（命中缓存） | 输入（未命中缓存） | 总token |',
  );
  lines.push('| --- | --- | ---:| ---:| ---:| ---:| ---:|');

  for (const r of result.rows) {
    const total = r.inputTotal + r.output;
    const modelCell =
      r.model.length > 56 ? `${r.model.slice(0, 26)}…${r.model.slice(-26)}` : r.model;
    const i = formatUsageTokenAmount(r.inputTotal);
    const o = formatUsageTokenAmount(r.output);
    const ch = formatUsageTokenAmount(r.cacheHit);
    const cm = formatUsageTokenAmount(r.cacheMiss);
    const t = formatUsageTokenAmount(total);
    lines.push(
      `| ${r.date} | ${modelCell.replace(/\|/g, '\\|')} | ${i} | ${o} | ${ch} | ${cm} | ${t} |`,
    );
  }

  lines.push('');
  lines.push(
    '- **输入token** = 输入侧合计（含缓存读写）；**输入（命中缓存）** = cache read；**输入（未命中缓存）** = input + cache creation；**总token** = 输入token + 输出token',
  );
  lines.push(`- **扫描文件数：** ${result.scannedFiles}`);
  return lines.join('\n');
}
