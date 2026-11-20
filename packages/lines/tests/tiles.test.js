import test from 'node:test';
import assert from 'node:assert/strict';
import { setLineCameraTile } from '@margoengine/lines/tiles';
import { Line } from '@margoengine/lines';
import { LinePicking } from '../dist/pick.js';
import { rig } from './gpu-rig.js';
const frameUniform = (log, bytes = 112) => {
  const written = log.find((e) => e[0] === 'writeBuffer' && e[3].length === bytes * 2);
  return new Float32Array(Uint8Array.from(Buffer.from(written[3], 'hex')).buffer);
};

// First in the file: the tile row is installed on the first setLineCameraTile of the page, never on import.
test('a renderer set up before the first tile rebuilds its Frame once: layout, buffer, pipelines and every vertex end', () => {
  const { camera, lines, frame, gpu } = rig();
  lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0, 2, 0, 0] }));
  lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0, 2, 0, 0], dashed: true, dashCap: 'round', onTop: true }));
  assert.equal(frameUniform(frame(), 96)[0], camera.matrix[0], 'importing lines/tiles alone keeps the base Frame');
  const remove = setLineCameraTile(camera, {
    matrix: camera.matrix,
    fullWidth: 128,
    fullHeight: 128,
    x: 64,
    y: 64,
    width: 64,
    height: 64,
  });
  const log = frame();
  const layouts = new Map(log.filter((e) => e[0] === 'layout').map((e) => [e[1], e[2]])),
    frames = [...layouts.values()].filter((l) => l.entries[0].buffer?.minBindingSize === 112);
  assert.equal(frames.length, 1, 'one tile-row frame layout');
  assert.ok(log.some((e) => e[0] === 'buffer' && e[2].size === 112));
  const modules = log.filter((e) => e[0] === 'module').map((e) => e[2].code);
  assert.ok(modules.length >= 2);
  for (const code of modules) {
    assert.equal(
      code.split('struct Frame{viewProj:mat4x4f,viewport:vec4f,extra:vec4f,tile:vec4f}\nfn captureClip(').length,
      2,
    );
    // Every vertex function crops its finished vertex, once, right before it returns.
    assert.equal(
      code.match(/@vertex/g).length,
      code.match(/\n {2}o\.clip=captureClip\(o\.clip\);\n {2}return o;\n\}/g).length,
    );
  }
  assert.equal(log.filter((e) => e[0] === 'renderPipeline').length, 2, 'pipelines remade with the new layout');
  assert.deepEqual(
    frame().filter((e) => e[0] === 'layout' || e[0] === 'module'),
    [],
    'the rebuild happens once',
  );
  // Picking follows the Lines frame: its frame buffer and shaders take the tile row too.
  lines['engine'] = { canvas: { clientWidth: 64, width: 64 }, createMesh: () => ({ dispose() {} }) };
  const picking = LinePicking.attach({ addOverlay: () => () => {} }, lines),
    view = gpu.device.createTexture({ size: [3, 3], format: 'r32uint' }).createView(),
    pick = gpu.record(() =>
      picking.drawPick({
        encoder: gpu.encoder,
        color: view,
        depth: view,
        matrix: new Float32Array(16).fill(0.5),
        camera,
        rect: [0, 0, 64, 64],
        firstId: 1,
      }),
    );
  assert.ok(pick.some((e) => e[0] === 'buffer' && e[2].size === 112));
  const picked = frameUniform(pick);
  assert.equal(picked[21], 0, 'a pick crops its own matrix, not the tile');
  assert.deepEqual([...picked.subarray(24)], [1, 1, 0, 0]);
  for (const e of pick.filter((e) => e[0] === 'module')) assert.match(e[2].code, /o\.clip=captureClip\(o\.clip\);/);
  picking.dispose();
  remove();
  lines.dispose();
});

