// Guard: a web demo's source/ never carries its own engine code (Scott, 2026-11-27: "All 236 demos must only use Margo
// solvers and packages otherwise they are not demos showing off the engine's capabilities"; "Nothing should be in a demo
// directly ever."). Plan: private/handoffs/web-demos-migration-plan.md section 5.
//
//   R1  shader text or raw GPU use (WGSL/GLSL, createShaderModule, shader/raw imports, engine.gpu)
//   R2  solvers (time-step updates, step/advance/integrate/simulate/solve functions, physical constants)
//   R3  raw mesh data (position/normal/uv/index arrays, new Geometry(...))
//   R4  local helpers (cross, normalize, mix, lerp, mulberry32, hash, noise, fbm, vector maths)
//   R5  JS lines per demo (code lines, comments and blanks left out); a demo may carry R5_FLOOR lines of wiring free
//   IMP a bare import that is not @margoengine/*, margo-demo-status or a relative path
//
// scripts/web-demos/source-allowlist.json is a ratchet: today's counts per demo and rule. A count may only fall; a
// fallen count must be written down (`node scripts/check-demo-sources.mjs --lower` rewrites the file, never upward).
//
// Tuning notes (patterns were run against the demos the audit marks OK, which must score zero):
//  - Strings and comments are blanked before R2 to R4 match, so prose and slider labels never hit; R1 and IMP read strings
//    because shader text and import specifiers live in them.
//  - R2 constants fire only in arithmetic (`* 9.81`, `viscosity *`), never on `export const gravity = 9.81` or a value
//    handed to a package option, so newtons-cradle (which passes restitution to a collider) scores zero.
//  - R4 flags a definition (function, const arrow, method), never an import of the same name from a package.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'IMP'];
/** Wiring a demo may carry before R5 counts (UI, layout and content data); more than this belongs in a package. */
export const R5_FLOOR = 300;
const FIX = 'use the package that owns it; see demos/README.md';
const root = resolve(import.meta.dirname, '..');
export const demosDir = join(root, 'demos');
export const allowlistPath = join(root, 'scripts', 'web-demos', 'source-allowlist.json');

/**
 * Blanks comments (always) and string contents (unless keepStrings), keeping newlines and offsets, so line numbers hold.
 * A small scanner: quotes end at a newline, regex literals are recognised after an operator, templates may span lines.
 */
export function mask(text, keepStrings = false) {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  let prev = ''; // last significant char, to tell a regex from a division
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        else if (text[j] === '\n' && c !== '`') break;
        j++;
      }
      if (!keepStrings) blank(i + 1, j);
      i = j + 1;
      prev = c;
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join('');
}

const DT = String.raw`(?:dt|dtSeconds|deltaTime|stepTime|timeStep|substep|subDt)`;
const DT_MUL = new RegExp(String.raw`\*\s*${DT}\b|\b${DT}\s*\*`);
const ASSIGN = /(?:^|[^=!<>])(?:[+\-*/]?=)(?![=>])/;
const SOLVER_NAME = String.raw`(?:step|advance|integrate|simulate|solve)(?:[A-Z_]\w*)?`;
const FN_DEF = (name) =>
  new RegExp(
    String.raw`\bfunction\s*\*?\s*${name}\s*\(|\b(?:const|let|var)\s+${name}\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)|^\s*(?:static\s+|async\s+)?${name}\s*\([^)]*\)\s*\{`,
    'm',
  );
const MATH_NAME = String.raw`(?:cross|normali[sz]e|dot|mix|lerp|mulberry32|xorshift\w*|lcg|hash\w*|noise\w*|valueNoise\w*|perlin\w*|simplex\w*|fbm\w*|clampVec\w*|clamp3|(?:add|sub|scale|mul|div|len|length|dist)(?:2|3|4|Vec\w*)|vec[234]\w*|seeded\w*|rng\w*)`;
const MESH_NAME = String.raw`(?:pos(?:ition)?s?|norm(?:al)?s?|uvs?|ind(?:ex|ices)|idx|verts?|vertices|tris|triangles)`;

