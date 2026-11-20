// Bug KB-COMPAT-FRAMEALLOC1 (scripts/frame-alloc-browser.mjs under MARGO_COMPAT=1, 2026-11-16): the layer's replay
// allocated JavaScript heap on every draw of a steady frame. The GL state cache keyed its values by template strings
// (`${id}:${offset}:${size}` per uniform buffer, one per mask, blend and stencil value), the per-program cache by
// string keys, a draw that split its targets made a closure, the texture plan made arrays and a Map per draw and
// Map.clear() a new table. The cache now compares numbers in slots (gl.ts S), the plan reuses arrays and the
// pipeline's target state is worked out once when it is made. The probe (support/replay-alloc-probe.mjs) replays the
// draws of one real pipeline (a uniform buffer, a texture and sampler, vertex and index buffers, blend, depth, cull)
// inside an open pass: the code before the fix read 1,352 B a draw and 1,360 B an indexed draw; now 0 B each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The V8 flags of tests/frame-alloc.test.js at the repository root, which gives the reason for each.
const HEAP = [
  '--min-semi-space-size=16',
  '--max-semi-space-size=16',
  '--single-threaded-gc',
  '--no-concurrent-recompilation',
  '--no-concurrent-sparkplug',
];

// Part 3 (2026-11-17): a render pass begun and ended (the code before made a key string, an owner list, closures,
// arrays and a pass object each pass) and queue.writeBuffer from a kept staging array (before: a Uint8Array view and a
// one-entry list a write) are measured by the same probe, also 0 B.
// Part 4 (2026-11-17): a frame's commands encoded, finished and submitted (the code before made a closure a command, a
// descriptor snapshot and an owner list each pass and a list each bind group: 2,418 B a frame in the probe's one-draw
// frame; 603 B after the tape). Part 5 (the queue: submit read its buffers through an iterator, wrote a list that
// shrank to length 0 each time, and flushPresents copied a Set) leaves only the objects WebGPU returns each call, which
// the bound below names: a command encoder (72 B on Node 26, which has no pointer compression, so twice a browser's),
// a render pass encoder (40 B) and a command buffer (72 B), 184 B.
// Part 6 (compute dispatches: a recorded compute pass replays through reused slots, a draw's uniforms are fields of its
// record, the target views and word-texture views are cached, and a storage group's rows are read by index): a pass of
// one dispatch cost 2,347 B on the fragment tier and 3,139 B on the scatter tier; now the same three objects plus a
// compute pass encoder (56 B), 202 B.
// Part 7 (encoder copies: copyBufferToBuffer and copyTextureToTexture are tape opcodes with their regions as numbers; they
// made a closure and two option-object copies each, and the replay made arrays for origins and sizes): an encoder,
// the copy and a command buffer, under the same bound as a frame of one draw.
// Part 9 (2026-11-17): a large write into a buffer that keeps a CPU copy (storage, uniform) made a view of its range each
// time, and an indirect draw or dispatch read its words through a sliced copy and a typed array: both 0 B now.
// Part 10 (2026-11-18): the objects WebGPU returns each call carry one or two fields, as a browser's do: a label is the
// prototype's '' unless given, the device is reached through the tape's pool, and whether a compute pass set a pipeline
// is held on the tape. On Node 26 (no pointer compression) an encoder is 40 B, a render or compute pass encoder 32 B and
// a command buffer 40 B; before, 72, 40, 56 and 72 B (encode read 146 B, a copy 105 B and a dispatch 161 B). A view of a
// texture made with no descriptor shares the texture's default range: 32 B, the view itself (before: 160 B, ten fields
// and a default `{}`). A pass of two colour targets after one of none, and a sampled '2d' view of an array texture's
// layer, read 16 B and 232 B a call before; 0 B now.
const ENCODE_BOUND = 128,
  COPY_BOUND = 96,
  DISPATCH_BOUND = 128,
  VIEW_BOUND = 40;
test('a steady draw, pass and buffer write replay without allocating', () => {
  const { bytes, errors, refused, draws } = JSON.parse(
    execFileSync(
      process.execPath,
      ['--expose-gc', ...HEAP, fileURLToPath(new URL('./support/replay-alloc-probe.mjs', import.meta.url))],
      { encoding: 'utf8', timeout: 240_000 },
    ),
  );
  assert.deepEqual(errors, {});
  // Every draw measured was a draw: none refused (a refusal would measure its message) and all counted.
  assert.deepEqual(refused, []);
  assert.ok(draws > 0);
  assert.deepEqual(Object.keys(bytes).sort(), [
    'copyBuffer',
    'copyTexture',
    'dispatchBuffer',
    'dispatchTexture',
    'draw',
    'drawIndexed',
    'drawIndirect',
    'encode',
    'pass',
    'passMix',
    'sampledLayer',
    'view',
    'writeBuffer',
    'writeStorage',
  ]);
  for (const [kind, windows] of Object.entries(bytes)) {
    const median = [...windows].sort((a, b) => a - b)[windows.length >> 1],
      most =
        kind === 'encode'
          ? ENCODE_BOUND
          : kind.startsWith('copy')
            ? COPY_BOUND
            : kind.startsWith('dispatch')
              ? DISPATCH_BOUND
              : kind === 'view'
                ? VIEW_BOUND
                : 1;
    assert.ok(median < most, `a ${kind} allocated ${median} B, over ${most} B (Node ${process.version}, V8 ${process.versions.v8})`);
  }
});
