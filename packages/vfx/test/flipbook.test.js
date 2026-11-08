import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { flipbook } from '../dist/flipbook.js';
import { textureFeature } from '../dist/texture.js';
import { lit } from '../dist/lit.js';
import { translateWGSL } from '../../webgl2-compat/dist/glsl.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const pixels = new Uint8Array(8 * 8 * 4);
const lifetime = { width: 8, height: 8, data: pixels, atlas: { columns: 2, rows: 2, frames: 'lifetime' } };
const random = { width: 8, height: 8, data: pixels, atlas: { columns: 2, rows: 2, frames: 'random' } };
const plain = { width: 8, height: 8, data: pixels };
const mix = 'mix(flipbookSample(i.cell,i.uv),flipbookSample(i.nextCell,i.uv),i.blend)';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};

const state = (error) => error.name === 'MargoError' && error.code === 'state';

test('flipbook blends a lifetime atlas and refuses a texture that is not one', () => {
  assert.throws(() => new VFX({ flipbook: {} }), state);
  assert.throws(() => new VFX({ flipbook: {}, texture: plain }), state);
  assert.throws(() => new VFX({ flipbook: {}, texture: random }), state);
  assert.throws(() => new VFX({ flipbook: null, texture: lifetime }), TypeError);
  assert.throws(
    () => new Base({ flipbook: {}, texture: lifetime }, { texture: textureFeature }),
    /needs flipbook from @margoengine\/vfx\/flipbook/,
  );
  const stepped = attach({ capacity: 4, texture: lifetime });
  stepped.h.frame();
  const steppedCode = stepped.h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
  assert.match(steppedCode, /let atlasFrame=min\(u32\(max\(1-p\.positionLife\.w\/p\.rotation\.z,0\.0\)\*4\.0\),3u\)/);
  assert.equal(steppedCode.includes('flipbookSample'), false);
  stepped.effect.dispose();

  const { h, effect } = attach({ capacity: 4, texture: lifetime, flipbook: {} });
  h.frame();
  const code = h.pipelines.map((p) => p.vertex?.module.code).find((c) => c?.includes(mix));
  assert.ok(code, 'the blended billboard');
  assert.match(code, /let atlasPos=max\(1\.0-p\.positionLife\.w\/p\.rotation\.z,0\.0\)\*4\.0/);
  assert.match(code, /let atlasNext=min\(atlasFrame\+1u,3u\)/);
  assert.match(code, /o\.blend=atlasPos-f32\(atlasFrame\)/);
  assert.match(code, /@location\(4\) @interpolate\(flat\) nextCell:vec2f/);
  assert.match(code, /@location\(5\) @interpolate\(flat\) blend:f32/);
  assert.equal(code.includes('let atlasFrame=min(u32(max(1-p.positionLife.w'), false);
  effect.dispose();

  const both = attach(
    { capacity: 4, texture: lifetime, flipbook: {}, lit: {} },
    { texture: textureFeature, flipbook, lit },
  );
  both.h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  both.h.frame();
  const litCode = both.h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
  assert.ok(litCode.includes(mix) && litCode.includes('fn unlit('), 'lit keeps the blend inside the unlit colour');
  both.effect.dispose();
});

test('the WebGL2 route still wraps the blended billboard, and the blend translates', async () => {
  const { h, effect } = attach({ capacity: 4, texture: lifetime, flipbook: {} });
  h.frame();
  const code = h.pipelines.map((p) => p.vertex?.module.code).find((c) => c?.includes(mix));
  const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist');
  const compat = readdirSync(dist).find((name) => /^compat-.*\.js$/.test(name));
  const { countedBillboard } = await import(pathToFileURL(join(dist, compat)).href);
  const wrapped = countedBillboard(code);
  assert.match(wrapped, /if\(instance>=drawn\[1\]\)/);
  assert.ok(wrapped.includes(mix));
  const glsl = translateWGSL({ vertex: { source: code }, fragment: { source: code } });
  const calls = (glsl.fragment.source.match(/flipbookSample\((?!vec2)/g) ?? []).length;
  const textures = (glsl.fragment.source.match(/\btexture\(/g) ?? []).length;
  assert.match(glsl.fragment.source, /mix\(/);
  assert.ok(calls >= 2 || textures >= 2, glsl.fragment.source);
  effect.dispose();
});
