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
  return { line, frame, setup };
}

test('colorMode defaults to multiply and rejects unknown modes', () => {
  assert.equal(new LineMaterial().colorMode, 'multiply');
  assert.equal(new Line({ colorMode: 'add' }).material.colorMode, 'add');
  assert.throws(() => new LineMaterial({ colorMode: 'blend' }), { name: 'TypeError', message: /colorMode/ });
});

test('colorMode reaches the style flags (bits 128 set, 256 add) only where the line has colours, live', () => {
  const r = rig({ colors: [1, 0, 0, 0, 0, 1] });
  const flags = (log) => new Uint32Array(styleWrites(log)[0])[30];
  assert.equal(flags(r.frame()) & 0x1c0, 64, 'multiply: vertex colours only');
  r.line.material.colorMode = 'set';
  assert.equal(flags(r.frame()) & 0x1c0, 64 | 128);
  r.line.material.colorMode = 'add';
  assert.equal(flags(r.frame()) & 0x1c0, 64 | 256);
  r.line.setColors(null);
  assert.equal(flags(r.frame()) & 0x1c0, 0, 'no per-point colours: the material colour stays');
});

test('the shader combines point and material colour in one helper for lines and ribbons', () => {
  const [code] = modules(rig().setup);
  assert.match(code, /fn tinted\(p:vec4f,bits:u32,fade:f32\)->vec4f/);
  assert.match(code, /if\(\(bits&128u\)!=0u\)\{rgb=p\.rgb;\}else if\(\(bits&256u\)!=0u\)/);
  assert.match(code, /o\.color=tinted\(select\(colA,colB,cr\.atB\),bits,fade\);/);
});
