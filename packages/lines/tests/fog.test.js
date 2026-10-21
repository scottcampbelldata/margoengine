import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Lines, Line } from '../dist/index.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const floats = (hex) => new Float32Array(new Uint8Array(Buffer.from(hex, 'hex')).buffer);
const linear = (byte) => Math.fround(((byte / 255 + 0.055) / 1.055) ** 2.4);
const fogWrites = (log) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 96).map((e) => floats(e[3]));
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

function rig() {
  const gpu = mockGPU(),
    lines = new Lines(),
    camera = new Camera({ position: [0, 1, 8], target: [0, 1, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  camera.update(1, true);
  const setup = gpu.record(() => lines.setup({ backend: 'webgpu', gpu: gpu.device, canvas: { clientWidth: 64 } }));
  const line = lines.add(new Line({ positions: [-1, 0, 0, 1, 0, 0] })),
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

test('Lines.setFog fogs lines with a second shader and a 48-byte uniform; null keeps the original draw', () => {
  const r = rig(),
    plain = modules(r.setup)[0];
  assert.doesNotMatch(plain, /margoFog|fogAmount/, 'the original shader has no fog');
  const unfogged = r.frame();
  assert.deepEqual(modules(unfogged), []);
  assert.deepEqual(fogWrites(unfogged), []);
  assert.ok(!unfogged.some((e) => e[0] === 'pass.setBindGroup' && e[1] === 2));

  const fog = { color: '#8090a0', near: 5, far: 12, heightFalloff: 0.35, height: 0.5 };
  assert.equal(r.lines.setFog(fog), r.lines);
  assert.equal(r.lines.fog, fog);
  const fogged = r.frame(),
    code = modules(fogged)[0];
  assert.match(code, /struct MargoFog \{color:vec4f,params:vec4f,eye:vec4f\}/);
  assert.match(code, /@group\(2\) @binding\(0\) var<uniform> margoFog:MargoFog;/);
  assert.match(code, /rgb=mix\(rgb,margoFog\.color\.rgb,fogAmount\(i\.world\)\);/, 'mixed before the sRGB encode');
  assert.ok(code.indexOf('fogAmount(i.world)') < code.indexOf('if(frame.extra.x>0.5){rgb=encode'));
  const stripped = code
    .replace('@location(3) world:vec3f,', '')
    .replace(
      'let wa=style.model*vec4f(points[ia].xyz,1.0);let wb=style.model*vec4f(points[ib].xyz,1.0);o.world=mix(wa.xyz/wa.w,wb.xyz/wb.w,select(ta,tb,cr.atB));',
      '',
    )
    .replace('rgb=mix(rgb,margoFog.color.rgb,fogAmount(i.world));', '');
  assert.equal(stripped.slice(0, plain.length), plain, 'the fogged shader is the original plus the fog lines');
  assert.match(stripped.slice(plain.length), /^\nstruct MargoFog/);
  const layout = fogged.find((e) => e[0] === 'pipelineLayout');
  assert.equal(layout[2].bindGroupLayouts.length, 3, 'frame, style and fog groups');
  assert.ok(fogged.some((e) => e[0] === 'pass.setBindGroup' && e[1] === 2));
  const [values] = fogWrites(fogged);
  assert.deepEqual(
    [...values],
    [linear(0x80), linear(0x90), linear(0xa0), 0.5, 5, 12, 0, Math.fround(0.35), 0, 1, 8, 0],
    'linear colour and height, near, far, density, falloff, camera position',
  );

  fog.enabled = false;
  const [off] = fogWrites(r.frame());
  assert.deepEqual([...off.subarray(0, 8)], [0, 0, 0, 0, 3.4028234663852886e38, 3.4028234663852886e38, 0, 0]);
  assert.deepEqual(modules(r.frame()), [], 'switching enabled never compiles');

  r.line.material.fog = false;
  const cleared = r.frame();
  assert.deepEqual(fogWrites(cleared), [], 'a material with fog false draws unfogged');
  r.line.material.fog = true;
  r.lines.setFog(null);
  const back = r.frame();
  assert.deepEqual(fogWrites(back), []);
  assert.ok(!back.some((e) => e[0] === 'pass.setBindGroup' && e[1] === 2));
});

test('setFog and material.fog validate their input with the fix in the message', () => {
  const lines = new Lines();
  for (const bad of [5, 'fog', [1, 2, 3], true]) assert.throws(() => lines.setFog(bad), TypeError);
  assert.throws(() => lines.setFog({ near: -1 }), /Fog near is -1; pass a finite number, 0 or more/);
  assert.throws(() => lines.setFog({ density: Number.NaN }), RangeError);
  assert.throws(() => lines.setFog({ height: Infinity }), RangeError);
  assert.throws(() => lines.setFog({ enabled: 'yes' }), /Fog enabled is yes; pass true or false/);
  assert.throws(() => lines.setFog({ color: 'red' }), TypeError);
  assert.equal(lines.setFog({}).fog?.color, undefined, "missing fields take Fog's defaults");
  assert.throws(() => new Line({ fog: 1 }), TypeError);
});
