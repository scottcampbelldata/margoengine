import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { PostStack } from '../../post/dist/index.js';
import { Tonemap } from '../../tonemap/dist/index.js';
import { NodePass } from '../dist/index.js';
import * as E from '../dist/effects.js';

function stack(samples = 4) {
  const gpu = mockGPU(),
    graph = new FrameGraph(),
    plugins = new Map(),
    engine = {
      gpu: gpu.device,
      frameGraph: graph,
      hasPlugin: (name) => plugins.has(name),
      sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? engine : undefined),
      use(plugin) {
        plugins.set(plugin.name, plugin);
        graph.withOwner(plugin.name, () => {
          plugin.setup(engine);
          plugin.registerPasses?.(graph);
        });
        plugins.set(plugin.name, plugin);
        return engine;
      },
      removePlugin(name) {
        const plugin = plugins.get(name);
        if (plugin) {
          graph.removeOwner(name);
          plugins.delete(name);
          plugin.dispose?.();
        }
      },
    };
  const view = context(gpu, { samples, shader: wgsl, format: 'bgra8unorm' });
  let index = 0;
  return {
    gpu,
    engine,
    frame: () => {
      view.begin(index++);
      graph.execute(view.c);
    },
  };
}
const presets = {
  vignette: ['darkness', 'radius', 'softness'],
  rgbShift: ['amount', 'angle'],
  chromaticAberration: ['strength'],
  pixelate: ['size'],
  halftone: ['size', 'angle'],
  dotScreen: ['size', 'angle'],
  sobel: ['strength', 'overlay'],
  sepia: ['amount'],
  posterize: ['levels'],
};

test('every preset is a NodePass with named live uniforms and readable WGSL', () => {
  for (const [name, params] of Object.entries(presets)) {
    const effect = E[name]();
    assert.ok(effect instanceof NodePass, name);
    assert.equal(effect.kind, 'ldr', name + ' defaults to LDR');
    assert.match(effect.name, new RegExp(`^shader:${name}:\\d+$`));
    assert.deepEqual(Object.keys(effect.uniforms), params, name);
    const code = effect.code();
    for (const p of params) assert.ok(code.includes(`  ${p}:f32,`), `${name}: uniform ${p}`);
    assert.ok(code.includes('@fragment fn fragment'), name);
  }
  assert.equal(E.sepia({ kind: 'hdr', name: 'tone' }).kind, 'hdr');
  assert.equal(E.sepia({ name: 'tone' }).name, 'tone');
  // Sobel reads the eight neighbours exactly at texel centres; pixelate samples one texel per block.
  const sobel = E.sobel().code();
  assert.equal(sobel.match(/textureSampleLevel/g).length, 8);
  assert.ok(sobel.includes('0.2126') && sobel.includes('sqrt('));
  assert.ok(E.pixelate().code().includes('floor('));
  assert.ok(E.sepia().code().includes('mat3x3f(0.393, 0.349, 0.272, 0.769, 0.686, 0.534, 0.189, 0.168, 0.131)'));
  assert.equal(
    E.halftone()
      .code()
      .match(/textureSampleLevel/g).length,
    3,
    'three colour screens',
  );
  assert.equal(
    E.halftone({ greyscale: true })
      .code()
      .match(/textureSampleLevel/g).length,
    1,
    'one luma screen',
  );
});

test('presets run in a PostStack in HDR and LDR positions; parameter changes never recompile', () => {
  const h = stack(),
    sepia = E.sepia({ kind: 'hdr', amount: 0.5 }),
    pixels = E.pixelate({ size: 4 }),
    edges = E.sobel({ overlay: 1 });
  PostStack.attach(h.engine, [sepia, new Tonemap(), pixels, edges]);
  const first = h.gpu.record(() => h.frame()),
    modules = first.filter(([n]) => n === 'module').map(([, , d]) => d.code);
  assert.ok(modules.some((c) => c.includes('ndu.amount')));
  assert.ok(modules.some((c) => c.includes('ndu.size')));
  assert.ok(modules.some((c) => c.includes('ndu.overlay')));
  pixels.uniforms.size.value = 12;
  edges.uniforms.strength.value = 3;
  const next = h.gpu.record(() => h.frame());
  assert.ok(!next.some(([n]) => n === 'module' || n === 'renderPipeline'), 'no recompile');
  const words = next
    .filter(([n]) => n === 'writeBuffer')
    .map(([, , , hex]) => [...new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer)]);
  assert.ok(
    words.some((w) => w.includes(12)),
    'size uploaded',
  );
  assert.ok(
    words.some((w) => w.includes(3)),
    'strength uploaded',
  );
});

test('preset parameters must be finite numbers', () => {
  assert.throws(() => E.vignette({ darkness: Number.NaN }), {
    name: 'RangeError',
    message: /darkness must be a finite number/,
  });
  assert.throws(() => E.pixelate({ size: '8' }), RangeError);
  assert.throws(() => E.posterize({ kind: 'display' }), TypeError);
});
