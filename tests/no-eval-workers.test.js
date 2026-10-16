// The Draco/KTX2 decoder worker and the STEP/IGES CAD worker run without eval or new Function (HANDOFF 5l.o), so the
// strict CSP in docs/deploying.md (no 'unsafe-eval') covers them. A Node vm context with code generation from strings
// disabled throws EvalError exactly where such a CSP refuses: each Emscripten glue file runs there, worker-style (classic
// script in global scope, as importScripts runs it), and must match the unpatched vendor glue byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodeDraco, transcodeKTX2 } from '../packages/decoders/dist/codec.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url));
const text = (path) => read(path).toString('utf8');
const occtSamples = 'node_modules/occt-import-js/test/testfiles/';

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

test('the decoder and CAD worker scripts contain no eval', () => {
  for (const path of ['packages/decoders/dist/decoder.worker.js', 'packages/machinery/dist/workers/cad-runtime.js']) {
    const code = text(path);
    assert.doesNotMatch(code, /\beval\s*\(|new Function|\bFunction\s*\(/, path);
    assert.doesNotMatch(code, /^\s*(import|export)\s/m, `${path} is a classic script`);
  }
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

test('occt-import-js: the vendor glue needs eval; the shipped glue reads STEP and IGES identically without it', async () => {
  const vendor = text('node_modules/occt-import-js/dist/occt-import-js.js'),
    shipped = text('packages/machinery/dist/workers/occt-import-js.js');
  const wasmBinary = read('packages/machinery/dist/workers/occt-import-js.wasm'),
    quiet = () => ({ wasmBinary, print() {}, printErr() {} }); // Emscripten adopts the options object as its Module: one per instance
  await assert.rejects(
    instantiate(runGlue(vendor, false).occtimportjs, quiet()),
    (error) => error.name === 'EvalError',
    'vendor embind glue generates code',
  );
  const patched = await instantiate(runGlue(shipped, false).occtimportjs, quiet()),
    options = { linearUnit: 'meter' };
  const step = read(occtSamples + 'cax-if/as1-oc-214.stp'),
    iges = read(occtSamples + 'cube-10x10mm/Cube 10x10.igs');
  const results = [
    JSON.stringify(patched.ReadStepFile(new Uint8Array(step), options)),
    JSON.stringify(patched.ReadIgesFile(new Uint8Array(iges), options)),
  ];
  const reference = await instantiate(runGlue(vendor, true).occtimportjs, quiet());
  assert.ok(JSON.parse(results[0]).success && JSON.parse(results[0]).meshes.length > 1, 'STEP assembly read');
  assert.equal(results[0], JSON.stringify(reference.ReadStepFile(new Uint8Array(step), options)), 'STEP result');
  assert.equal(results[1], JSON.stringify(reference.ReadIgesFile(new Uint8Array(iges), options)), 'IGES result');
});
