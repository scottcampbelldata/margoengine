// Bug KB-COMPAT-FRAMEALLOC1 (scripts/frame-alloc-browser.mjs under MARGO_COMPAT=1, 2026-11-16): on the WebGL2 layer
// the frame-alloc dynamic scene allocated 497,716 B a frame against its native 396 B. Culling's CPU routes (src/compat.ts),
// which run once a frame there, took 484 KB of it: Math.hypot per row (V8 boxes its arguments into an array) and,
// on the other routes, a subarray view per kept record, a forEach closure per frame and a closure around the shape test;
// the box shape's CPU test made a subarray, a centre array, a map array and three spread arrays per instance. The
// routes now allocate nothing (dynamic scene on the layer: 497,716 to 17,840 B, the rest is the layer's own). The
// probe runs each route over 256 rows in a fresh process (support/compat-alloc-probe.mjs); the code before the fix read
// 15,552 B a call for the dynamic route, 42,284 B for the instance route, 42,231 B for the mesh route, over 17,505 B
// for the mesh route with the box shape (V8 collected inside every window); now 0 B each, the dynamic route with the
// box shape included (its shape argument changed form, so the old one has no figure).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BoxCulledMeshes } from '../dist/bounds.js';

// The V8 flags of tests/frame-alloc.test.js at the repository root, which gives the reason for each.
const HEAP = [
  '--min-semi-space-size=16',
  '--max-semi-space-size=16',
  '--single-threaded-gc',
  '--no-concurrent-recompilation',
  '--no-concurrent-sparkplug',
];

test('the WebGL2 layer culling routes allocate nothing a frame', () => {
  const { bytes, errors } = JSON.parse(
    execFileSync(
      process.execPath,
      ['--expose-gc', ...HEAP, fileURLToPath(new URL('./support/compat-alloc-probe.mjs', import.meta.url))],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  );
  assert.deepEqual(errors, {});
  for (const [route, windows] of Object.entries(bytes)) {
    const median = [...windows].sort((a, b) => a - b)[windows.length >> 1];
    assert.ok(
      median < 1,
      `the ${route} route allocated ${median} B a call (Node ${process.version}, V8 ${process.versions.v8})`,
    );
  }
});

// The box shape's CPU test before the fix, kept here as the reference: the rewrite must decide every case the same.
function reference(records, at, vertices, frame) {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 6)
    for (let k = 0; k < 3; k++) {
      bounds[k] = Math.min(bounds[k], vertices[i + k]);
      bounds[k + 3] = Math.max(bounds[k + 3], vertices[i + k]);
    }
  const m = records.subarray(at, at + 16),
    c = [(bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2],
    center = [0, 1, 2, 3].map((k) => m[k] * c[0] + m[k + 4] * c[1] + m[k + 8] * c[2] + m[k + 12]),
    half = [0, 1, 2].map((k) => (bounds[k + 3] - bounds[k]) / 2),
    pad = 1e-5 * (1 + Math.hypot(...center.slice(0, 3)) + Math.hypot(...half) * Math.hypot(...m.slice(0, 12)));
  for (let p = 16; p < 40; p += 4) {
    let r = pad * Math.hypot(frame[p], frame[p + 1], frame[p + 2]);
    for (let k = 0; k < 3; k++)
      r += Math.abs(frame[p] * m[k * 4] + frame[p + 1] * m[k * 4 + 1] + frame[p + 2] * m[k * 4 + 2]) * half[k];
    if (frame[p] * center[0] + frame[p + 1] * center[1] + frame[p + 2] * center[2] + frame[p + 3] < -r) return false;
  }
  return true;
}

test('the box shape CPU test keeps exactly what it kept before, unbound, at any record offset', () => {
  const { cpu } = new BoxCulledMeshes()['shape'],
    vertices = new Float32Array(8 * 6);
  for (let i = 0; i < 8; i++) vertices.set([i & 1 ? 2 : -1, i & 2 ? 0.5 : -3, i & 4 ? 1.25 : -0.75], i * 6);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const records = new Float32Array(48),
    frame = new Float32Array(44);
  let kept = 0,
    dropped = 0;
  for (let n = 0; n < 4000; n++) {
    const at = (n & 1) * 24;
    for (let k = 0; k < 12; k++) records[at + k] = random() * 3;
    // Planes at random offsets, a third of them through the box region, so both outcomes occur.
    records.set([random() * 30, random() * 30, random() * 30, 1], at + 12);
    for (let p = 16; p < 40; p += 4) {
      frame.set([random(), random(), random()], p);
      frame[p + 3] = random() * 20 + (n % 3 === 0 ? 0 : 15);
    }
    const want = reference(records, at, vertices, frame);
    assert.equal(cpu(records, at, vertices, 6, 0, frame), want, `case ${n}`);
    want ? kept++ : dropped++;
  }
  assert.ok(kept > 100 && dropped > 100, `both outcomes covered (${kept} kept, ${dropped} dropped)`);
});
