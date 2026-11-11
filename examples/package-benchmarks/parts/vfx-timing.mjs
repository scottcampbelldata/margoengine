// Node-side statistics for vfx-gpu.mjs. The page returns raw per-frame pass times; nothing here runs in the browser,
// because a function passed to page.evaluate cannot see the Node percentile helper.
import { median } from '../../../scripts/lib/percentile.mjs';

const KEYS = ['compute', 'draw', 'total'];

/** blocks[v][round] is the list of { compute, draw } frames of arm v in that round. */
export function summarizeTiming(blocks, rounds) {
  const perRound = blocks.map((arm) =>
    arm.map((list) => ({
      compute: median(list.map((m) => m.compute)),
      draw: median(list.map((m) => m.draw)),
      total: median(list.map((m) => m.compute + m.draw)),
    })),
  );
  const stat = (v, key) => {
    const x = perRound[v].map((b) => b[key]).sort((p, q) => p - q);
    return { median: median(x), min: x[0], max: x.at(-1) };
  };
  const summary = Object.fromEntries(
    KEYS.map((key) => [
      key,
      {
        A: stat(0, key),
        B: stat(1, key),
        pairedSavingMs: median(perRound[0].map((x, i) => x[key] - perRound[1][i][key])),
        bFasterRounds: perRound[0].filter((x, i) => perRound[1][i][key] < x[key]).length,
        rounds,
      },
    ]),
  );
  return { summary, blocks: perRound };
}
