import test from 'node:test';
import assert from 'node:assert/strict';
import { Button, Label, List, Panel, UiRenderer } from '../dist/index.js';
import { makeUi } from './helpers.js';

// A WebGL2 context that records every call: constants read as numbers, objects as fresh tokens.
function fakeGl() {
  const calls = [];
  let lost = false;
  const values = {
    getParameter: () => 4096,
    getProgramParameter: () => true,
    isEnabled: () => false,
    isContextLost: () => lost,
    getError: () => 0,
    getUniformLocation: (_, name) => ({ uniform: name }),
  };
  const gl = new Proxy(
    {},
    {
      get(_, name) {
        if (name === 'lose') return () => (lost = true);
        if (name === 'calls') return calls;
        if (typeof name !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(name)) return name.length;
        return (...args) => {
          calls.push([name, ...args]);
          return name in values ? values[name](...args) : { made: name };
        };
      },
    },
  );
  return gl;
}

function setup() {
  const ui = makeUi(),
    renderer = new UiRenderer(ui, { input: false, mirror: false });
  // Node has no canvas to rasterize glyphs: every glyph is an 8 by 10 bitmap.
  const bitmaps = new Map();
  ui.font.glyph = (cluster) => {
    if (!bitmaps.has(cluster)) bitmaps.set(cluster, { cluster, width: 8, height: 10, left: 0, top: 8, color: false, data: new Uint8Array(80) });
    return bitmaps.get(cluster);
  };
  let execute;
  renderer.registerPasses({ add: (pass) => (execute = pass.execute) });
  const warn = console.warn,
    warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    renderer.setup({ sceneOf: () => undefined, backend: 'webgl2', canvas: { clientWidth: 640 } });
  } finally {
    console.warn = warn;
  }
  return { ui, renderer, warnings, run: (gl, extra = {}) => execute({ backend: 'webgl2', gl, width: 640, height: 360, ...extra }) };
}

