import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A fixture file is an explicit audit boundary, not a syntactic waiver: a package is gated once it has
// packages/<name>/test(s)/owner-lifetime.fixture.js. A selected package with none is printed as pending by every
// owner/lifetime check, never counted as a pass.
const root = fileURLToPath(new URL('../../', import.meta.url));
export const OWNER_FIXTURES = Object.fromEntries(readdirSync(`${root}packages`).sort().flatMap((name) =>
  ['tests', 'test'].map((dir) => `packages/${name}/${dir}/owner-lifetime.fixture.js`)
    .filter((file) => existsSync(root + file)).slice(0, 1).map((file) => [name, file])));
export const OWNER_EXCLUSIONS = {
  core: 'Core is the engine every fixture runs on; its scene routing, plugins and frame graph are exercised by all of them.',
  physics2d: 'Physics is on hold (Scott, 2026-11-10).',
  ragdoll: 'Physics is on hold (Scott, 2026-11-10).',
  math: 'Vectors, matrices, colours and shapes on numbers and typed arrays; the one runtime import of core (the mesh world matrix) only reads state and holds none. tests/owner-exclusions.test.js reads the source and fails if it gains a listener, timer, worker, storage handle, GPU resource or engine registration.',
  splines: 'Curve evaluation, fitting and queries on numbers and typed arrays. tests/owner-exclusions.test.js reads the source and fails if it gains a listener, timer, worker, storage handle, GPU resource or engine registration.',
  brep: 'STEP, IGES and JT readers and B-rep modelling on plain objects and typed arrays; its runtime imports are math matrices and errors. tests/owner-exclusions.test.js reads the source and fails if it gains a listener, timer, worker, storage handle, GPU resource or engine registration.',
  'kinematics-constraints': 'Avoidance, chain, joint-limit, swept, SDF and multi-goal IK solvers on numbers and typed arrays; a solve polls its AbortSignal and never subscribes to it, and the one runtime import (bvh pointInside, in src/sdf.ts) is a pure query. tests/owner-exclusions.test.js reads the source and fails if it gains a listener, timer, worker, storage handle, GPU resource or engine registration.',
};

const known = (name) => existsSync(`${root}packages/${name}/package.json`);

/** Splits a package selection into fixtures to run and packages still pending a fixture. Unknown names throw. */
export function selectOwnerPackages(packages, registered = OWNER_FIXTURES, exists = known) {
  const unknown = packages.filter((name) => !registered[name] && !exists(name));
  if (unknown.length) throw new Error(`OWNER_UNKNOWN_PACKAGE: ${unknown.join(', ')}`);
  return {
    selected: packages.filter((name) => registered[name]),
    pending: packages.filter((name) => !registered[name] && !OWNER_EXCLUSIONS[name]),
  };
}

/** The pending line every owner/lifetime check prints; an empty list prints nothing. */
export function pendingLine(pending) {
  return pending.length
    ? `Owner/lifetime pending, no fixture yet, NOT checked (${pending.length}): ${pending.join(', ')}`
    : '';
}

/** Owner cases per fixture entry: two targets, seven lifetimes, less the default scene's own disposal. */
export const ENTRY_CASES = 13;
/** The most owner cases one browser leaf runs inside its 180 s limit (tests/owner-lifetime.test.js). */
export const LEAF_CASES = 208;

/**
 * The browser leaves of one package's fixture module: `[undefined]` (one leaf runs every entry), or lists of entry names
 * run one leaf each. `leafCases` (at most LEAF_CASES, a whole number of entries) packs the entries in order into leaves
 * of at most that many cases; `leafPerEntry` is one entry per leaf. Every entry is in exactly one leaf. Names must be
 * unique, since a leaf selects its entries by name.
 */
export async function ownerLeaves(module) {
  const { leafCases, leafPerEntry } = module;
  if (leafCases === undefined && !leafPerEntry) return [undefined];
  if (leafCases !== undefined && (!Number.isInteger(leafCases / ENTRY_CASES) || leafCases < ENTRY_CASES ||
    leafCases > LEAF_CASES))
    throw new RangeError(`OWNER_LEAF_CASES: ${leafCases} is not a whole number of ${ENTRY_CASES}-case entries from ` +
      `${ENTRY_CASES} to ${LEAF_CASES}`);
  const names = (await module.fixtures()).map((fixture) => fixture.name);
  const twice = names.filter((name, i) => names.indexOf(name) !== i);
  if (!names.length) throw new Error('OWNER_FIXTURE_EMPTY');
  if (twice.length) throw new Error(`OWNER_ENTRY_TWICE: ${[...new Set(twice)].join(', ')}`);
  const size = leafCases === undefined ? 1 : leafCases / ENTRY_CASES, leaves = [];
  for (let i = 0; i < names.length; i += size) leaves.push(names.slice(i, i + size));
  return leaves;
}

/** The limit of one CPU owner/lifetime run, which covers one package (the slowest, biomes, took about 90 s). */
export const CPU_LIMIT_MS = 120_000;
/**
 * The CPU owner/lifetime runs of a selection: one process per package, each with its own CPU_LIMIT_MS. One process for
 * every package summed every package's time under one limit: the 75 fixtures took about 160 s (biomes alone about
 * 90 s), so a full run always passed the limit and read as a hang (2026-11-18). A package that really hangs is named by
 * its own run's timeout.
 */
export function cpuRuns(selected) {
  return selected.map((name) => [name]);
}
