// Fails when a bundle's install closure contains an engine package outside its allowed set.
// Optional peers are not installed with the bundle, so they are not part of the closure.
// Usage: node scripts/check-bundle-closure.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_MEMBERS } from './umbrella.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The four shipping bundles. kit-react is retired and is not one of them. */
export const BUNDLES = ['games', 'web', 'science', 'cad'];

/**
 * Packages a bundle may install without listing them as members.
 * math is the shared numerics package. points comes in through loaders, splines through tween,
 * and headless through one lazy sciviz video export.
 */
export const BUNDLE_EXTRA = {
  games: ['math', 'points'],
  web: ['math', 'points', 'splines'],
  science: ['math', 'headless'],
  cad: ['math', 'points', 'splines'],
};

/** Optional add-ons and dev tools. A bundle that installs one of these is wrong. */
export const BUNDLE_DENIED = ['react', 'xr', 'voxel-pathtracer', 'blender', 'inspector', 'mcp'];

export function readPackages(repo = root) {
  const packages = new Map();
  for (const dir of readdirSync(join(repo, 'packages'))) {
    const file = join(repo, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    packages.set(manifest.name, manifest);
  }
  return packages;
}

/** Hard dependencies and required peers, following @margoengine names only. */
export function closureOf(name, packages, seen = new Set()) {
  if (seen.has(name) || !packages.has(name)) return seen;
  seen.add(name);
  const manifest = packages.get(name);
  const next = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  for (const peer of Object.keys(manifest.peerDependencies ?? {}))
    if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) next.push(peer);
  for (const dep of next) if (dep.startsWith('@margoengine/')) closureOf(dep, packages, seen);
  return seen;
}

export function allowedSet(bundle) {
  const members = KIT_MEMBERS[bundle];
  if (!members) throw new Error(`No member list for ${bundle}`);
  return new Set([...members, ...(BUNDLE_EXTRA[bundle] ?? [])].map((name) => `@margoengine/${name}`));
}

/** @returns {{bundle: string, extra: string[], denied: string[]}[]} */
export function bundleLeaks(packages = readPackages()) {
  const problems = [];
  for (const bundle of BUNDLES) {
    const name = `@margoengine/${bundle}`;
    const closure = closureOf(name, packages);
    closure.delete(name);
    const allowed = allowedSet(bundle);
    const extra = [...closure].filter((dep) => !allowed.has(dep)).sort();
    const denied = [...closure].filter((dep) => BUNDLE_DENIED.some((item) => dep === `@margoengine/${item}`)).sort();
    if (extra.length || denied.length) problems.push({ bundle, extra, denied });
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = bundleLeaks();
  if (!problems.length) {
    const packages = readPackages();
    for (const bundle of BUNDLES) {
      const closure = closureOf(`@margoengine/${bundle}`, packages);
      closure.delete(`@margoengine/${bundle}`);
      console.log(`${bundle}: ${KIT_MEMBERS[bundle].length} members, ${closure.size} in the closure`);
    }
  } else {
    for (const { bundle, extra, denied } of problems) {
      if (extra.length) console.error(`${bundle} closure is outside its allowed set: ${extra.join(', ')}`);
      if (denied.length) console.error(`${bundle} installs a package that belongs in no bundle: ${denied.join(', ')}`);
    }
    process.exitCode = 1;
  }
}
