// The Draco/KTX2 decoder worker runs without eval or new Function, so the
// strict CSP in docs/deploying.md (no 'unsafe-eval') covers it. A Node vm context with code generation from strings
// disabled throws EvalError exactly where such a CSP refuses: each Emscripten glue file runs there, worker-style (classic
// script in global scope, as importScripts runs it), and must match the unpatched vendor glue byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodeDraco, transcodeKTX2 } from '../packages/decoders/dist/codec.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url));
const text = (path) => read(path).toString('utf8');

/** Run a classic glue script in a fresh worker-like global (`importScripts` present) and return that global. */
function runGlue(source, allowStrings) {
  const scope = { console, setTimeout, clearTimeout, location: { href: 'http://localhost/' }, importScripts() {} };
  scope.self = scope;
  const context = vm.createContext(scope, { codeGeneration: { strings: allowStrings, wasm: true } });
  vm.runInContext(source, context);
  return context;
}
/** Emscripten modules are thenable: unwrap through a box so the promise does not adopt the module itself. */
const instantiate = (factory, options) =>
  new Promise((resolve, reject) => factory(options).then((module) => resolve({ module }), reject)).then(
    (box) => box.module,
  );

test('the decoder worker script contains no eval', () => {
  const path = 'packages/decoders/dist/decoder.worker.js',
    code = text(path);
  assert.doesNotMatch(code, /\beval\s*\(|new Function|\bFunction\s*\(/, path);
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, `${path} is a classic script`);
});

test('Draco: the unmodified wrapper decodes Box and Avocado with code generation disabled, identical to eval allowed', async () => {
  const wrapper = text('packages/decoders/dist/draco/draco_wasm_wrapper.js'),
    wasmBinary = read('packages/decoders/dist/draco/draco_decoder.wasm');
  const [strict, loose] = await Promise.all(
    [false, true].map((allow) => instantiate(runGlue(wrapper, allow).DracoDecoderModule, { wasmBinary })),
  );
  for (const name of ['Box', 'Avocado']) {
    const doc = JSON.parse(text(`packages/decoders/tests/fixtures/${name}.gltf`)),
      bin = read(`packages/decoders/tests/fixtures/${name}.bin`);
    const ext = doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression,
      view = doc.bufferViews[ext.bufferView];
    const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
      request = { attributeIds: ext.attributes, componentTypes: { TANGENT: 5126 } };
    const a = decodeDraco(strict, bytes, request),
      b = decodeDraco(loose, bytes, request);
    assert.ok(a.vertexCount > 0);
    assert.deepEqual(a, b, name);
  }
});

test('Basis: the vendor glue needs eval; the shipped glue transcodes every target byte-identically without it', async () => {
  const vendor = text('packages/decoders/vendor/basis/basis_transcoder.js'),
    shipped = text('packages/decoders/dist/basis/basis_transcoder.js');
  const wasmBinary = read('packages/decoders/dist/basis/basis_transcoder.wasm');
  assert.deepEqual(
    read('packages/decoders/vendor/basis/basis_transcoder.wasm'),
    wasmBinary,
    'Wasm is shipped unmodified',
  );
  await assert.rejects(
    instantiate(runGlue(vendor, false).BASIS, { wasmBinary }),
    (error) => error.name === 'EvalError',
    'vendor embind glue generates code',
  );
  const [reference, patched] = await Promise.all(
    [
      [vendor, true],
      [shipped, false],
    ].map(([source, allow]) => instantiate(runGlue(source, allow).BASIS, { wasmBinary })),
  );
  reference.initializeBasis();
  patched.initializeBasis();
  const ktx2 = new Uint8Array(read('packages/decoders/tests/fixtures/AnisotropyBarnLamp_normalbump.ktx2')); // as the worker gets it (a Buffer would make embind call new Buffer)
  for (const target of ['rgba8', 'bc7', 'astc-4x4', 'etc2']) {
    const a = transcodeKTX2(patched, ktx2, target),
      b = transcodeKTX2(reference, ktx2, target);
    assert.equal(a.target, target);
    assert.ok(a.mipmaps[0].data.some((v) => v !== 0));
    assert.deepEqual(a, b, target);
  }
  // Errors raised through embind (a bad file) still surface the same way.
  assert.throws(() => transcodeKTX2(patched, new Uint8Array(64), 'rgba8'), /KTX2: invalid/);
});