// Explained exemptions, each a use the demo-status protocol and package wiring need, not engine code:
//  - `engine.gpu.queue.onSubmittedWorkDone()` is the readiness fence and `engine.gpu.adapterInfo` the backend tag every demo
//    reports to margo-demo-status; `if (engine.gpu)` only asks whether a GPU exists. Any other `engine.gpu` use is raw GPU.
const GPU_READINESS = /\bengine\.gpu\b(?=\s*\)|\s*\??\.(?:queue\.onSubmittedWorkDone|adapterInfo)\b)/g;
//  - `new Geometry(a.positions, a.normals, a.indices)` and a destructured `({ positions, normals, indices }) => new Geometry(...)`
//    wrap what a package's primitive returned; building those arrays by hand is caught by the push and typed-array patterns.
const GEOMETRY_WRAP = /\bnew\s+Geometry\s*\(\s*(\w+)\.positions\s*,\s*\1\.normals\s*,\s*\1\.indices\b|\(\s*\{\s*positions\s*,\s*normals\s*,\s*indices\s*\}\s*\)\s*=>\s*new\s+Geometry\b/;
//  - `x = ... Math.exp(-k * dt)` is frame-rate independent smoothing of a camera or UI value, not a solver.
const EXP_SMOOTHING = /Math\.exp\s*\([^()]*\)/g;

/** One regex per rule; each returns true for a (masked) line. */
const LINE_RULES = {
  R1: [
    (l) => /@(?:vertex|fragment|compute)\b/.test(l),
    (l) => /\bfn\s+[A-Za-z_]\w*\s*\(/.test(l),
    (l) => /\bgl_(?:FragColor|Position|FragCoord)\b|#version\s+\d+|\bprecision\s+(?:high|medium|low)p\b/.test(l),
    (l) => /\bvar<\s*(?:uniform|storage|private|workgroup)/.test(l) || /\btexture_(?:2d|3d|storage_2d|cube)\s*</.test(l),
    (l) => /\bcreate(?:Shader|ComputePipeline|RenderPipeline|BindGroup)\w*\s*\(/.test(l),
    (l) => /@margoengine\/shader\/(?:raw|glsl)/.test(l),
    (l) => /\bengine\.gpu\b/.test(l.replace(GPU_READINESS, '')) || /\.gpu\.device\b|\bqueue\.write(?:Buffer|Texture)\s*\(/.test(l),
  ],
  R2: [
    (l) => DT_MUL.test(l.replace(EXP_SMOOTHING, (m) => (new RegExp(DT).test(m) ? '' : m))) && ASSIGN.test(l),
    // Solver-named functions are checked with their bodies in scanText (a wrapper that calls a package's step is fine).
    (l) => /\b9\.80665\b/.test(l) || /[*/]\s*9\.81\b|\b9\.81\s*[*/]/.test(l),
    (l) => /(?:[*/]|\*\*)\s*(?:viscosity|youngs?(?:Modulus)?|elasticModulus|shearModulus|hertz\w*|poisson\w*)\b|\b(?:viscosity|youngs?(?:Modulus)?|elasticModulus|shearModulus|hertz\w*|poisson\w*)\s*(?:[*/]|\*\*)/.test(l),
  ],
  R3: [
    (l) => /\bnew\s+Geometry\s*\(/.test(l) && !GEOMETRY_WRAP.test(l),
    (l) => new RegExp(String.raw`\b${MESH_NAME}\s*\.push\s*\(`).test(l),
    (l) => new RegExp(String.raw`\b${MESH_NAME}\s*(?::|=)\s*new\s+(?:Float32|Uint16|Uint32|Int32)Array\b`).test(l),
    // An option such as `new Line({ positions: [] })` hands a package an empty list; only filled data is mesh data.
    (l) => new RegExp(String.raw`\b(?:positions|normals|uvs|indices)\s*:\s*(?:new\s+\w+Array|\[\s*[^\]\s])`).test(l),
  ],
  R4: [(l) => FN_DEF(MATH_NAME).test(l)],
};

/**
 * The IMP rule: bare module specifiers other than @margoengine/*, margo-demo-status, relative paths and node: built-ins
 * (a build-time data script under source/ may read files; node: is not a third-party library). The statement is found in
 * the string-blanked text, so prose that says "from 'x'" inside a string never counts.
 */
function bareImportHits(plain, withStrings, lines) {
  const hits = [];
  const re = /(?:[\s}]from\s*|\bimport\s*\(\s*|^\s*import\s+)(['"`])( *)\1/gdm;
  for (const m of plain.matchAll(re)) {
    const [from, to] = [m.indices[1][1], m.indices[1][1] + m[2].length];
    const spec = withStrings.slice(from, to);
    if (/^(?:\.|\/|@margoengine\/|margo-demo-status\b|node:)/.test(spec)) continue;
    const line = plain.slice(0, m.index).split('\n').length;
    hits.push({ rule: 'IMP', line, text: lines[line - 1].trim() });
  }
  return hits;
}

/** Source of the function that starts on `line` (1-based): from its name to the matching brace, or the rest of the line. */
function functionBody(plain, lineStarts, line) {
  const start = lineStarts[line - 1];
  const eol = plain.indexOf('\n', start);
  const open = plain.indexOf('{', start);
  if (open < 0 || (eol >= 0 && open > eol && !/\)\s*(?:=>)?\s*$/.test(plain.slice(start, eol)))) return plain.slice(start, eol < 0 ? undefined : eol);
  let depth = 0;
  for (let k = open; k < plain.length; k++) {
    if (plain[k] === '{') depth++;
    else if (plain[k] === '}' && --depth === 0) return plain.slice(start, k + 1);
  }
  return plain.slice(start);
}

// A solver-named function is exempt when it is async (a flow of awaited steps, never a solver), when its only parameter is
// a frame timestamp (a requestAnimationFrame callback), or when its body calls another object's step/update (a wrapper
// over @margoengine/physics or another package's own stepper).
const FRAME_CALLBACK = /\(\s*(?:now|time|timestamp|ts|frameTime)\s*\)/;
const DELEGATES = /\b\w+\s*\.\s*(?:step|update|advance|simulate|solve)\w*\s*\(/;
function solverNameHits(plain, raw) {
  const hits = [];
  const lineStarts = [0];
  for (let k = 0; k < plain.length; k++) if (plain[k] === '\n') lineStarts.push(k + 1);
  const def = FN_DEF(SOLVER_NAME);
  plain.split('\n').forEach((l, k) => {
    if (!def.test(l) || /\basync\b/.test(l) || FRAME_CALLBACK.test(l)) return;
    const body = functionBody(plain, lineStarts, k + 1);
    if (DELEGATES.test(body.slice(body.indexOf('(') + 1))) return;
    hits.push({ rule: 'R2', line: k + 1, text: raw[k].trim() });
  });
  return hits;
}

/** Hits of one source text: `{ rule, line, text }` (one per line per rule), plus its R5 code-line count. */
export function scanText(text) {
  const src = text.replace(/\r\n/g, '\n');
  const raw = src.split('\n');
  const plainText = mask(src, false);
  const plain = plainText.split('\n');
  const withStrings = mask(src, true);
  const strLines = withStrings.split('\n');
  const hits = [];
  for (const [rule, tests] of Object.entries(LINE_RULES)) {
    const source = rule === 'R1' ? strLines : plain;
    source.forEach((l, k) => {
      if (tests.some((t) => t(l))) hits.push({ rule, line: k + 1, text: raw[k].trim() });
    });
  }
  hits.push(...solverNameHits(plainText, raw), ...bareImportHits(plainText, withStrings, raw));
  hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  const code = plain.filter((l) => l.trim() !== '').length;
  return { hits, code };
}

const SOURCE_EXT = /\.(?:js|mjs|ts)$/;
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : SOURCE_EXT.test(name) ? [path] : [];
  });
}

/** Scans every demos/<name>/source: `{ name: { counts: {rule: n}, hits: [{rule, file, line, text}] } }`, sorted by name. */
export function scanDemos(demos = demosDir) {
  const result = {};
  for (const name of readdirSync(demos).sort()) {
    const source = join(demos, name, 'source');
    try {
      if (!statSync(source).isDirectory()) continue;
    } catch {
      continue;
    }
    const counts = Object.fromEntries(RULES.map((r) => [r, 0]));
    const hits = [];
    for (const file of walk(source).sort()) {
      const { hits: found, code } = scanText(readFileSync(file, 'utf8'));
      counts.R5 += code;
      for (const h of found) {
        counts[h.rule]++;
        hits.push({ ...h, file: relative(root, file).split('\\').join('/') });
      }
    }
    result[name] = { counts, hits };
  }
  return result;
}

/** The allowlist entry a scan would write: non-zero counts, R5 only above the free floor. */
export function entryFor(counts) {
  const entry = {};
  for (const r of RULES) {
    if (r === 'R5' ? counts.R5 > R5_FLOOR : counts[r] > 0) entry[r] = counts[r];
  }
  return entry;
}

/** Compares a scan with an allowlist (`{ demos: {...} }`); returns the problems, each `{ demo, rule, kind, ... }`. */
export function compare(scan, allowlist) {
  const allowed = allowlist.demos ?? {};
  const problems = [];
  for (const [demo, entry] of Object.entries(allowed)) {
    if (!scan[demo]) problems.push({ demo, kind: 'stale', message: `allowlist lists "${demo}", which has no source/ folder; delete the entry` });
    else
      for (const rule of Object.keys(entry))
        if (!RULES.includes(rule)) problems.push({ demo, rule, kind: 'stale', message: `allowlist rule "${rule}" does not exist; delete it` });
  }
  for (const [demo, { counts, hits }] of Object.entries(scan)) {
    for (const rule of RULES) {
      const listed = allowed[demo]?.[rule];
      const limit = listed ?? (rule === 'R5' ? R5_FLOOR : 0);
      const count = counts[rule];
      if (count > limit) problems.push({ demo, rule, kind: 'rose', count, limit, hits: hits.filter((h) => h.rule === rule), listed: demo in allowed });
      else if (listed !== undefined && (rule === 'R5' ? count <= R5_FLOOR : listed === 0))
        problems.push({ demo, rule, kind: 'stale', message: `allowlist entry ${demo}.${rule}=${listed} is stale (count ${count}); delete it` });
      else if (listed !== undefined && count < listed) problems.push({ demo, rule, kind: 'fell', count, limit: listed });
    }
  }
  return problems;
}

const COMMENT =
  'Ratchet for scripts/check-demo-sources.mjs: engine code still living in each demo source/ (Scott, 2026-11-27: nothing in a demo directly). Counts only fall; never raise one. After moving code into a package run: node scripts/check-demo-sources.mjs --lower. R5 is listed only above r5Floor.';

const WHAT = {
  R1: 'shader text or raw GPU use',
  R2: 'a solver (time step, step/advance/integrate/solve function or physical constant)',
  R3: 'raw mesh data',
  R4: 'a local math or noise helper',
  R5: 'JS code lines',
  IMP: 'a third-party import',
};

/** Human message for the problems. */
export function format(problems) {
  const lines = [];
  for (const p of problems) {
    if (p.kind === 'stale') lines.push(`STALE ${p.message}`);
    else if (p.kind === 'fell')
      lines.push(`LOWER demos/${p.demo} ${p.rule}: ${p.count} now, allowlist says ${p.limit}. Run: node scripts/check-demo-sources.mjs --lower`);
    else {
      lines.push(
        `FAIL demos/${p.demo} ${p.rule} (${WHAT[p.rule]}): ${p.count}, allowed ${p.limit}${p.listed || p.rule !== 'R5' ? '' : ''}.`,
      );
      for (const h of p.hits.slice(0, 25)) lines.push(`  ${h.file}:${h.line}  ${h.text.slice(0, 110)}`);
      if (p.hits.length > 25) lines.push(`  ... ${p.hits.length - 25} more`);
      lines.push(`  Fix: ${FIX}. A demo's source/ holds wiring, UI, layout and content data only.`);
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const scan = scanDemos();
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  if (argv.includes('--init') || argv.includes('--lower')) {
    const next = { _comment: COMMENT, r5Floor: R5_FLOOR, demos: {} };
    for (const [demo, { counts }] of Object.entries(scan)) {
      const entry = entryFor(counts);
      if (argv.includes('--lower')) {
        // Never upward: a rule may keep its old value or fall; a new key may not appear.
        for (const r of Object.keys(entry)) {
          const old = allowlist.demos?.[demo]?.[r];
          if (old === undefined && !argv.includes('--init')) delete entry[r];
          else if (old !== undefined && entry[r] > old) entry[r] = old;
        }
      }
      if (Object.keys(entry).length) next.demos[demo] = entry;
    }
    writeFileSync(allowlistPath, `${JSON.stringify(next, null, 1)}\n`);
    console.log(`wrote ${relative(root, allowlistPath)} (${Object.keys(next.demos).length} demos listed)`);
    return 0;
  }
  const problems = compare(scan, allowlist);
  if (problems.length) {
    console.error(format(problems));
    console.error(`\ncheck:demo-sources failed: ${problems.length} problem(s).`);
    return 1;
  }
  const totals = Object.fromEntries(RULES.map((r) => [r, 0]));
  for (const { counts } of Object.values(scan)) for (const r of RULES) totals[r] += counts[r];
  const clean = Object.values(scan).filter(({ counts }) => ['R1', 'R2', 'R3', 'R4', 'IMP'].every((r) => counts[r] === 0)).length;
  console.log(
    `check:demo-sources ok: ${Object.keys(scan).length} demos, ${clean} at zero; ${RULES.map((r) => `${r} ${totals[r]}`).join(', ')}.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
