import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { storage, NodePass, ComputePass } from '../dist/index.js';
import { storageVolume } from '../dist/compute-volume.js';
import { storageTexture } from '../dist/compute-texture.js';
import { PassNodeEditor, compilePassGraph, parsePassGraph, serializePassGraph } from '../dist/editor-pass.js';
const graph = () => ({
  version: 1,
  nodes: [
    { id: 'input', op: 'color', inputs: [] },
    { id: 'scale', op: 'float', inputs: [], value: 0.5 },
    { id: 'out', op: 'mul', inputs: ['input', 'scale'] },
  ],
  outputs: { color: 'out' },
  fallback: { color: [0, 0, 0], emissive: [0, 0, 0], roughness: 0.5, metalness: 0, opacity: 1 },
});
const post = () => ({ version: 1, kind: 'post', graph: graph() });
const compute = () => ({
  version: 1,
  kind: 'compute',
  graph: graph(),
  compute: { size: [2, 3, 4], source: 'input', target: 'output' },
});
test('post graphs compile screen/depth/UV/time inputs and opacity in a full screen pass', () => {
  const p = compilePassGraph(post());
  assert.ok(p instanceof NodePass);
  assert.match(p.code(), /textureLoad/);
  assert.match(p.code(), /return vec4f\(.+, nd\d+\.w\);/, 'default screen copy preserves input alpha');
  for (const op of ['position', 'worldPosition', 'normal', 'worldNormal', 'uv']) {
    const doc = post();
    doc.graph.nodes = [{ id: 'input', op, inputs: [] }];
    doc.graph.outputs.color = 'input';
    assert.ok(compilePassGraph(doc).code().includes('@fragment'));
  }
});
test('compute graphs write buffers, 2d images, volumes and layers; source reads and dispatch shape persist', () => {
  const input = storage(24, 'vec4f');
  for (const output of [
    storage(24, 'vec4f'),
    storageTexture(6, 4),
    storageVolume(2, 3, 4),
    storageVolume(2, 3, 4, { dimension: '2d-array' }),
  ]) {
    const p = compilePassGraph(compute(), { input, output });
    assert.ok(p instanceof ComputePass);
    assert.match(p.code, /gid\.x/);
    assert.deepEqual(p.count, [2, 3, 4]);
    assert.match(p.code, /0\.5/);
  }
});
test('saved documents are canonical independent JSON and reject unsafe structure or incompatible resources', () => {
  const doc = post();
  doc.layout = { input: [12, 34] };
  const json = serializePassGraph(doc),
    restored = parsePassGraph(json);
  assert.equal(serializePassGraph(restored), json);
  restored.graph.nodes[0].id = 'changed';
  assert.equal(doc.graph.nodes[0].id, 'input');
  for (const bad of [
    { ...post(), kind: 'material' },
    { ...compute(), compute: { size: [0, 1, 1], target: 'out' } },
    { ...post(), layout: { missing: [1, 2] } },
    { ...post(), layout: { input: [Infinity, 0] } },
    { ...post(), colorSpace: 'bad' },
  ])
    assert.throws(() => serializePassGraph(bad));
  assert.throws(() => parsePassGraph(' '.repeat(131073)), /at most/);
  assert.throws(() => compilePassGraph(compute()), /Provide/);
  assert.throws(
    () => compilePassGraph(compute(), { input: storage(1, 'vec4f'), output: storage(24, 'vec4f') }),
    /large enough/,
  );
  assert.throws(
    () => compilePassGraph(compute(), { input: storage(24, 'vec4f'), output: storage(24, 'u32') }),
    /float/,
  );
  const invalid = post();
  invalid.graph.nodes[2].inputs[0] = 'out';
  assert.throws(() => serializePassGraph(invalid), /cycl/i);
});
test('editor inherits wiring, undo and layout, emits valid edits only, saves and hot reloads both modes', () => {
  const dom = new JSDOM('<div id="editor"></div>'),
    parent = dom.window.document.querySelector('div'),
    input = storage(24, 'vec4f'),
    output = storage(24, 'vec4f');
  const editor = new PassNodeEditor(parent, { document: post(), resources: { input, output } }),
    events = [];
  editor.onGraph((doc) => events.push(doc));
  assert.equal(events.length, 1);
  const root = editor.editor.element.shadowRoot;
  assert.equal(root.querySelector('[data-node=output]').getAttribute('aria-label'), 'Post output');
  assert.equal(root.querySelectorAll('[data-slot]').length, 2);
  assert.match(root.textContent, /Screen colour/);
  editor.editor.model.setValue('scale', 0.25);
  assert.equal(events.length, 2);
  assert.match(editor.compile().code(), /0\.25/);
  editor.editor.model.undo();
  assert.equal(events.length, 3);
  editor.editor.model.connectOutput('scale', 'color');
  assert.equal(events.length, 3, 'invalid output type preserves the last valid pass');
  editor.editor.model.undo();
  const saved = editor.save();
  editor.load(saved);
  assert.equal(editor.save(), saved);
  const before = editor.save();
  assert.throws(() => editor.load('{'));
  assert.equal(editor.save(), before);
  editor.load(compute());
  assert.ok(editor.compile() instanceof ComputePass);
  assert.match(editor.editor.element.shadowRoot.textContent, /Source value/);
  editor.dispose();
  editor.dispose();
  assert.equal(parent.children.length, 0);
  assert.throws(() => editor.save(), /new PassNodeEditor/);
});
test('abort and readOnly lifecycle leave borrowed targets alive', () => {
  const dom = new JSDOM('<div></div>'),
    parent = dom.window.document.querySelector('div'),
    signal = new AbortController();
  const e = new PassNodeEditor(parent, { signal: signal.signal, readOnly: true });
  assert.throws(() => e.load(post()), /editable/);
  signal.abort();
  assert.equal(parent.children.length, 0);
  assert.throws(() => e.compile(), /disposal/);
});
