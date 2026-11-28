import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode, createRef } from 'react';
import { createNullStage } from '@margoengine/headless/null';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createTestRenderer } = await import('../dist/test.js');
const { Group, Mesh, BoxGeometry, PbrMaterial, Scene, useFrame, useMargo } = await import('../dist/index.js');
const h = React.createElement;

test('ordinary React DOM mounts real GPU-free scenes, updates, frame hooks, event bubbling/capture and cleanup', async () => {
  const parent = createRef(),
    child = createRef(),
    clicks = [],
    frames = [];
  let value;
  function Logic() {
    value = useMargo();
    useFrame((_, delta) => frames.push(delta));
    return h('span', null, 'page DOM');
  }
  const tree = (x) =>
    h(
      StrictMode,
      null,
      h(Logic),
      h(
        Group,
        { ref: parent, onClick: (e) => clicks.push(e.currentTarget.id) },
        h(
          Mesh,
          {
            ref: child,
            position: [x, 0, 0],
            onClick: (e) => clicks.push(e.currentTarget.id),
            onPointerDown: (e) => e.setPointerCapture(),
          },
          h(BoxGeometry),
          h(PbrMaterial, { color: '#ff4433' }),
        ),
      ),
      h(Scene, { name: 'other' }, h(Mesh)),
    );
  const renderer = await createTestRenderer(tree(1), { width: 128, height: 64 });
  const engine = renderer.stage.engine;
  try {
    assert.equal(renderer.stage.isNull, true);
    assert.equal(renderer.stage.engine.gpu, null);
    assert.equal(renderer.findAll().length, 3);
    assert.equal(renderer.findAll((m) => m === child.current).length, 1);
    assert.equal(renderer.container.textContent, 'page DOM');
    assert.equal(value.ready, true);
    assert.deepEqual(value.size, { width: 128, height: 64 });
    await renderer.advanceFrames(3, 0.1);
    assert.deepEqual(frames, [0.1, 0.1, 0.1]);
    assert.ok(Math.abs(value.clock - 0.3) < 1e-10);
    await renderer.update(tree(2));
    assert.deepEqual([child.current.position.x, child.current.position.y, child.current.position.z], [2, 0, 0]);
    await renderer.fireEvent(child.current, 'pointerdown');
    assert.equal(value.canvas.hasPointerCapture(1), true);
    await renderer.fireEvent(null, 'pointerup');
    assert.equal(value.canvas.hasPointerCapture(1), false, 'synthetic capture follows implicit release');
    assert.deepEqual(clicks, [child.current.id, parent.current.id]);
    await assert.rejects(renderer.advanceFrames(-1), /integer/);
    const foreign = await createNullStage();
    try {
      await assert.rejects(renderer.fireEvent(foreign.engine.createMesh(), 'pointerdown'), /live mesh/);
    } finally {
      foreign.dispose();
    }
  } finally {
    await renderer.unmount();
  }
  assert.equal(engine.disposed, true);
  assert.equal(parent.current, null);
  assert.equal(child.current, null);
  assert.equal(document.body.children.length, 0);
  await renderer.unmount();
  await assert.rejects(renderer.update(null), /disposed/);
});

test('pointer handler failures reject the awaited helper instead of passing silently', async () => {
  const ref = createRef();
  const renderer = await createTestRenderer(
    h(Mesh, {
      ref,
      onPointerDown: () => {
        throw new Error('handler failed');
      },
    }),
  );
  try {
    await assert.rejects(
      renderer.fireEvent(ref.current, 'pointerdown'),
      (error) => error.code === 'failed' && error.cause[0].message === 'handler failed',
    );
  } finally {
    await renderer.unmount();
  }
});

test('borrowed stage and supplied container survive cleanup; failed mount frees its resources', async () => {
  const stage = await createNullStage(),
    container = document.body.appendChild(document.createElement('div'));
  const renderer = await createTestRenderer(h(Mesh), { stage, container });
  await renderer.unmount();
  assert.equal(stage.engine.disposed, false);
  assert.equal(stage.engine.scene.meshes.size, 0);
  assert.equal(container.isConnected, true);
  assert.equal(container.children.length, 0);
  stage.dispose();
  container.remove();
  const saved = globalThis.document;
  delete globalThis.document;
  try {
    await assert.rejects(createTestRenderer(null), /DOM/);
  } finally {
    globalThis.document = saved;
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(createTestRenderer(null, { signal: abort.signal }), { name: 'AbortError' });
  function Bad() {
    throw new Error('mount failed');
  }
  await assert.rejects(createTestRenderer(h(Bad)), /mount failed/);
  assert.equal(document.body.children.length, 0);
});

// Html on the GPU-free stage, whose canvas is in no document, threw a bare TypeError from its effect and left the
// overlay load it had started rejected and unhandled, which ended the Node process.
test('Html on a canvas outside a DOM document refuses with a coded error and leaves no unhandled rejection', async () => {
  const { Html } = await import('../dist/html.js');
  const unhandled = [],
    onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(createTestRenderer(h(Html, null, 'label')), (error) => {
      const errors = error.errors ?? [error];
      assert.ok(
        errors.some((e) => e.code === 'unsupported' && /Html needs a canvas in a DOM document/.test(e.message)),
      );
      return true;
    });
    // fixed-wait: a check that nothing happens: no unhandled rejection arrives in this time
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(document.body.children.length, 0);
});
