// Quality step `compat-routes` (KB-COMPAT-READY1): a package that loads a WebGL2 compatibility route with
// loadCompatRoute (packages/shared/compat.js) draws its first frames on the layer before the route arrives, and those
// frames can differ from later ones (KB-SCATTER-ATTRCOMPAT1 in shadows, then dof, vfx, splats, compute, sky). Every
// source file that calls loadCompatRoute must either give callers a `ready` promise (a `get ready()` in the file, or
// the routeSettled promise behind one) or be recorded in compat-route-proofs.json with the test that proves its frames
// are identical before and after the route. The `owed` list there names files still without either; it only shrinks.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CALL = /\bloadCompatRoute\s*\(/,
  READY = /\bget ready\s*\(|\brouteSettled\s*\(/;

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') sources(path, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** The problems of the step for the repository at `root`, one line each; none when it passes. */
export function compatRouteProblems(root) {
  const record = JSON.parse(readFileSync(join(root, 'scripts/quality/compat-route-proofs.json'), 'utf8')),
    proofs = record.proofs ?? {},
    owed = new Set(record.owed ?? []),
    problems = [],
    seen = new Set();
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, 'src');
    if (pkg === 'shared' || !existsSync(src)) continue;
    for (const file of sources(src)) {
      const text = readFileSync(file, 'utf8');
      if (!CALL.test(text)) continue;
      const path = relative(root, file).split(sep).join('/');
      seen.add(path);
      if (READY.test(text)) {
        if (owed.has(path)) problems.push(`${path}: has its ready promise now; remove it from "owed"`);
        continue;
      }
      const proof = proofs[path];
      if (proof) {
        if (!proof.test || !existsSync(join(root, proof.test)))
          problems.push(`${path}: its proof test ${proof.test ?? '(none named)'} does not exist`);
        continue;
      }
      if (owed.has(path)) continue;
      problems.push(
        `${path}: loads a WebGL2 route with loadCompatRoute but gives no \`ready\` promise (routeSettled) and has no proof in scripts/quality/compat-route-proofs.json`,
      );
    }
  }
  for (const path of [...owed, ...Object.keys(proofs)])
    if (!seen.has(path)) problems.push(`${path}: listed in compat-route-proofs.json but loads no route; remove it`);
  return problems;
}
