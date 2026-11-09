import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/geometry/scripts/polygon-bench.mjs')
)
  process.exit(0);
// Times the polygon entry on large outlines: node packages/geometry/scripts/polygon-bench.mjs, after a build.
import { polygonArea, polygonIntersection, polygonOffset, polygonStroke } from '../dist/polygon.js';

const wavy = (corners, cx, cy, radius) =>
  Array.from({ length: corners }, (_, i) => {
    const angle = (i / corners) * Math.PI * 2,
      r = radius * (1 + 0.1 * Math.sin(angle * 37));
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  });

function run(label, make) {
  const start = performance.now(),
    result = make();
  console.log(`${label}: ${(performance.now() - start).toFixed(1)} ms, area ${polygonArea(result).toFixed(4)}`);
}

for (const corners of [1000, 10000, 100000])
  run(`intersect two ${corners}-point outlines`, () =>
    polygonIntersection(wavy(corners, 0, 0, 10), wavy(corners, 1, 1, 10)),
  );
const outline = wavy(20000, 0, 0, 10);
run('round outset of 20,000 points', () => polygonOffset(outline, 0.5, { join: 'round' }));
run('miter inset of 20,000 points', () => polygonOffset(outline, -0.2));
run('round stroke of 20,000 points', () => polygonStroke(outline, 0.4, { join: 'round', cap: 'round' }));
