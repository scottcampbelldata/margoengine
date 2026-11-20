// GAP-FILM-TIME class check. A film rendered scene by scene starts each scene in a fresh process and seeks its world
// to the scene's film time by replaying every clock's `advanceTime(delta)` (@margoengine/cutscene/seek). Two kinds of
// package source break that, and this check lists them:
// - `delta`: a field that adds up frame deltas (`this.x += delta * speed`) in a file with no `advanceTime`: a seek
//   cannot move that clock, so it restarts at every cut.
// - `wall`: `performance.now()`, `Date.now()` or `Math.random()`: drawn output that follows the wall clock or an
//   unseeded draw differs between two runs of the same frame.
// Not every hit is a defect (a load timer, an id, a debug stat), so each reviewed one is listed with its reason in
// scripts/film-time-reviewed.json ({ "<path>": { "delta" | "wall": "<reason>" } }). Since the sweep of GAP-FILM-TIME
// commit 7 a hit that is not reviewed fails (exit 1); tests/film-time.test.js fails on it in verify too.
//   node scripts/check-film-time.mjs [--json]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const REVIEWED = join(root, 'scripts/film-time-reviewed.json');

// `this.clock += delta`, `this.a.b += dt * k`, `this.#t += frameDelta`, `state[i] += delta`: a field, not a local.
// Also a field set from an expression that reads the same field and a delta, in any order and wrapped in any call:
// `this.x = (this.x + wind * delta) % repeat`, `this.t = Math.min(1e7, this.t + delta)` (a clamp),
// `this.f = goal + (this.f - goal) * Math.exp(-rate * dt)` (an ease toward a goal), `this.h = Math.max(0, this.h - dt)`
// (a countdown). KB-FILM-SCANGAP1: this form matched only `this.x = (this.x + ... delta`, with the field first.
const DELTA =
  /(?:\bthis\.|#)[\w.#[\]]*\s*\+=\s*[^;\n]*\b(?:delta|dt|frameDelta|deltaTime)\b|\bthis\.([\w.#[\]]+)\s*=(?!=)(?=[^;\n]*\bthis\.\1(?![\w$]))(?=[^;\n]*\b(?:delta|dt|frameDelta|deltaTime)\b)/;
const WALL = /\b(?:performance\.now|Date\.now|Math\.random)\s*\(/;
// Comments say what code does; only code counts.
const strip = (line) => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

/** The hits in one source text: line numbers (from 1) per rule. A file with `advanceTime` has no `delta` hits. */
export function scanSource(text) {
  const lines = text.split(/\r?\n/),
    seekable = /\badvanceTime\s*\(/.test(text),
    hits = { delta: [], wall: [] };
  let block = false;
  lines.forEach((raw, i) => {
    let line = raw;
    if (block) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      block = false;
    }
    const open = line.indexOf('/*');
    if (open >= 0 && line.indexOf('*/', open) < 0) {
      line = line.slice(0, open);
      block = true;
    }
    line = strip(line);
    if (!seekable && DELTA.test(line)) hits.delta.push(i + 1);
    if (WALL.test(line)) hits.wall.push(i + 1);
  });
  return hits;
}

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

/** Every hit in packages/<name>/src, with whether it is on the reviewed list. */
export function scanPackages(base = root) {
  const reviewed = existsSync(join(base, 'scripts/film-time-reviewed.json'))
      ? JSON.parse(readFileSync(join(base, 'scripts/film-time-reviewed.json'), 'utf8'))
      : {},
    found = [];
  for (const pkg of readdirSync(join(base, 'packages')).sort()) {
    const src = join(base, 'packages', pkg, 'src');
    if (!existsSync(src)) continue;
    for (const path of sources(src)) {
      const file = relative(base, path).replaceAll('\\', '/'),
        hits = scanSource(readFileSync(path, 'utf8'));
      for (const rule of /** @type {const} */ (['delta', 'wall']))
        if (hits[rule].length) found.push({ file, rule, lines: hits[rule], reason: reviewed[file]?.[rule] ?? null });
    }
  }
  return { found, reviewed };
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/').replace(/^\//, '')}`) {
  const { found } = scanPackages(),
    open = found.filter((hit) => !hit.reason);
  if (process.argv.includes('--json')) console.log(JSON.stringify(open, null, 1));
  else {
    for (const hit of open) console.log(`${hit.rule}\t${hit.file}:${hit.lines.join(',')}`);
    const by = (rule) => open.filter((hit) => hit.rule === rule).length;
    console.log(
      `film-time: ${open.length} unreviewed (${by('delta')} delta files, ${by('wall')} wall files), ${found.length - open.length} reviewed`,
    );
  }
  if (open.length) process.exitCode = 1;
}
