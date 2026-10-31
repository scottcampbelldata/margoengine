// `npm run check:parity`: the counts written in docs/threejs-parity.md (and quoted in docs/three-parity-matrix.md) must
// equal the rows of its Matrix tables. The summary was typed by hand and drifted once; this recounts it on every verify.
//   node scripts/check-parity-table.mjs            check the real docs, print the counts
// Status vocabulary in the Matrix: COVERED (optionally marked with a dagger), PARTIAL, MISSING, NOT PLANNED.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLASSES = ['COVERED', 'PARTIAL', 'MISSING', 'NOT PLANNED'];

/**
 * Tallies the status column of every Matrix row and reads the numbers the document claims.
 * @param {string} text contents of docs/threejs-parity.md
 */
export function parseParity(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Matrix\b/.test(l));
  if (start < 0) throw new Error('no "## Matrix" heading found');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const unknown = [];
  let rows = 0,
    daggers = 0;
  for (const line of lines.slice(start + 1, end)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const status = cells[2];
    if (status === undefined || /^:?-+:?$/.test(status) || /^status$/i.test(status)) continue;
    rows++;
    const name = status.replace(/\s*†\s*$/, '').toUpperCase();
    if (status.includes('†')) daggers++;
    if (name in counts) counts[name]++;
    else unknown.push(`"${cells[1].slice(0, 60)}" has status "${status}"`);
  }
  const summary = {};
  for (const line of lines.slice(0, start)) {
    let m;
    if ((m = /^\|\s*([A-Z ]+?)\s*\|\s*(\d+)\s*\|/.exec(line)) && m[1] in counts) summary[m[1]] = Number(m[2]);
    if ((m = /^(\d+) three\.js features/.exec(line))) summary.total = Number(m[1]);
    if ((m = /(\d+) of the COVERED rows are marked/.exec(line))) summary.daggers = Number(m[1]);
  }
  const todo = lines.find((l) => /^Recounted from the rows/.test(l));
  const tm = todo && /: (\d+) PARTIAL, (\d+) MISSING/.exec(todo);
  if (tm) summary.todo = { PARTIAL: Number(tm[1]), MISSING: Number(tm[2]) };
  return { rows, counts, daggers, unknown, summary };
}

/**
 * Returns the list of problems (empty when the document is consistent).
 * @param {string} text contents of docs/threejs-parity.md
 * @param {string} [explainer] contents of docs/three-parity-matrix.md, whose bold line quotes the counts
 */
export function checkParity(text, explainer) {
  const { rows, counts, daggers, unknown, summary } = parseParity(text);
  const problems = unknown.map((u) => `unknown status: ${u}; use one of ${CLASSES.join(', ')}`);
  const sum = CLASSES.reduce((n, c) => n + counts[c], 0);
  if (sum !== rows) problems.push(`status classes add up to ${sum} but the Matrix has ${rows} rows`);
  const tally = CLASSES.map((c) => `${counts[c]} ${c}`).join(', ');
  for (const c of CLASSES) {
    if (summary[c] === undefined) {
      if (counts[c] > 0) problems.push(`the Summary table has no ${c} row; rows count ${counts[c]}`);
    } else if (summary[c] !== counts[c]) problems.push(`Summary says ${summary[c]} ${c}, rows count ${counts[c]}`);
  }
  if (summary.total !== rows) problems.push(`Summary says ${summary.total ?? 'no'} features, rows count ${rows}`);
  if (summary.daggers !== undefined && summary.daggers !== daggers)
    problems.push(`Summary says ${summary.daggers} rows are marked †, rows count ${daggers}`);
  if (summary.todo) {
    for (const c of ['PARTIAL', 'MISSING'])
      if (summary.todo[c] !== counts[c])
        problems.push(`"Recounted from the rows" says ${summary.todo[c]} ${c}, rows count ${counts[c]}`);
  } else problems.push('the "Recounted from the rows: N PARTIAL, N MISSING" line is missing or malformed');
  if (explainer !== undefined) {
    const m = /\*\*(\d+) features, (\d+) COVERED, (\d+) PARTIAL, (\d+) MISSING\*\*/.exec(explainer);
    if (!m) problems.push('three-parity-matrix.md has no "**N features, N COVERED, N PARTIAL, N MISSING**" line');
    else if (+m[1] !== rows || +m[2] !== counts.COVERED || +m[3] !== counts.PARTIAL || +m[4] !== counts.MISSING)
      problems.push(
        `three-parity-matrix.md says ${m[1]} / ${m[2]} / ${m[3]} / ${m[4]}, rows count ${rows} / ${counts.COVERED} / ${counts.PARTIAL} / ${counts.MISSING}`,
      );
  }
  if (problems.length)
    problems.push(
      `rows count: ${rows} features = ${tally}. Fix the text to match the rows (never edit a row's status to fit the text).`,
    );
  return problems;
}

