// Status and gate of the visual check's WebGL2 compatibility run (scripts/visual-compat.mjs), kept apart so a unit test
// pins them (tests/visual-compat-status.test.js). Inputs are the run's measures of one demo: `noise` compares the two
// native captures, `diff` the first native capture with the layer's; each has `over2` (share of pixels with d > 2),
// `mean` and `max` (d = max RGB difference per pixel, 0 to 255).

/** The roadmap's parity rule (decision 4): at most 0.1% of pixels with d > 2 and a mean d of at most 0.25. */
export const SAME = { over2: 0.001, mean: 0.25 };

/** 'same' under the parity rule, else 'differs'. The rule is absolute: native noise never widens it. */
export const verdict = (diff) => (diff.over2 <= SAME.over2 && diff.mean <= SAME.mean ? 'same' : 'differs');

/** True when the two native captures are equal pixel for pixel (the demo's still frame is exact). */
export const exact = (noise) => noise.max === 0;

/** What `--write` records for a row: its status, a "differs" row's numbers, a refusal, and an exact still frame. */
export function record(row) {
  return {
    status: row.status,
    ...(row.status === 'differs' ? { over2: row.diff.over2, mean: row.diff.mean } : {}),
    ...(row.refused ? { refused: row.refused } : {}),
    ...(row.noise && exact(row.noise) ? { exact: true } : {}),
  };
}

/**
 * The gate's problems for one measured row against its recorded expectation `want` (undefined when not recorded):
 * the recorded status; a "differs" row no worse than its recorded share and mean (x1.5 plus 0.001 / 0.25); a demo
 * recorded with an exact still frame keeps it (its two native captures equal, so its status cannot flip with noise);
 * and the frame budget, which counts when the layer's median frame is over `budget` ms and at least twice native's.
 */
export function gateProblems(row, want, { write = false, budget = 50 } = {}) {
  const problems = [];
  if (!write) {
    if (!want) problems.push('not in visual-compat-expected.json (run with --write)');
    else {
      if (want.status !== row.status) problems.push(`expected ${want.status}, got ${row.status}`);
      else if (row.status === 'differs')
        for (const k of ['over2', 'mean'])
          if (row.diff[k] > want[k] * 1.5 + (k === 'over2' ? 0.001 : 0.25))
            problems.push(`${k} ${row.diff[k]} over the recorded ${want[k]}`);
      if (want.exact && row.noise && !exact(row.noise))
        problems.push(
          `the two native captures differ (d > 2 on ${(row.noise.over2 * 100).toFixed(2)}%, max d ${row.noise.max}): the still frame is no longer exact, something moves under reduced motion`,
        );
    }
  }
  if (row.frame && row.frame.compat.work > budget && row.frame.compat.work > 2 * row.frame.native.work)
    problems.push(`median frame on the layer ${row.frame.compat.work.toFixed(1)} ms, over the ${budget} ms budget`);
  return problems;
}
