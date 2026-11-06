import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMaterial, uv, vec3, vec4 } from '../dist/index.js';
import { PassMaterial, ScenePass } from '../dist/pass.js';

const { capturePBR, pbrShader } = await import('../../gltf-pro/src/shader.ts');

const hook = (pass) => {
  let held;
  pass.add({ setCapture: (h) => ((held = h), () => undefined), onDispose: () => () => undefined });
  return held;
};

test('a PassMaterial declares its outputs and writes them at the end of the surface', () => {
  const code = new PassMaterial({ outputs: { glow: vec4(uv(), 0, 1) } }).shader(pbrShader, 2);
  assert.ok(code.startsWith('var<private> margoOutglow:vec4f;'));
  assert.ok(code.indexOf('margoOutglow=') < code.indexOf('\n  return s;'));
  assert.ok(code.indexOf('margoOutglow=') > code.indexOf('fn surface('));
});

test('a PassMaterial without outputs is the NodeMaterial it extends', () => {
  const options = { colorNode: vec3(1, 0, 0) };
  assert.equal(new PassMaterial(options).shader(pbrShader, 2), new NodeMaterial(options).shader(pbrShader, 2));
});

test('output names are checked, and color is the lit colour', () => {
  assert.throws(() => new PassMaterial({ outputs: { 'a-b': vec4(1) } }), /letters and digits/);
  assert.throws(() => new PassMaterial({ outputs: { color: vec4(1) } }), /lit colour/);
  assert.throws(() => new PassMaterial({ outputs: { glow: vec3(1) } }), /output glow must be vec4f/);
  assert.throws(() => new ScenePass({ outputs: {} }), /at least one output/);
  assert.throws(() => new ScenePass({ outputs: { 'a b': 'rgba8unorm' } }), /letters and digits/);
  assert.throws(() => new ScenePass({ outputs: { a: 'rgba8unorm' }, order: 0 }), /order/);
  for (const format of ['rgba32float', 'r32uint', 'rg16sint', 'depth24plus'])
    assert.throws(() => new ScenePass({ outputs: { a: format } }), /filterable colour format/);
});

test('the capture shader returns one value per target and declares what a material left out', () => {
  const pass = new ScenePass({ outputs: { glow: 'rgba16float', mask: 'rgba8unorm' } }),
    { targets, declarations } = hook(pass),
    written = new PassMaterial({ outputs: { glow: vec4(1) } }).shader(pbrShader, 2);
  assert.deepEqual(
    targets.map((t) => t.format),
    ['rgba16float', 'rgba8unorm'],
  );
  const tail = declarations(written);
  assert.equal(tail.includes('var<private> margoOutglow'), false, 'the material holds this one');
  assert.ok(tail.includes('var<private> margoOutmask:vec4f;'));
  assert.ok(tail.includes('MargoCapture(margoOutglow,margoOutmask)'));
  assert.ok(tail.includes('@location(1) o1:vec4f'), 'an output name never reaches WGSL bare: `loop` is a reserved word');
  assert.ok(declarations(pbrShader).includes('var<private> margoOutglow:vec4f;'), 'a plain material writes nothing');
});

test('the lit colour runs the beauty shading in the capture entry; without it that stays dead', () => {
  const lit = hook(new ScenePass({ outputs: { color: 'rgba16float' } })).declarations(pbrShader),
    plain = hook(new ScenePass({ outputs: { glow: 'rgba16float' } })).declarations(pbrShader);
  assert.ok(capturePBR(pbrShader, lit).includes('margoBeauty=margoShade(i,front);'));
  assert.ok(capturePBR(pbrShader, plain).includes('if(false){_=margoShade(i,front);}'));
});

test('texture() hands out one binding per output, and refuses a name the pass does not have', () => {
  const pass = new ScenePass({ outputs: { glow: 'rgba16float' } });
  assert.equal(pass.texture('glow'), pass.texture('glow'));
  assert.equal(pass.texture('glow').bind(), undefined, 'white until the first frame');
  assert.throws(() => pass.texture('mask'), /no output "mask"; it has glow/);
});

test('velocity is a screen vector from this frame and the last, and takes where a mesh was', () => {
  const pass = new ScenePass({ outputs: { motion: 'rgba16float' } });
  assert.equal(pass.velocity().type, 'vec2f');
  assert.ok(new PassMaterial({ outputs: { motion: vec4(pass.velocity(vec3(0, 1, 0)), 0, 1) } }).shader(pbrShader, 2));
});

test('a disposed pass takes no models and draws nothing, and `using` disposes it', () => {
  const pass = new ScenePass({ outputs: { glow: 'rgba16float' } });
  let frame;
  pass.registerPasses({ add: (p) => (frame = p) });
  pass[Symbol.dispose]();
  assert.throws(() => hook(pass), /disposed/);
  frame.execute({ backend: 'webgpu' });
  assert.equal(pass.texture('glow').bind(), undefined, 'no targets came back');
});
