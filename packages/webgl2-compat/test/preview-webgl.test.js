import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../core/dist/engine.js';
import { box } from '../../core/dist/geometry.js';
import { webglRenderer, GLRenderer } from '../dist/preview.js';

test('core uses the WebGL fallback only when an app passes it', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    calls = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Windows NT' } });
  try {
    const canvas = { width: 4, height: 4, clientWidth: 4, clientHeight: 4, getContext: () => null };
    await assert.rejects(Engine.create(canvas, { backend: 'auto' }), /WebGPU unavailable|adapter unavailable/);
    await assert.rejects(Engine.create(canvas, { backend: 'webgl2' }), /webgl2 needs fallback: webglRenderer/);
    const fallback = (target) => {
      calls.push(target);
      return { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
    };
    const engine = await Engine.create(canvas, { backend: 'auto', fallback });
    assert.equal(engine.backend, 'webgl2');
    assert.deepEqual(calls, [canvas]);
    engine.dispose();
    const seen = [];
    const glCanvas = {
      getContext: (_kind, attributes) => {
        seen.push(attributes);
        return null;
      },
    };
    for (const options of [undefined, { transparent: true }])
      assert.throws(() => webglRenderer(glCanvas, options), /No WebGL2/);
    assert.deepEqual(
      seen.map((a) => [a.alpha, a.premultipliedAlpha]),
      [
        [false, true],
        [true, true],
      ],
      'transparent asks for a premultiplied alpha canvas',
    );
    assert.throws(() => webglRenderer({ getContext: () => null }), /No WebGL2/);
    assert.throws(() => new GLRenderer({ getContext: () => null }), /No WebGL2/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});

test('add on a held geometry makes the new buffers first, so a failure keeps the old ones', () => {
  const live = new Set(),
    vertexArrays = new Set();
  let failBuffer = 0;
  const gl = new Proxy(
    {
      NO_ERROR: 0,
      getError: () => 0,
      isContextLost: () => false,
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      createBuffer() {
        if (failBuffer && --failBuffer === 0) return null;
        const buffer = {};
        live.add(buffer);
        return buffer;
      },
      deleteBuffer: (buffer) => live.delete(buffer),
      createVertexArray() {
        const array = {};
        vertexArrays.add(array);
        return array;
      },
      deleteVertexArray: (array) => vertexArrays.delete(array),
    },
    { get: (target, key) => (key in target ? target[key] : () => ({})) },
  );
  const renderer = new GLRenderer({ getContext: () => gl }),
    geometry = box();
  renderer.add(geometry, 2);
  const held = [...live],
    array = [...vertexArrays];
  failBuffer = 3; // the instance buffer, after the vertex and index buffers
  assert.throws(() => renderer.add(geometry, 6), /GL buffer/);
  assert.deepEqual([...live], held, 'the old buffers stay and the partial new ones go');
  assert.deepEqual([...vertexArrays], array);
  renderer.add(geometry, 6);
  assert.equal(live.size, 3, 'the replaced buffers are freed');
  assert.equal(vertexArrays.size, 1);
  for (const buffer of held) assert.ok(!live.has(buffer));
  renderer.remove(geometry);
  assert.equal(live.size, 0);
});
