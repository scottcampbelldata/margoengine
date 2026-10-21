import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Water } from '../dist/index.js';

const floats = (hex) => new Float32Array(new Uint8Array(Buffer.from(hex, 'hex')).buffer);
const modules = (log) =>
  log.filter((e) => e[0] === 'module' && e[2].code.includes('fn surface(')).map((e) => e[2].code);
const linear = (byte) => Math.fround(((byte / 255 + 0.055) / 1.055) ** 2.4);

function rig() {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 4, format: 'rgba16float' }),
    depth = gpu.device.createTexture({
      size: [1280, 720],
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  const water = new Water({ depth: () => depth });
  water.setup({
    gpu: gpu.device,
    lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
    stats: { drawCalls: 0 },
    removePlugin() {},
  });
  const passes = [];
  water.registerPasses({ add: (p) => passes.push(p) });
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {} };
  water.setCapture({
    targets: [{ format: 'rgba16float' }, { format: 'rgb10a2unorm' }, { format: 'rgb10a2unorm' }],
    declarations: () =>
      'struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}\n',
    begin: () => pass,
  });
  let index = 0;
  return {
    gpu,
    water,
    view,
    frame: () =>
      gpu.record(() => {
        view.begin(index++);
        for (const p of passes) p.execute(view.c);
        view.end();
      }),
  };
}

test('Water.setFog mixes fog where environment Fog does; the SSR capture and null stay unfogged', () => {
  const r = rig(),
    plain = modules(r.frame())[0];
  assert.match(plain, /if\(frame\.cameraData\.w<0\.5\)\{color=toDisplay\(color\);\}/);
  assert.doesNotMatch(plain, /margoFog|fogAmount/);
  const fog = { color: '#8090a0', density: 0.09, heightFalloff: 0.2, height: -1 };
  assert.equal(r.water.setFog(fog), r.water);
  const log = r.frame(),
    code = modules(log)[0];
  assert.equal(
    code.replace(
      'let fogA=fogAmount(i.world);if(frame.cameraData.w<0.5){let mapped=mix(pbrNeutral(max(color,vec3f(0))),margoFog.color.rgb,fogA);color=select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308));}else{color=mix(color,margoFog.color.rgb,fogA);}',
      'if(frame.cameraData.w<0.5){color=toDisplay(color);}',
    ),
    plain + code.slice(code.indexOf('\nstruct MargoFog')),
    'after tone mapping and before the sRGB encode on the canvas, in linear on HDR; nothing else changes',
  );
  assert.match(code, /@group\(0\) @binding\(8\) var<uniform> margoFog:MargoFog;/);
  // Surface groups (the depth copy has its own one-entry group).
  const surfaceGroups = (entries) => entries.filter((e) => e[0] === 'group' && e[2].entries.length >= 8),
    groups = surfaceGroups(log).map((e) => e[2].entries);
  assert.ok(groups.length && groups.every((entries) => entries.length === 9 && entries[8].binding === 8));
  const [values] = log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 96).map((e) => floats(e[3]));
  assert.deepEqual(
    [...values.subarray(0, 8)],
    [linear(0x80), linear(0x90), linear(0xa0), -1, 1, 1000, Math.fround(0.09), Math.fround(0.2)],
  );
  assert.deepEqual([...values.subarray(8, 11)], [...r.view.camera.position].map(Math.fround), 'the camera position');
  const capture = r.gpu.record(() => r.water.draw(r.view.c, 'capture'));
  assert.doesNotMatch(modules(capture)[0], /fogAmount\(i\.world\)/, 'SSR capture replaces the fogged tail');
  assert.ok(
    capture.filter((e) => e[0] === 'group').every((e) => e[2].entries.length === 8),
    'no fog binding',
  );
  fog.enabled = false;
  assert.deepEqual(modules(r.frame()), [], 'switching enabled never compiles');
  r.water.setFog(null);
  const back = r.frame();
  assert.equal(modules(back)[0], plain, 'null compiles the original shader again');
  assert.ok(surfaceGroups(back).length && surfaceGroups(back).every((e) => e[2].entries.length === 8));
  assert.throws(() => r.water.setFog(1), TypeError);
  assert.throws(() => r.water.setFog({ far: Infinity }), RangeError);
  r.water.dispose();
});
