// Every tool that reads a package's dist (the API report, the entry size record) first makes that dist match the
// package's sources. A tree's dist is whatever its last build left: after `git rebase origin/main` a lane holds old
// builds of every package main changed, so a measurement taken from it describes other source. KB-API-SURFACE-CHURN1
// (2026-11-16): the Gzip column of docs/api-surface.md comes from entry-sizes.json, and `entry-sizes.mjs` measured the
// dist it found, so two lanes at the same commit wrote different figures and every push conflicted on them. With this
// step the figures are a function of the sources: a package whose stamp (scripts/package-stamps.mjs) is stale is rebuilt
// under the build lock (scripts/support/build-lock.mjs), a current one is left alone.
import { execFileSync } from 'node:child_process';
import { stalePackages } from '../package-stamps.mjs';
import { BUILD_LOCK_ENV, acquireBuildLock } from './build-lock.mjs';

/**
 * Rebuilds the packages whose dist does not match their sources and returns their directory names. `only` (a set of
 * directories) limits the check and the rebuild to those packages, so a scoped tool leaves the rest of the tree alone
 * (KB-TOOL-APISCOPE1). `stale` and `build` are the parts a test replaces: the stale finder (given the root and `only`)
 * and the build command (given the stale names).
 */
export function rebuildStalePackages(
  root,
  {
    label = 'Build',
    only,
    stale = (root, only) => stalePackages(root, undefined, only),
    build = (names) =>
      execFileSync(process.execPath, ['scripts/build-modern.js', '--precompiled', `--only=${names.join(',')}`], {
        cwd: root,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, [BUILD_LOCK_ENV]: String(process.pid) },
      }),
    log = console.error,
  } = {},
) {
  // Stale packages are found and rebuilt under the lock: two tools at once both rebuilt the same packages side by side
  // and deleted each other's dist (KB-RM4).
  const release = acquireBuildLock(root);
  try {
    const names = stale(root, only).filter((name) => !only || only.has(name));
    if (names.length) {
      log(
        `${label}: rebuilding ${names.length} package(s) whose dist does not match their sources: ${names.join(', ')}`,
      );
      build(names);
    }
    return names;
  } finally {
    release();
  }
}
