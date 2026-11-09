import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectPreviewContract, checkPreviewContract } from '../scripts/check-preview-contract.mjs';
import { PARALLEL } from '../scripts/verify.mjs';

const owner = (setup, pass = "if (c.backend === 'webgpu') this.draw(c)") => `
import {requireWebGPU as requireGPU} from '../../shared/require-webgpu.js';
class Example {
  setup(engine) { ${setup} }
  registerPasses(graph) { graph.add({execute: c => { ${pass} }}); }
}`;
const fails = (source) => inspectPreviewContract(source, 'packages/example/src/index.ts', {}).failures.length;

test('a guarded draw, inverted early return and guard in a called method all require attach refusal', () => {
  assert.equal(fails(owner('')), 1);
  assert.equal(fails(owner('', "if (c.backend !== 'webgpu') return; this.draw(c)")), 1);
  assert.equal(
    fails(owner('', 'this.draw(c)').replace(/}\s*$/, "draw(c) { if(c.backend !== 'webgpu') return; } }")),
    1,
  );
  assert.equal(fails(owner('/* requireGPU(engine); throw unsupported */')), 1);
});

test('only a reachable refusal for the preview backend satisfies the contract', () => {
  assert.equal(fails(owner("requireGPU(engine, 'Example');")), 0);
  assert.equal(fails(owner("if (!engine.gpu) throw new MargoError('unsupported', 'Requires WebGPU')")), 1);
  assert.equal(
    fails(
      owner(
        "if (!engine.gpu) throw new MargoError('unsupported', 'Requires WebGPU; see https://margoengine.com/errors#webgpu')",
      ),
    ),
    0,
  );
  assert.equal(fails(owner("const device = engine.gpu; if(!device) throw fault('unsupported','Requires WebGPU')")), 0);
  assert.equal(fails(owner("if(engine.backend !== 'webgpu') throw fault('unsupported','Requires WebGPU')")), 0);
  assert.equal(fails(owner("if(engine.backend === 'webgpu') throw fault('unsupported','Wrong way')")), 1);
  assert.equal(fails(owner("if(engine.backend !== 'webgpu') return; requireGPU(engine,'Too late')")), 1);
  assert.equal(fails(owner("if(false) requireGPU(engine,'Unreachable')")), 1);
  assert.equal(fails(owner("if(!engine.gpu) throw fault('state','Wrong code')")), 1);
  assert.equal(fails(owner("if(!engine.gpu) throw new Error('unsupported')")), 1);
  assert.equal(
    fails(
      owner('').replace(
        'registerPasses(graph)',
        "static attach(engine) {requireGPU(engine,'Only static')} registerPasses(graph)",
      ),
    ),
    1,
  );
});

test('standalone registration functions cannot silently gate their work either', () => {
  const source = "function attach(engine,graph) {graph.add({execute(c){if(c.backend === 'webgpu') draw(c)}})}";
  assert.equal(fails(source), 1);
  const guarded =
    "import {requireWebGPU} from '../../shared/require-webgpu.js';" +
    source.replace('{graph.add', "{requireWebGPU(engine,'Example');graph.add");
  assert.equal(fails(guarded), 0);
});

test('removing each repaired setup refusal brings back a source contract failure', () => {
  for (const path of [
    'animation/src/morph-gpu.ts',
    'animation/src/vat.ts',
    'lines/src/lines.ts',
    'lines/src/batch.ts',
    'lod/src/fade.ts',
    'materials/src/opaque-color.ts',
    'materials/src/built-material.ts',
    'points/src/plugin.ts',
    'points/src/surfels.ts',
    'terrain/src/colors.ts',
    'text/src/renderer.ts',
    'ui/src/world.ts',
  ]) {
    const file = `packages/${path}`;
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const mutated = source.replace(/requireWebGPU\(engine, '[^']+'\);/g, '');
    assert.notEqual(mutated, source, file);
    assert.ok(fails(mutated) > 0, file);
  }
});

test('an object plugin has the same contract as a class', () => {
  const object = owner('')
    .replace('class Example {', 'const plugin = {')
    .replace('setup(engine) {  }', 'setup(engine) {  },');
  assert.equal(fails(object), 1);
});

test('all package pass owners meet the preview contract, enforced by verify and therefore check:merge', {
  timeout: 120_000,
}, () => {
  const { failures, owners } = checkPreviewContract();
  assert.deepEqual(failures, []);
  assert.ok(owners.length > 100);
  assert.ok(PARALLEL.flat().includes('npm run check:preview-contract'));
});
