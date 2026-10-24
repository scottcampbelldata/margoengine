import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Lines, Line, LineMaterial } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const STYLE_BYTES = 224;
const bytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex')).buffer;
const styleWrites = (log) =>
  log.filter((e) => e[0] === 'writeBuffer' && e[3].length === STYLE_BYTES * 2).map((e) => bytes(e[3]));
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

function rig(options = {}) {
  const gpu = mockGPU(),
    lines = new Lines(),
    camera = new Camera({ position: [0, 1, 8], target: [0, 1, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  const setup = gpu.record(() => lines.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } }));
  const line = lines.add(new Line({ positions: [-1, 0, 0, 1, 0, 0], ...options })),
    run = passes(lines),
    frame = () =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      );
  return { lines, line, frame, setup };
}

test('LineMaterial.clippingPlanes validates, normalises and returns copies', () => {
  const m = new LineMaterial();
  assert.deepEqual(m.clippingPlanes, [], 'none by default');
  m.clippingPlanes = [
    [0, 2, 0, -4],
    [3, 0, 4, 10],
  ];
  assert.deepEqual(m.clippingPlanes, [
    [0, 1, 0, -2],
    [0.6, 0, 0.8, 2],
  ]);
  m.clippingPlanes[0][0] = 9;
  assert.equal(m.clippingPlanes[0][0], 0, 'the getter hands out copies');
  assert.deepEqual(new LineMaterial({ clippingPlanes: [[1, 0, 0, 0]] }).clippingPlanes, [[1, 0, 0, 0]]);
  assert.deepEqual(new Line({ clippingPlanes: [[0, 0, -5, 5]] }).material.clippingPlanes, [[0, 0, -1, 1]]);
  assert.throws(() => (m.clippingPlanes = Array(7).fill([1, 0, 0, 0])), /holds at most 6 planes; pass fewer/);
  assert.throws(() => (m.clippingPlanes = Array(7).fill([1, 0, 0, 0])), RangeError);
  assert.throws(() => (m.clippingPlanes = 'x'), TypeError);
  assert.throws(() => (m.clippingPlanes = [[1, 0, 0]]), /four finite numbers/);
  assert.throws(() => (m.clippingPlanes = [[1, 0, NaN, 0]]), TypeError);
  assert.throws(() => (m.clippingPlanes = [[1, 0, 0, 1e39]]), TypeError, 'beyond Float32');
  assert.throws(() => (m.clippingPlanes = [[0, 0, 0, 1]]), /non-zero normal/);
  assert.deepEqual(m.clippingPlanes.length, 2, 'a rejected list keeps the previous planes');
  m.clippingPlanes = Array(6).fill([0, 0, 1, 0]);
  assert.equal(m.clippingPlanes.length, 6);
});

test('the shader carries the world varying and the discard loop; one shader for clipped and unclipped lines', () => {
  const r = rig(),
    [code] = modules(r.setup);
  assert.match(code, /struct Style\{model:mat4x4f,color:vec4f,a:vec4f,b:vec4f,flags:vec4u,planes:array<vec4f,6>\}/);
  assert.match(code, /@location\(3\) world:vec3f,/);
  assert.match(code, /o\.world=mix\(wa\.xyz\/wa\.w,wb\.xyz\/wb\.w,select\(ta,tb,cr\.atB\)\);/);
  assert.match(
    code,
    /for\(var p=0u;p<clipCount;p\+\+\)\{if\(dot\(style\.planes\[p\]\.xyz,i\.world\)\+style\.planes\[p\]\.w<0\.0\)\{clipBehind\+\+;\}\}\s*if\(clipCount>0u&&select\(clipBehind>0u,clipBehind==clipCount,\(style\.flags\.w&65536u\)!=0u\)\)\{discard;\}/,
  );
  const layout = r.setup.filter((e) => e[0] === 'layout')[1];
  assert.equal(layout[2].entries[0].buffer.minBindingSize, STYLE_BYTES);
  const first = r.frame();
  assert.equal(first.find((e) => e[0] === 'buffer' && e[2].size === STYLE_BYTES)?.[2].size, STYLE_BYTES);
  r.line.material.clippingPlanes = [[1, 0, 0, 0]];
  const clipped = r.frame();
  assert.deepEqual(modules(clipped), [], 'adding planes compiles nothing');
  assert.equal(clipped.filter((e) => e[0] === 'renderPipeline').length, 0, 'and makes no pipeline');
});

test('planes reach the Style uniform at byte 128 with their count in flags.w, live', () => {
  const r = rig({ color: [0.5, 0.25, 1] });
  const [plain] = styleWrites(r.frame());
  assert.equal(new Uint32Array(plain)[31], 0, 'unclipped lines write count 0');
  assert.deepEqual([...new Float32Array(plain, 128)], Array(24).fill(0));
  assert.deepEqual([...new Float32Array(plain, 64, 3)], [0.5, 0.25, 1], 'the rest of the style is unchanged');
  assert.deepEqual(styleWrites(r.frame()), [], 'unchanged style is not rewritten');

  r.line.material.clippingPlanes = [
    [0, 2, 0, -1],
    [1, 0, 0, 3],
  ];
  const [clipped] = styleWrites(r.frame());
  assert.equal(new Uint32Array(clipped)[31], 2);
  assert.deepEqual([...new Float32Array(clipped, 128, 8)], [0, 1, 0, -0.5, 1, 0, 0, 3]);
  assert.deepEqual([...new Float32Array(clipped, 160)], Array(16).fill(0), 'unused slots are zero');
  assert.deepEqual(styleWrites(r.frame()), []);

  r.line.material.clippingPlanes = [[0, 0, -1, 2]];
  const [one] = styleWrites(r.frame());
  assert.equal(new Uint32Array(one)[31], 1);
  assert.deepEqual(
    [...new Float32Array(one, 128)],
    [0, 0, -1, 2, ...Array(20).fill(0)],
    'a shorter list clears the rest',
  );

  r.line.material.clippingPlanes = [];
  const [cleared] = styleWrites(r.frame());
  assert.equal(new Uint32Array(cleared)[31], 0);
  assert.deepEqual([...new Float32Array(cleared, 128)], Array(24).fill(0));
});

test('clipIntersection sets bit 16 of flags.w beside the plane count, live and validated', () => {
  const r = rig({
    clippingPlanes: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ],
  });
  assert.equal(new Uint32Array(styleWrites(r.frame())[0])[31], 2, 'union by default');
  r.line.material.clipIntersection = true;
  assert.equal(new Uint32Array(styleWrites(r.frame())[0])[31], 65536 + 2, 'intersection bit plus the count');
  r.line.material.set({ clipIntersection: false });
  assert.equal(new Uint32Array(styleWrites(r.frame())[0])[31], 2);
  assert.equal(new LineMaterial({ clipIntersection: true }).clipIntersection, true);
  r.line.material.clipIntersection = 1;
  assert.throws(() => r.frame(), TypeError);
});

test('fogged lines keep the clipping loop', () => {
  const r = rig({ clippingPlanes: [[1, 0, 0, 0]] });
  r.lines.setFog({ color: '#808080', near: 1, far: 10 });
  const [code] = modules(r.frame());
  assert.match(code, /fogAmount\(i\.world\)/);
  assert.match(code, /style\.planes\[p\]/);
  assert.equal(code.split('@location(3) world:vec3f').length, 2, 'one world varying');
});
