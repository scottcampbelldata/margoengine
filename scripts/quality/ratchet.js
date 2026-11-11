// Baselines for the quality gate (scripts/quality-gate.mjs). One JSON per gate in scripts/quality/baselines/:
//   { gate, about, history: [{ date, commit, reason }], items: { key: limit } }
// An item is one known violation (a count or a byte budget). The gate fails when a key is new or its measured value is
// over its limit. Shrinking is free (`--update`); growing a limit or adding a key needs `--update --reason="..."`, which
// appends the reason to `history`, so every growth is explained in the file.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASELINES = 'scripts/quality/baselines';

/** The baseline of `gate`, or an empty one. */
export function readBaseline(root, gate) {
  const file = join(root, BASELINES, `${gate}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { gate, about: '', history: [], items: {} };
}

/**
 * Compares measured values with a baseline. `allowance(value)` is the limit a fresh measurement earns (the value itself
 * for counts, value + headroom for sizes). Returns the failures (new or worse items) and the items whose limit could
 * shrink.
 */
export function compare(measured, baseline, allowance = (v) => v) {
  const worse = [];
  const better = [];
  for (const [key, value] of Object.entries(measured)) {
    const limit = baseline.items[key];
    if (limit === undefined) worse.push({ key, value, limit: null });
    else if (value > limit) worse.push({ key, value, limit });
    else if (allowance(value, key) < limit) better.push({ key, value, limit });
  }
  for (const [key, limit] of Object.entries(baseline.items))
    if (!(key in measured)) better.push({ key, value: 0, limit });
  return { worse, better };
}

/**
 * The sum a baseline's `total` must hold, when it holds another (a hand-settled merge that added the growth instead of
 * summing the items); undefined when the total is right or absent. `updateBaseline` always writes the true sum.
 */
export function staleTotal(baseline) {
  if (baseline.total === undefined) return undefined;
  const sum = Object.values(baseline.items).reduce((a, b) => a + b, 0);
  return baseline.total === sum ? undefined : sum;
}

function headCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Writes the shrunk (and, with a reason, grown) baseline. Throws without a reason when anything would grow. A `frozen`
 * key was measured from a stale build: it keeps its recorded limit (neither shrinks nor grows), and a frozen key with
 * no limit throws, since a stale build cannot set one.
 */
export function updateBaseline(
  root,
  gate,
  about,
  measured,
  baseline,
  { allowance = (v) => v, reason, frozen = () => false } = {},
) {
  const items = {};
  const grown = [];
  const unmeasurable = Object.keys(measured).filter((k) => frozen(k) && baseline.items[k] === undefined);
  if (unmeasurable.length)
    throw new Error(
      `${gate}: ${unmeasurable.length} new item(s) come from a stale build (${unmeasurable.slice(0, 5).join('; ')}); ` +
        'rebuild those packages (npm run build:packages) and rerun the update',
    );
  for (const key of Object.keys(measured).sort()) {
    const value = measured[key];
    const limit = baseline.items[key];
    if (frozen(key)) {
      items[key] = limit;
      continue;
    }
    if (limit === undefined || value > limit) grown.push(key);
    items[key] = limit === undefined || value > limit ? allowance(value, key) : Math.min(limit, allowance(value, key));
  }
  if (grown.length && !reason)
    throw new Error(
      `${gate}: ${grown.length} item(s) would grow the baseline (${grown.slice(0, 5).join('; ')}${grown.length > 5 ? '; ...' : ''}); ` +
        `fix them, or rerun with --update --reason="why this growth is accepted"`,
    );
  const history = [...(baseline.history ?? [])];
  if (grown.length || !history.length)
    history.push({
      date: new Date().toISOString().slice(0, 10),
      commit: headCommit(root),
      reason: reason ?? 'Shrink only',
      grew: grown.length,
    });
  const next = { gate, about, total: Object.values(items).reduce((a, b) => a + b, 0), history, items };
  writeFileSync(join(root, BASELINES, `${gate}.json`), JSON.stringify(next, null, 2) + '\n');
  return { grown, count: Object.keys(items).length };
}
