// <Segments> on a real core engine and the real lines package's Line (its GPU plugin, which needs WebGPU, is replaced by a
// recorder): one native line in segment mode for every <Segment>.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const real = await import('@margoengine/lines');
class Lines {
  constructor({ name }) {
    this.name = name;
    this.lines = new Set();
  }
  setup() {}
  add(line) {
    this.lines.add(line);
  }
  dispose() {}
}
mock.module('@margoengine/lines', { namedExports: { ...real, Lines } });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { Segments, Segment } = await import('../dist/lines.js');
const h = React.createElement,
  scenes = [];
async function scene() {
  const canvas = document.createElement('canvas'),
    engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }),
    });
  const value = {
    engine,
    world: null,
    registry: null,
    shadows: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
  };
  scenes.push(value);
  const frame = () => {
    for (const f of value.frames.callbacks) f(engine, 0);
  };
  return { value, engine, frame };
}
const tree = (s, children) => h(StrictMode, null, h(Context.Provider, { value: s.value }, children));
afterEach(() => {
  cleanup();
  for (const s of scenes) s.engine.dispose();
  scenes.length = 0;
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};
test('Segments draws every Segment as one line in segment mode, with linear colours', async () => {
  const s = await scene(),
    line = createRef(),
    a = createRef();
  render(
    tree(
      s,
      h(Segments, { ref: line, lineWidth: 3 }, [
        h(Segment, { key: 1, ref: a, start: [0, 0, 0], end: [1, 0, 0], color: '#ff0000' }),
        h(Segment, { key: 2, start: [0, 1, 0], end: [0, 2, 0], color: [0, 0, 1] }),
      ]),
    ),
  );
  await settle();
  s.frame();
  assert.equal(line.current.mode, 'segments');
  assert.equal(line.current.material.width, 3);
  assert.equal(line.current.count, 4);
  assert.equal(line.current.segmentCount, 2);
  assert.deepEqual([...line.current.points.slice(0, 8)], [0, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual([...line.current.colors.slice(0, 4)], [1, 0, 0, 1]);
  assert.deepEqual([...line.current.colors.slice(8, 12)], [0, 0, 1, 1]);
  assert.deepEqual(a.current.color, [1, 0, 0]);
});
test('a Segment ref written in place redraws, an unchanged frame uploads nothing, and limit caps the batch', async () => {
  const s = await scene(),
    line = createRef(),
    a = createRef();
  const view = render(
    tree(
      s,
      h(Segments, { ref: line, limit: 1 }, [
        h(Segment, { key: 1, ref: a, start: [0, 0, 0], end: [1, 0, 0] }),
        h(Segment, { key: 2, start: [5, 5, 5], end: [6, 6, 6] }),
      ]),
    ),
  );
  await settle();
  s.frame();
  assert.equal(line.current.segmentCount, 1);
  const version = line.current.version;
  s.frame();
  assert.equal(line.current.version, version, 'no upload without a change');
  a.current.end[1] = 2;
  s.frame();
  assert.equal(line.current.points[5], 2);
  view.rerender(
    tree(s, h(Segments, { ref: line, limit: 1 }, [h(Segment, { key: 2, start: [5, 5, 5], end: [6, 6, 6] })])),
  );
  await settle();
  s.frame();
  assert.equal(line.current.points[0], 5, 'the next segment takes the freed place');
});
test('Segment outside Segments, and a bad limit, name their fix', async () => {
  const s = await scene();
  assert.throws(() => render(tree(s, h(Segment, { start: [0, 0, 0], end: [1, 1, 1] }))), /Segment requires <Segments>/);
  assert.throws(() => render(tree(s, h(Segments, { limit: 0 }))), /Segments limit must be a positive integer/);
});