test('capture frame uses the uncropped projection and full pixel density, with an isolated removable tile transform', () => {
  const { camera, lines, frame } = rig();
  lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0] }));
  const original = camera.matrix.slice(),
    before = frameUniform(frame());
  const options = { matrix: original, fullWidth: 256, fullHeight: 128, x: 64, y: 0, width: 64, height: 64 };
  const remove = setLineCameraTile(camera, options);
  original.fill(0);
  camera.matrix[0] = 100;
  const captured = frameUniform(frame());
  assert.deepEqual([...captured.subarray(0, 16)], [...before.subarray(0, 16)]);
  assert.deepEqual([...captured.subarray(16, 19)], [256, 128, 4]);
  assert.equal(captured[21], 1);
  // 2 over the viewport size, then the pixel offset from the image centre to the viewport centre: (256 - 128 - 64) / 2
  // and (0 + 64 - 128) / 2. Every value is exact in float32.
  assert.deepEqual([...captured.subarray(24)], [1 / 32, 1 / 32, 32, -32]);
  remove();
  remove();
  const after = frameUniform(frame());
  assert.equal(after[0], 100);
  assert.equal(after[21], 0);
  assert.deepEqual([...after.subarray(24)], [1, 1, 0, 0]);
  lines.dispose();
});

test('invalid tile state rejects before publication, and an older remover cannot erase its replacement', () => {
  const { camera, lines, frame } = rig();
  lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0] }));
  const tile = { matrix: camera.matrix, fullWidth: 256, fullHeight: 128, x: 64, y: 0, width: 64, height: 64 };
  for (const change of [{ width: 0 }, { x: -1 }, { x: 256 }, { y: 128 }, { matrix: [] }, { fullHeight: Infinity }])
    assert.throws(() => setLineCameraTile(camera, { ...tile, ...change }), RangeError);
  const old = setLineCameraTile(camera, tile),
    current = setLineCameraTile(camera, { ...tile, x: 0 });
  old();
  assert.equal(frameUniform(frame())[26], 96);
  current();
  assert.equal(frameUniform(frame())[21], 0);
  lines.dispose();
});

// Apple Metal coloured 164 of 307,200 values 1 apart between 64 px tiles and one whole-image tile: the capture step
// scaled the snapped vertex by tile over image size, which float32 rounds unless both are powers of two, so window
// positions moved off the 1/256 pixel grid by different amounts per tile. Now every step is exact for a power-of-two
// viewport, which a viewport may reach past the image's right and bottom edges to have.
test('capture window positions of power-of-two viewports are the whole image pixels moved by whole pixels, exactly', () => {
  const { camera, lines, frame } = rig();
  lines.add(new Line({ positions: [0, 0, 0, 1, 1, 0] }));
  const f = Math.fround,
    fullWidth = 320,
    fullHeight = 240;
  // captureClip and the viewport transform in float32, for a snapped pixel (from the image centre, y up) and w = 1.
  const window = ([sx, sy, ox, oy], [width, height], [px, py]) => [
    f(f(f(f(px + ox) * sx) * f(width / 2)) + width / 2),
    f(height / 2 - f(f(f(py + oy) * sy) * f(height / 2))),
  ];
  const whole = { matrix: camera.matrix, fullWidth, fullHeight, x: 0, y: 0, width: 512, height: 256 };
  const remove = setLineCameraTile(camera, whole),
    wholeRow = [...frameUniform(frame()).subarray(24)];
  for (const [x, y] of [
    [64, 0],
    [256, 192],
    [128, 64],
  ]) {
    setLineCameraTile(camera, { ...whole, x, y, width: 256, height: 256 });
    const row = [...frameUniform(frame()).subarray(24)];
    for (let i = 0; i < 2000; i++) {
      // Grid points across the image and up to 2 image widths past its edges.
      const pixel = [((i * 37.1234) % 1600) - 800, ((i * 0.731) % 1200) - 600].map((v) => Math.round(v * 256) / 256);
      const [wx, wy] = window(wholeRow, [512, 256], pixel),
        [tx, ty] = window(row, [256, 256], pixel);
      assert.deepEqual([tx + x, ty + y], [wx, wy], `pixel ${pixel}`);
    }
  }
  remove();
  lines.dispose();
});
