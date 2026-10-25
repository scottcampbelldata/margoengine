// Generated files that every landing rewrites, and how a rebase treats them (AGENTS.md, "Generated records").
//   DERIVED  are pure output of a command (the API reports, the two size records). When both sides of a rebase changed
//            one, the merge driver keeps the side already on main; scripts/land-records.mjs then regenerates it from the
//            rebased tree, so the source of truth is always the code, never a textual merge of two measurements.
//   RATCHET  are the quality baselines. They hold reasoned history and limits that may only shrink, so they are merged
//            key by key, never regenerated blindly (mergeRatchet).
import { execFileSync } from 'node:child_process';

/** Paths (git pathspecs) of the files that are pure command output. */
export const DERIVED = [
  'api/*.api.md',
  'docs/api-surface.md',
  'site/llms.txt',
  'site/llms-full.txt',
  'examples/package-benchmarks/results/entry-sizes.json',
  'examples/package-benchmarks/results/basic-scene-network.json',
];

/** Pathspec of the ratcheting quality baselines. */
export const RATCHET = ['scripts/quality/baselines/*.json'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of two quality baselines ({ gate, about, total, history, items }) that both changed since `base`.
 * Ratchet rules: an item changed on one side takes that side; changed on both, the smaller limit wins (a limit only
 * ever shrinks here, so growth that one side justified in `history` is re-checked by `npm run quality` afterwards and
 * is never silently widened by a merge); an item removed on one side (its violation was fixed) stays removed. History
 * keeps every reasoned entry from both sides, base order first. `total` is recomputed.
 */
export function mergeRatchet(base, ours, theirs) {
  const b = base?.items ?? {},
    o = ours.items ?? {},
    t = theirs.items ?? {};
  const items = {};
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])].sort()) {
    let value;
    if (o[key] === t[key]) value = o[key];
    else if (o[key] === b[key]) value = t[key];
    else if (t[key] === b[key]) value = o[key];
    else if (o[key] === undefined || t[key] === undefined) value = undefined;
    else value = Math.min(o[key], t[key]);
    if (value !== undefined) items[key] = value;
  }
  const seen = new Set(),
    history = [];
  for (const entry of [...(base?.history ?? []), ...(ours.history ?? []), ...(theirs.history ?? [])]) {
    const id = JSON.stringify(entry);
    if (!seen.has(id)) {
      seen.add(id);
      history.push(entry);
    }
  }
  const pick = (key) => (!same(ours[key], base?.[key]) ? ours[key] : theirs[key]);
  const extra = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)]))
    if (!['gate', 'about', 'total', 'history', 'items'].includes(key)) extra[key] = pick(key);
  return {
    gate: pick('gate'),
    about: pick('about'),
    total: Object.values(items).reduce((sum, value) => sum + value, 0),
    history,
    items,
    ...extra,
  };
}

/** The `git status --porcelain` lines of the derived and ratcheting paths; [] when they are clean. */
export function changedRecords(cwd) {
  const out = execFileSync('git', ['status', '--porcelain', '--', ...DERIVED, ...RATCHET], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}