/**
 * Names in the document that must be real: backticked repository paths, @margoengine packages, and the pages rows link
 * to. Stale names were how the old table drifted. Example names of the other engine stay private (the map is private),
 * so a `webgl_...` or `webgpu_...` name fails too, except the one row title that quotes a public feature name.
 * @param {string} text contents of docs/threejs-parity.md
 * @param {(path: string) => boolean} exists whether a repository path exists
 */
export function checkReferences(text, exists) {
  const problems = [];
  for (const [, path] of text.matchAll(/`((?:packages|scripts|examples)\/[\w./-]+)`/g))
    if (!exists(path)) problems.push(`${path} does not exist`);
  for (const [, name] of text.matchAll(/@margoengine\/([a-z0-9-]+)/g))
    if (!exists(`packages/${name}`)) problems.push(`@margoengine/${name} does not exist`);
  for (const [, page] of text.matchAll(/\[page\]\(https:\/\/margoengine\.com(\/[^)]*)\)/g)) {
    const source = pageSource(page);
    if (!source || !exists(source)) problems.push(`the page ${page} has no source (${source ?? 'unknown folder'})`);
  }
  for (const [name] of text.matchAll(/\bweb(?:gl|gpu|xr|audio)_[a-z0-9_]+/g))
    if (name !== 'webgpu_volume_lighting') problems.push(`${name} is an example name; the public table is by feature`);
  return [...new Set(problems)];
}

/** The repository source of a site page path (scripts/build-site.js), or undefined. */
export function pageSource(page) {
  const folders = {
    '/voxel/': 'examples/voxel-sandbox',
    '/night-citadel/': 'apps/showcase-night-citadel',
    '/gameplay-sandbox/': 'examples/gameplay-sandbox',
  };
  if (folders[page]) return folders[page];
  let m = /^\/gallery\/([a-z0-9-]+)\.html$/.exec(page);
  if (m) return `examples/gallery/${m[1]}.html`;
  m = /^\/demos\/([a-z0-9-]+)\.html$/.exec(page);
  if (m) return `examples/${m[1]}.html`;
  m = /^\/demos\/(dof|tonemap|animator)\/$/.exec(page);
  if (m) return `packages/${m[1]}/examples`;
  return undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const text = readFileSync(resolve(root, 'docs/threejs-parity.md'), 'utf8');
  const explainer = readFileSync(resolve(root, 'docs/three-parity-matrix.md'), 'utf8');
  const { rows, counts, daggers } = parseParity(text);
  console.log(
    `threejs-parity: ${rows} rows = ${CLASSES.map((c) => `${counts[c]} ${c}`).join(', ')} (${daggers} marked †)`,
  );
  const problems = [
    ...checkParity(text, explainer),
    ...checkReferences(text, (path) => existsSync(resolve(root, path))),
  ];
  if (problems.length) {
    for (const p of problems) console.error(`check:parity: ${p}`);
    process.exit(1);
  }
}
