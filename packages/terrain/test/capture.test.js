import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Terrain } from '../dist/index.js';

/** A Terrain on the recording mock and a frame driver; `hook` is a stand-in for SSR's capture hook. */
function rig(options = {}) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      removePlugin() {},
    };
  const terrain = new Terrain({
    resolution: 8,
    levels: 2,
    size: [32, 32],
    heightScale: 1,
    layers: Array.from({ length: 4 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
    textures: (device) => ({
      heightmap: device.createTexture({ size: [2, 2], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING }),
      layers: device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING }),
    }),
    ...options,
  });
  terrain.setup(engine);
  const passes = [];
  terrain.registerPasses({ add: (p) => passes.push(p) });
  passes.sort((a, b) => a.order - b.order);
  const view = context(gpu, { samples: 4, format: 'rgba16float', shader: '' }),
    drawn = [];
  let index = 0;
  const pass = {
    setPipeline: (p) => drawn.push(['pipeline', p]),
    setBindGroup: (i) => drawn.push(['group', i]),
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    drawIndexed: (n) => drawn.push(['draw', n]),
  };
  const hook = {
    targets: [{ format: 'rgba16float' }, { format: 'rgb10a2unorm' }, { format: 'rgb10a2unorm' }],
    declarations: () =>
      'struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}\nfn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {return MargoSSR(vec4f(rough),vec4f(1),vec4f(n,1));}\n',
    begin: () => pass,
  };
  return {
    gpu,
    terrain,
    view,
    hook,
    drawn,
    frame() {
      view.begin(index++);
      for (const p of passes) p.execute(view.c);
      view.end();
    },
  };
}
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test("terrain draws its material into SSR's capture hook, depth tested and written", () => {
  const r = rig({ roughness: 0.2 });
  r.frame();
  assert.doesNotThrow(() => r.terrain.draw(r.view.c, 'capture'), 'no hook: nothing');
  assert.equal(r.drawn.length, 0);
  const stop = r.terrain.setCapture(r.hook);
  const log = r.gpu.record(() => r.terrain.draw(r.view.c, 'capture'));
  const code = modules(log)[0],
    pipeline = log.find((e) => e[0] === 'renderPipeline')[2];
  assert.match(code, /fn margoShade\(i:Output\)->vec4f \{/, 'the beauty fragment kept as a plain function');
  assert.match(
    code,
    /@fragment fn capture\(i:Output\)->MargoSSR \{.*return margoSSR\(n,v,base,i\.material\.y,i\.material\.x\);\}/,
  );
  assert.match(code, /o\.material=vec4f\(0\.2,0,1,1\)/, 'roughness option');
  assert.equal(pipeline.fragment.entryPoint, 'capture');
  assert.deepEqual(
    pipeline.fragment.targets.map((t) => t.format),
    ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm'],
  );
  assert.deepEqual(
    [pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled],
    ['greater-equal', true],
  );
  assert.deepEqual(
    r.drawn.filter((d) => d[0] === 'draw').map((d) => d[1] > 0),
    [true, true],
    'centre and ring, on the hook pass',
  );
  r.drawn.length = 0;
  assert.equal(modules(r.gpu.record(() => r.terrain.draw(r.view.c, 'capture'))).length, 0, 'pipeline cached');
  stop();
  r.terrain.draw(r.view.c, 'capture');
  assert.equal(r.drawn.filter((d) => d[0] === 'draw').length, 2, 'the remover detaches the hook');
});

test('terrain roughness is optional and validated; onDispose runs once', () => {
  const plain = rig(),
    log = plain.gpu.record(() => plain.frame());
  assert.match(modules(log)[0], /o\.material=vec4f\(0\.9,0,1,1\)/, 'default unchanged');
  for (const roughness of [-0.1, 1.5, Number.NaN]) assert.throws(() => rig({ roughness }), RangeError);
  assert.throws(() => plain.terrain.setCapture({}), TypeError);
  let calls = 0;
  plain.terrain.onDispose(() => calls++);
  const removed = plain.terrain.onDispose(() => calls++);
  removed();
  plain.terrain.dispose();
  plain.terrain.dispose();
  assert.equal(calls, 1);
});

test('with TerrainLayer.bump the capture entry shades with the bumped normal, as the lit fragment does', () => {
  const r = rig({
    layers: Array.from({ length: 4 }, (_, i) => ({ height: [-10, 10], slope: [0, 1], scale: 1, bump: i ? 0 : 1 })),
  });
  r.frame();
  r.terrain.setCapture(r.hook);
  const code = modules(r.gpu.record(() => r.terrain.draw(r.view.c, 'capture')))[0],
    shading =
      'let terrainN=normalize(i.normal);let base=terrainColor(i.position,terrainN);let n=terrainBump(i.position,terrainN);';
  assert.equal(code.split(shading).length, 3, 'in margoShade and in capture');
  assert.match(code, /@fragment fn capture\(i:Output\)->MargoSSR \{if\(any[^\n]*let n=terrainBump/);
});