// The drawing code loads on first use: run frames until it has drawn, yielding to the event loop between them.
async function drawn(run, renderer, gl) {
  for (let i = 0; i < 1000 && renderer.stats.drawCalls === 0; i++) {
    run(gl);
    if (renderer.stats.drawCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

test('on the WebGL2 backend UiRenderer draws the draw list: instanced rectangles and glyphs, no warning', async () => {
  const { ui, renderer, warnings, run } = setup(),
    gl = fakeGl();
  ui.add(
    new Panel({
      anchor: 'top-left',
      background: 'surface',
      children: [new Label({ text: 'Menu' }), new Button({ text: 'Play' })],
    }),
  );
  await drawn(run, renderer, gl);
  assert.deepEqual(warnings, [], 'no "not supported" warning');
  const draws = gl.calls.filter((c) => c[0] === 'drawArraysInstanced');
  assert.ok(draws.length >= 2, `rectangle and glyph runs drawn (${draws.length})`);
  for (const [, mode, first, vertices] of draws) {
    assert.equal(mode, 'TRIANGLES'.length);
    assert.equal(first, 0);
    assert.equal(vertices, 6, 'two triangles per instance');
  }
  const instances = draws.reduce((n, c) => n + c[4], 0);
  assert.equal(instances, renderer.stats.rects + renderer.stats.glyphs, 'every instance is drawn once');
  assert.ok(renderer.stats.rects >= 2 && renderer.stats.glyphs >= 4, JSON.stringify(renderer.stats));
  assert.equal(renderer.stats.uploads, 1);
  // Two GLSL programs, each with a vertex and a fragment shader.
  assert.equal(gl.calls.filter((c) => c[0] === 'linkProgram').length, 2);
  // The default framebuffer, premultiplied alpha blending, and the state put back after.
  assert.ok(gl.calls.some((c) => c[0] === 'bindFramebuffer' && c[2] === null));
  const blend = gl.calls.find((c) => c[0] === 'blendFuncSeparate');
  assert.deepEqual(blend.slice(1), ['ONE', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'].map((k) => k.length));
  assert.ok(gl.calls.at(-1)[0] === 'disable' || gl.calls.at(-1)[0] === 'enable');

  // An unchanged frame draws again (the default framebuffer is cleared every frame) but uploads nothing.
  const before = gl.calls.length;
  run(gl);
  const again = gl.calls.slice(before);
  assert.equal(renderer.stats.uploads, 0);
  assert.equal(again.filter((c) => c[0] === 'drawArraysInstanced').length, draws.length);
  assert.equal(again.filter((c) => c[0] === 'bufferSubData' || c[0] === 'texSubImage3D').length, 0);
  renderer.dispose();
});

test('WebGL2 runs move the attribute offsets to their first instance (no base instance) and scissor clipped rows', async () => {
  const { ui, renderer, run } = setup(),
    gl = fakeGl();
  const list = new List({ items: Array.from({ length: 50 }, (_, i) => `Row ${i}`), height: 80, anchor: 'top-left' });
  ui.add(list);
  await drawn(run, renderer, gl);
  const pointers = gl.calls.filter((c) => c[0] === 'vertexAttribPointer'),
    offsets = new Set(pointers.map((c) => c[6] - c[1] * 16));
  assert.ok(offsets.size > 1, 'runs after the first start past offset 0');
  for (const c of pointers) assert.equal(c[6] % (16 * 4), c[1] * 16, 'each run starts on an instance boundary');
  // The list clips its rows: one scissor is the list's box, in GL's bottom-up rows.
  const s = ui.scale * 1,
    r = list.rect,
    box = [Math.round(r.x * s), Math.round(360 - (r.y + r.height) * s), Math.round(r.width * s), Math.round(r.height * s)];
  const scissors = gl.calls.filter((c) => c[0] === 'scissor').map((c) => c.slice(1).map(Math.round));
  assert.ok(
    scissors.some((c) => c.every((v, i) => Math.abs(v - box[i]) <= 1)),
    `a scissor at the list's box ${box} among ${JSON.stringify(scissors)}`,
  );
  renderer.dispose();
});

test('a lost WebGL2 context draws nothing; after a restore the painter is made again on the new context', async () => {
  const { ui, renderer, run } = setup(),
    gl = fakeGl();
  ui.add(new Label({ text: 'Hello', anchor: 'top-left' }));
  await drawn(run, renderer, gl);
  gl.lose();
  const before = gl.calls.length;
  run(gl);
  assert.equal(gl.calls.slice(before).filter((c) => c[0] === 'drawArraysInstanced').length, 0, 'nothing drawn on a lost context');
  const fresh = fakeGl();
  renderer.onDeviceRestored({ sceneOf: () => undefined, backend: 'webgl2', canvas: { clientWidth: 640 } });
  run(fresh);
  assert.equal(fresh.calls.filter((c) => c[0] === 'linkProgram').length, 2, 'programs built on the new context');
  assert.ok(fresh.calls.some((c) => c[0] === 'drawArraysInstanced'));
  renderer.dispose();
});

test('the view loop: only the last view of a multi-view frame draws the UI on WebGL2', async () => {
  const { ui, renderer, run } = setup(),
    gl = fakeGl();
  ui.add(new Label({ text: 'Hi', anchor: 'top-left' }));
  await drawn(run, renderer, gl);
  const before = gl.calls.length;
  run(gl, { view: { index: 0, count: 2 } });
  assert.equal(gl.calls.slice(before).filter((c) => c[0] === 'drawArraysInstanced').length, 0);
  run(gl, { view: { index: 1, count: 2 } });
  assert.ok(gl.calls.slice(before).some((c) => c[0] === 'drawArraysInstanced'));
  renderer.dispose();
});

test('each glyph draw samples the SDF atlas on unit 0 and the colour atlas on unit 1', async () => {
  // Regression: making the colour atlas's placeholder texture bound it to the unit active then (the SDF atlas's), so
  // glyphs sampled an empty texture and drew no ink on a real GPU.
  const { ui, renderer, run } = setup(),
    gl = fakeGl();
  ui.add(new Label({ text: 'Menu', anchor: 'top-left' }));
  await drawn(run, renderer, gl);
  const formats = new Map(),
    units = new Map();
  let unit = 'TEXTURE0'.length,
    bound = null,
    checked = 0;
  for (const [name, ...args] of gl.calls) {
    if (name === 'activeTexture') unit = args[0];
    else if (name === 'bindTexture') units.set(unit, (bound = args[1]));
    else if (name === 'texStorage3D') formats.set(bound, args[2]);
    else if (name === 'drawArraysInstanced' && formats.size === 2) {
      const at = (u) => formats.get(units.get('TEXTURE0'.length + u));
      if (renderer.stats.glyphs && at(0) === 'R8'.length) checked++;
      assert.equal(at(0), 'R8'.length, 'unit 0 holds the SDF atlas (R8)');
      assert.equal(at(1), 'RGBA8'.length, 'unit 1 holds the colour atlas (RGBA8)');
    }
  }
  assert.ok(checked > 0, 'a draw was checked');
  renderer.dispose();
});
