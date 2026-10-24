import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { FrameGraph } from '../packages/core/dist/extension.js';
import { box } from '../packages/core/dist/geometry.js';

// docs/conventions.md, Errors: core and the stage throw MargoError with a stable code (or TypeError / RangeError),
// and every message names its fix.
const coded = (code, prefix) => (error) =>
  error.name === 'MargoError' && error.code === code && error.message.startsWith(prefix) && error.message.includes(';');

async function engine(backend = 'webgpu') {
  const renderer = { backend, add() {}, remove() {}, dispose() {}, render() {}, pick: async () => -1 };
  const canvas = { width: 8, height: 8, clientWidth: 8, clientHeight: 8 };
  return new Engine(canvas, await TransformStore.create(4), renderer, undefined, null);
}

test('pick and rebootDevice on the WebGL2 fallback reject with code unsupported', async () => {
  const e = await engine('webgl2');
  try {
    await assert.rejects(e.pick(1, 1), coded('unsupported', 'WebGPU required'));
    await assert.rejects(e.rebootDevice(), coded('unsupported', 'WebGPU required'));
  } finally {
    e.dispose();
  }
});

test('disposed engines, meshes and transforms throw code disposed', async () => {
  const e = await engine(),
    mesh = e.createMesh().setGeometry(box());
  mesh.dispose();
  assert.throws(() => mesh.setPosition([0, 0, 0]), coded('disposed', 'Mesh disposed'));
  e.dispose();
  assert.throws(() => e.createMesh(), coded('disposed', 'Engine disposed'));
  await assert.rejects(e.rebootDevice(), coded('disposed', 'Engine disposed'));
  await assert.rejects(e.pick(1, 1), coded('disposed', 'Engine disposed'));
  const store = await TransformStore.create(1);
  store.dispose();
  assert.throws(() => store.tick(), coded('disposed', 'Transforms disposed'));
});

test('re-entrant frame graph calls throw code state', () => {
  const graph = new FrameGraph(),
    errors = [];
  graph.add({
    name: 'outer',
    order: 0,
    execute(context) {
      for (const call of [() => graph.add({ name: 'late', order: 1, execute() {} }), () => graph.execute(context)])
        try {
          call();
        } catch (error) {
          errors.push(error);
        }
    },
  });
  graph.execute({ draw() {} });
  assert.ok(coded('state', 'Graph executing')(errors[0]), String(errors[0]));
  assert.ok(coded('state', 'Graph recursion')(errors[1]), String(errors[1]));
});

test('core and stage sources have no bare Error and every literal throw message names a fix', () => {
  // The fix words of scripts/hygiene.js (gate 7).
  const fix =
    /;|\b(must|needs?|expects?|expected|use|call|pass|set|give|create|run|requires?|only|at (most|least)|between|install|enable|add|load|remove|provide|choose|one of|instead|before|after|try|check|should|wait|await|reduce|increase|split|keep|make|within|up to|no more than)\b/i;
  for (const dir of ['packages/core/src', 'packages/margoengine/src'])
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      assert.doesNotMatch(text, /new Error\(/, `${dir}/${file}: bare Error`);
      for (const m of text.matchAll(/throw new (?:TypeError|RangeError)\(\s*(['"`])(.*?)\1/g))
        assert.match(m[2], fix, `${dir}/${file}: '${m[2]}' names no fix`);
    }
});
