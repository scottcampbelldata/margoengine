import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { LabelRenderer } from '../dist/index.js';

test('test-page 32: Label position remains getter-only and rejects assignment with the core diagnostic', async () => {
  const dom = new JSDOM('<body><canvas width="200" height="200"></canvas></body>');
  const engine = new Engine(dom.window.document.querySelector('canvas'), await TransformStore.create(4),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });
  try {
    const renderer = LabelRenderer.attach(engine);
    const mesh = engine.createMesh();
    const label = renderer.add(dom.window.document.createElement('span'), { mesh, position: [1, 2, 3] });
    const held = label.position;
    let coreError;
    try { mesh.position = [0, -2.5, 0]; } catch (error) { coreError = error; }
    assert.ok(coreError instanceof TypeError);
    for (const value of [[4, 5, 6], { x: 4, y: 5, z: 6 }, held, null]) {
      assert.throws(() => { label.position = value; }, error => error instanceof TypeError &&
        error.code === coreError.code && error.message === coreError.message);
      assert.equal(label.position, held);
      assert.equal(label.mesh, mesh);
      assert.deepEqual(label.position, [1, 2, 3]);
    }
    assert.throws(() => Reflect.set(label, 'position', [4, 5, 6]), TypeError);
    assert.equal(label.setPosition([4, 5, 6]), label);
    assert.deepEqual(label.position, [4, 5, 6]);
    assert.equal(label.mesh, null);
    const types = readFileSync(new URL('../dist/renderer.d.ts', import.meta.url), 'utf8');
    assert.match(types, /get position\(\): Vec3/);
    assert.doesNotMatch(types, /set position\(/);
  } finally { engine.dispose(); dom.window.close(); }
});

test('labels share the declared math dependency instead of embedding its projection implementation', () => {
  const code = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.match(code, /from\s*["']@margoengine\/math\/mat4["']/);
});
