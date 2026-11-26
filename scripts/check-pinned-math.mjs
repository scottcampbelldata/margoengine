// The merge gate's guard for deterministic maths in the physics framework (docs/physics-framework.md, section 7): the code
// that feeds a world's state (the world, its registry and scheduler, every framework solver, and the fields they read: the
// physics wind force and explosion, the standard atmosphere) uses no host transcendental (`Math.exp`, `Math.sin`,
// `Math.pow`, `Math.hypot` and the like) and no `**`, whose results each JavaScript engine may round differently. They use
// `@margoengine/math/pinned` (the TypeScript twin of kernel-common's pinned functions, K01) instead. Exact operations
// (`Math.floor`, `min`, `max`, `abs`, `sqrt`, `imul`, `trunc`, `sign`, `fround`) are allowed.
//
// Run: node scripts/check-pinned-math.mjs (exit code 1 and every place when one is found).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solversIn } from './check-coupling.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');

/** Files always held to the rule, besides every file that declares a framework solver. */
export const ALWAYS = [
  'packages/physics/src/world/*.ts',
  'packages/physics/src/fields.ts',
  'packages/physics/src/aero.ts',
  'packages/physics/src/sail.ts',
  'packages/physics/src/lattice.ts',
  'packages/physics/src/flight.ts',
  'packages/physics/src/held.ts',
  'packages/physics/src/air-hold.ts',
  'packages/physics/src/hydro/shallow.ts',
  'packages/physics/src/hydro/index.ts',
  'packages/physics/src/foam/breaking.ts',
  'packages/physics/src/foam/spray.ts',
  'packages/physics/src/foam/index.ts',
  'packages/physics/src/surf/index.ts',
  'packages/physics/src/rogue/*.ts',
  'packages/physics/src/ship/*.ts',
  'packages/physics/src/loads/*.ts',
  'packages/physics/src/pbf/*.ts',
  'packages/physics/src/dfsph/*.ts',
  'packages/physics/src/vegetation/*.ts',
  'packages/math/src/atmosphere.ts',
  'packages/weather/src/boundary-layer.ts',
  'packages/weather/src/turbulence.ts',
  'packages/weather/src/precipitation.ts',
];

const BANNED =
  /\bMath\.(exp|expm1|log|log1p|log2|log10|pow|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot)\b|\*\*(?!\/)/g;

/** `text` with comments, strings and template literals blanked (newlines kept), so only code is checked. */
export function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
}

/** Every banned use in `text` as `line: what`. */
export function hostMath(text) {
  const code = codeOnly(text),
    found = [];
  for (const match of code.matchAll(BANNED)) {
    const line = code.slice(0, match.index).split('\n').length;
    found.push(`${line}: ${match[0]}`);
  }
  return found;
}

function tracked(...patterns) {
  return execFileSync('git', ['ls-files', '-z', '--', ...patterns], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const files = new Set(tracked(...ALWAYS));
  for (const path of tracked('packages/*/src/**/*.ts')) if (solversIn(read(path)).length) files.add(path);
  const problems = [...files].sort().flatMap((path) => hostMath(read(path)).map((place) => `${path}:${place}`));
  if (problems.length) {
    console.error(
      `check:pinned-math: ${problems.length} host transcendental(s) or ** where a world's state is computed. Fix: use exp, ln, pow, sin, cos or hypot from @margoengine/math/pinned (or a shift for a power of two):\n  ${problems.join('\n  ')}`,
    );
    // It ends by its event loop with code 1, as every check does (KB-OWN-EXIT2).
    process.exitCode = 1;
  } else console.log(`check:pinned-math: ok, ${files.size} file(s) use only pinned maths.`);
}
