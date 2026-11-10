import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Water } from '../dist/index.js';

/** A Water on the recording mock with its own depth texture, and a stand-in for SSR's capture hook. */
function rig() {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 4, format: 'rgba16float' }),
    depth = gpu.device.createTexture({
      size: [1280, 720],
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  const engine = {
    gpu: gpu.device,
    lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
    stats: { drawCalls: 0 },
    sceneOf() {
      return { removePlugin() {} };
    },
  };
  const water = new Water({ depth: () => depth });
  water.setup(engine);
  const passes = [];
  water.registerPasses({ add: (p) => passes.push(p) });
  const drawn = [],
    pass = {
      setPipeline: (p) => drawn.push(['pipeline', p]),
      setBindGroup: (i, g) => drawn.push(['group', i, g]),
      setVertexBuffer: () => {},
      setIndexBuffer: () => {},
      drawIndexed: (n) => drawn.push(['draw', n]),
    };
  const hook = {
    targets: [{ format: 'rgba16float' }, { format: 'rgb10a2unorm' }, { format: 'rgb10a2unorm' }],
    declarations: () =>
      'struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}\n',
    begin: () => pass,
  };
  let index = 0;
  return {
    gpu,
    water,
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

test("water draws its sky reflection, weight and normal into SSR's capture hook", () => {
  const r = rig();
  r.water.setCapture(r.hook);
  r.water.draw(r.view.c, 'capture');
  assert.equal(r.drawn.length, 0, 'nothing before its first frame');
  r.frame();
  const log = r.gpu.record(() => r.water.draw(r.view.c, 'capture')),
    code = modules(log)[0],
    pipeline = log.find((e) => e[0] === 'renderPipeline')[2];
  assert.match(code, /@fragment fn fragment\(i:Output\)->MargoSSR\{/);
  assert.match(
    code,
    /let keep=reflection\*\(1\.0-0\.95\*foam\);_=body;_=glint\*shade;return MargoSSR\(vec4f\(skyColor\(reflect\(-v,n\),rough\)\*keep,rough\),vec4f\(vec3f\(keep\),1\),vec4f\(n\*0\.5\+0\.5,1\)\);/,
    'the sky reflection it added, times Fresnel and the foam share, as the specular SSR replaces',
  );
  assert.doesNotMatch(code, /return Result\(/);
  assert.deepEqual(
    [pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled],
    ['greater-equal', true],
    'its depth goes into what SSR traces',
  );
  assert.equal(pipeline.layout, 'auto');
  assert.ok(
    log.some((e) => e[0] === 'group'),
    'its own group 0 for the capture layout',
  );
  assert.equal(r.drawn.filter((d) => d[0] === 'draw').length, 1);
  r.drawn.length = 0;
  r.frame();
  assert.equal(modules(r.gpu.record(() => r.water.draw(r.view.c, 'capture'))).length, 0, 'pipeline and groups cached');
  let disposed = 0;
  r.water.onDispose(() => disposed++);
  r.water.dispose();
  r.water.draw(r.view.c, 'capture');
  assert.equal(disposed, 1);
  assert.equal(r.drawn.filter((d) => d[0] === 'draw').length, 1, 'nothing after disposal');
});
