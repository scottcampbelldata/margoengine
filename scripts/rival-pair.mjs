// Paired timings for batch 167. Both sides run in this process, taking turns, and the reported time is the
// fastest round. Wall-clock numbers on a loaded PC are diagnostic: print "busy machine" next to them.
// Rival packages stay outside the repository. This file never imports one.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Folder that holds the black-box installs. `MARGO_ENGINE_BENCH` overrides the usual path. */
export function benchRoot() {
  return process.env.MARGO_ENGINE_BENCH ?? fileURLToPath(new URL('../../engine-bench', import.meta.url));
}

/** `file:` URL of a runner under `<bench>/batch-167/`. */
export function rivalUrl(file) {
  return pathToFileURL(`${benchRoot()}\\batch-167\\${file}`).href;
}

/** Version field of an installed rival package. */
export function rivalVersion(name) {
  const file = `${benchRoot()}\\batch-167\\node_modules\\${name}\\package.json`;
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

/**
 * Runs `runA` and `runB` `rounds` times, alternating which goes first.
 * Each function does one measured piece of work and returns its result. Setup stays outside the function.
 * @returns {{ minA: number, minB: number, roundsA: number[], roundsB: number[], outA: unknown, outB: unknown }}
 */
export function paired(rounds, runA, runB) {
  const roundsA = [];
  const roundsB = [];
  let outA;
  let outB;
  for (let i = 0; i < rounds; i++) {
    if (i % 2 === 0) {
      const a0 = performance.now();
      outA = runA();
      roundsA.push(performance.now() - a0);
      const b0 = performance.now();
      outB = runB();
      roundsB.push(performance.now() - b0);
    } else {
      const b0 = performance.now();
      outB = runB();
      roundsB.push(performance.now() - b0);
      const a0 = performance.now();
      outA = runA();
      roundsA.push(performance.now() - a0);
    }
  }
  return { minA: Math.min(...roundsA), minB: Math.min(...roundsB), roundsA, roundsB, outA, outB };
}

/** One line: name, both minima, who was faster, and the busy-machine note. */
export function line(name, labelA, minA, labelB, minB) {
  const winner = minA < minB ? labelA : minB < minA ? labelB : 'equal';
  return `${name}: ${labelA} ${minA.toFixed(3)} ms, ${labelB} ${minB.toFixed(3)} ms, faster: ${winner} (busy machine, per-round minimum)`;
}
