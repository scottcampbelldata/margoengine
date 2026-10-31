// Times intersectLines on one polyline of 100,000 segments: tree build, then picks that hit and picks that miss,
// against testing every segment. Run by hand after building: node packages/bvh/scripts/bench-line-pick.js
import { intersectLines } from '../dist/lines.js';
import { Raycaster } from '../dist/index.js';
import { Line } from '../../lines/dist/index.js';

const segments = 100_000,
  positions = new Float32Array((segments + 1) * 3);
for (let i = 0; i <= segments; i++) {
  const a = i * 0.002,
    r = 1 + a / 50;
  positions.set([Math.cos(a) * r, Math.sin(a) * r, -a / 100], i * 3);
}
const line = new Line({ positions, width: 2 });
// The eye at (0, 0, 20), 900 by 900 pixels.
const view = { matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, -1, 0, 0, 0.1, 20], width: 900, height: 900 };
const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
const time = (run) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};
const builds = [];
for (let i = 0; i < 7; i++) {
  line.setPositions(positions);
  builds.push(time(() => intersectLines(new Raycaster([0, 0, 20], [0, 0, -1]), [line], { view })));
}
const rays = (n, onLine) =>
  Array.from({ length: n }, (_, i) => {
    const k = Math.floor(((i + 0.5) / n) * segments) * 3,
      x = positions[k] + (onLine ? 0 : 0.11),
      y = positions[k + 1] + (onLine ? 0 : 0.11),
      z = positions[k + 2];
    return new Raycaster([0, 0, 20], [x, y, z - 20]);
  });
const pick = (list) => {
  let hits = 0;
  const each = [];
  for (let round = 0; round < 5; round++)
    for (const ray of list)
      each.push(
        time(() => {
          hits += intersectLines(ray, [line], { view }).length;
        }),
      );
  return { ms: median(each), hits: hits / 5 };
};
const hit = pick(rays(1000, true)),
  miss = pick(rays(1000, false));
console.log(
  JSON.stringify(
    {
      segments,
      buildMs: median(builds),
      hitPickMs: hit.ms,
      hitsPer1000: hit.hits,
      missPickMs: miss.ms,
      hitsOnOffset: miss.hits,
    },
    null,
    2,
  ),
);
