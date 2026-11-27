// The evidence behind tests/fauld-shots-sight.test.js, for the three shots whose first cameras saw a trunk, grass and
// leaves: the ground and the plants round each shot's blocked camera and its camera now.
//   node tools/shot/fauld-sight-fixture.mjs   after fauld-shots.mjs (build:packages first; the asset library)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fauldSight } from './fauld-sight.mjs';

const BLOCKED = '505b2ff1f6'; // the commit that holds the blocked cameras
const asset = (p) => fileURLToPath(new URL(`../../../../Assets/${p}`, import.meta.url));
const sight = fauldSight({ library: asset('blender-library'), dem: asset('dem/os-terrain-50/fauld_sk12_sk23.f32') });
const r1 = (v) => Math.round(v * 100) / 100;
const out = {};
for (const id of ['fr011', 'fr031', 'fr139']) {
  const path = `tools/shot/shots/fauld-${id}.json`,
    now = JSON.parse(readFileSync(path, 'utf8')),
    before = JSON.parse(execFileSync('git', ['show', `${BLOCKED}:${path}`], { encoding: 'utf8' })),
    scene = await sight(now.shot.page.query.era),
    cameras = {};
  for (const [name, shot] of Object.entries({ blocked: before, now })) {
    const keys = shot.tracks[0].keys,
      [tx, , tz] = now.shot.subject.target,
      [x, , z] = keys[0].position,
      length = Math.hypot(tx - x, tz - z),
      along = [(tx - x) / length, (tz - z) / length],
      side = [-along[1], along[0]],
      half = Math.ceil((length * Math.tan((keys[0].fov * Math.PI) / 360) * 16) / 9 / 5) * 5 + 15,
      step = 5,
      columns = Math.ceil((length + 2 * half) / step) + 1,
      rows = (2 * half) / step + 1,
      heights = [];
    // A grid laid along the sight line, from `half` behind the lens to `half` past the subject.
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        const a = i * step - half,
          s = j * step - half;
        heights.push(r1(scene.ground(x + along[0] * a + side[0] * s, z + along[1] * a + side[1] * s)));
      }
    const near = new Set();
    for (const k of keys) for (const c of await scene.near(k.position[0], k.position[2], length)) near.add(c);
    const occluders = [...near]
      .filter((c) => {
        const a = (c.x - x) * along[0] + (c.z - z) * along[1],
          s = (c.x - x) * side[0] + (c.z - z) * side[1];
        // Inside the frame's widening wedge, with room for the move.
        return (
          a > -c.radius - 5 && a < length + 10 && Math.abs(s) < (half - 10) * Math.max(0, a / length) + c.radius + 8
        );
      })
      .map((c) => [r1(c.x), r1(c.z), r1(c.bottom), r1(c.top), r1(c.radius), c.opacity]);
    cameras[name] = {
      ...(name === 'blocked' ? { keys } : {}),
      grid: { origin: [x, z], along, half, step, columns, rows, heights },
      occluders,
    };
  }
  out[id] = cameras;
}
writeFileSync('tests/fixtures/fauld-sight.json', `${JSON.stringify(out)}\n`);
