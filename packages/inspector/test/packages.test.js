import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Bloom } from '@margoengine/post';
import { Shadows } from '@margoengine/shadows';
import { PbrMaterial } from '@margoengine/materials';
import { setMeshSource } from '../../shared/mesh-source.js';
import { EditHistory } from '../dist/history.js';
import { PackageEditor, describeObject, editProperty, findPackageObjects } from '../dist/packages.js';

// The objects are real package instances (Bloom, Shadows, a materials PbrMaterial) or the shapes their packages
// document (a clustered plugin's `list`, a gltf-pro primitive's material), placed on an engine without attaching them,
// so no GPU is needed: the editor finds them by shape and writes the fields those packages read every frame.
async function scene(t) {
  const dom = new JSDOM('<body></body>');
  const store = await TransformStore.create(16),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine(dom.window.document.createElement('canvas'), store, renderer, undefined, null);
  const point = { position: [1, 2, 3], range: 10 },
    spot = {
      position: [0, 4, 0],
      range: 8,
      direction: [0, -1, 0],
      outerAngle: 0.6,
      color: [1, 0.5, 0.25],
      intensity: 3,
    },
    clustered = { name: 'clustered', list: [point, spot], setup() {} },
    bloom = new Bloom({ strength: 1.2 }),
    shadows = new Shadows({}),
    material = {
      name: 'Brass',
      base: [0.8, 0.6, 0.2, 1],
      factors: [0.4, 1, 1, 1],
      emission: [0, 0, 0],
      settings: [0, 0.5, 0, 0],
      maps: [],
    },
    shaded = { ...structuredClone(material), name: 'Shaded', base: [1, 1, 1, 1], shading: { version: 3 } };
  const plugins = engine.plugins;
  for (const plugin of [clustered, bloom, shadows]) plugins.set(plugin.name, plugin);
  const mesh = engine.createMesh();
  setMeshSource(mesh, { model: { disposed: false }, primitives: [{ material }, { material }, { material: shaded }] });
  t.after(() => {
    for (const plugin of [clustered, bloom, shadows]) plugins.delete(plugin.name);
    engine.dispose();
    dom.window.close();
  });
  return { dom, engine, point, spot, bloom, shadows, material, shaded };
}
const find = (objects, id) => objects.find((o) => o.id === id);
const value = (object, key) => object.properties.find((p) => p.key === key).get();

test('findPackageObjects lists the sun, clustered lights, glTF materials once each, shadows and effects', async (t) => {
  const { engine } = await scene(t),
    objects = findPackageObjects(engine);
  assert.deepEqual(
    objects.map((o) => o.id),
    [
      'light:sun',
      'light:clustered:0',
      'light:clustered:1',
      'material:0',
      'material:1',
      'effect:bloom',
      'shadows:shadows',
    ],
  );
  const point = find(objects, 'light:clustered:0');
  // Unset colour and intensity read as the package defaults, so they can be edited before the app ever set them.
  assert.deepEqual(value(point, 'color'), [1, 1, 1]);
  assert.equal(value(point, 'intensity'), 1);
  assert.deepEqual(value(point, 'position'), [1, 2, 3]);
  assert.equal(find(objects, 'light:clustered:1').properties.find((p) => p.key === 'outerAngle').max, Math.PI / 2);
  const bloom = find(objects, 'effect:bloom');
  assert.equal(value(bloom, 'strength'), 1.2);
  assert.equal(value(bloom, 'threshold'), 1);
  const shadows = find(objects, 'shadows:shadows');
  assert.equal(value(shadows, 'bias'), 0.0005);
  assert.equal(value(shadows, 'lambda'), 0.5);
  const brass = find(objects, 'material:0');
  assert.match(brass.label, /Brass/);
  assert.deepEqual(value(brass, 'baseColor'), [0.8, 0.6, 0.2]);
  assert.equal(value(brass, 'roughness'), 0.4);
  assert.equal(value(brass, 'doubleSided'), false);
  assert.equal(brass.readOnly, undefined);
  assert.match(find(objects, 'material:1').readOnly, /materials/);
});

test('editProperty writes the field the package reads, checks kind and range, and undoes to the old or unset value', async (t) => {
  const { engine, point, bloom, shadows, material, shaded } = await scene(t),
    objects = findPackageObjects(engine),
    history = new EditHistory(200, 0);
  assert.equal(editProperty(find(objects, 'light:clustered:0'), 'intensity', 4, history), true);
  assert.equal(point.intensity, 4);
  assert.equal(editProperty(find(objects, 'light:clustered:0'), 'position', [5, 6, 7], history), true);
  assert.deepEqual(point.position, [5, 6, 7]);
  editProperty(find(objects, 'effect:bloom'), 'radius', 0.25, history);
  assert.equal(bloom.options.radius, 0.25);
  editProperty(find(objects, 'shadows:shadows'), 'bias', 0.001, history);
  assert.equal(shadows.options.bias, 0.001);
  editProperty(find(objects, 'material:0'), 'roughness', 0.9, history);
  editProperty(find(objects, 'material:0'), 'doubleSided', true, history);
  assert.equal(material.factors[0], 0.9);
  assert.equal(material.settings[2], 1);
  editProperty(find(objects, 'light:sun'), 'intensity', 2, history);
  assert.equal(engine.lighting.direction[3], 2);
  assert.equal(editProperty(find(objects, 'light:sun'), 'intensity', 2, history), false, 'no change, no step');

  assert.throws(() => editProperty(find(objects, 'effect:bloom'), 'strength', 5), RangeError);
  assert.throws(() => editProperty(find(objects, 'light:clustered:0'), 'intensity', -1), RangeError);
  assert.throws(() => editProperty(find(objects, 'light:clustered:0'), 'intensity', Number.NaN), RangeError);
  assert.throws(() => editProperty(find(objects, 'light:clustered:0'), 'position', 3), TypeError);
  assert.throws(() => editProperty(find(objects, 'light:clustered:0'), 'nope', 3), TypeError);
  assert.throws(() => editProperty(find(objects, 'material:1'), 'roughness', 0.1), { code: 'state' });
  assert.equal(shaded.factors[0], 0.4);

  while (history.undo());
  assert.equal(point.intensity, undefined, 'an option the app never set is unset again');
  assert.equal('intensity' in point, false);
  assert.deepEqual(point.position, [1, 2, 3]);
  assert.equal('radius' in bloom.options, false);
  assert.equal('bias' in shadows.options, false);
  assert.equal(material.factors[0], 0.4);
  assert.equal(material.settings[2], 0);
  assert.equal(engine.lighting.direction[3], 3);
  while (history.redo());
  assert.equal(point.intensity, 4);
  assert.equal(bloom.options.radius, 0.25);
});

test('describeObject finds a materials Material by its accessors', async () => {
  const material = new PbrMaterial({ roughness: 0.3, metalness: 0.7 }),
    properties = describeObject(material),
    keys = properties.map((p) => p.key);
  assert.ok(keys.includes('roughness') && keys.includes('metalness'), keys.join());
  const object = { id: 'object:m', group: 'object', label: 'm', target: material, properties };
  editProperty(object, 'roughness', 0.8);
  assert.equal(material.roughness, 0.8);
});

test('PackageEditor shows the objects, edits through its inputs, follows undo and lists new lights', async (t) => {
  const { dom, engine, spot } = await scene(t);
  const editor = PackageEditor.attach(engine, { parent: dom.window.document.body });
  t.after(() => editor.dispose());
  const root = editor.element.shadowRoot,
    section = (id) => root.querySelector(`[data-object="${id}"]`);
  assert.equal(root.querySelectorAll('details').length, 7);
  assert.equal(root.querySelector('script'), null);
  const intensity = [...section('light:clustered:1').querySelectorAll('label')]
    .find((l) => l.textContent.startsWith('intensity'))
    .querySelector('input');
  assert.equal(intensity.value, '3');
  intensity.value = '6';
  intensity.dispatchEvent(new dom.window.Event('input'));
  assert.equal(spot.intensity, 6);
  intensity.value = '-2';
  intensity.dispatchEvent(new dom.window.Event('input'));
  assert.equal(spot.intensity, 6, 'an out-of-range value is refused');
  assert.match(intensity.validationMessage, /0 to Infinity/);
  const color = [...section('light:clustered:1').querySelectorAll('label')]
    .find((l) => l.textContent.startsWith('color'))
    .querySelector('input');
  assert.equal(color.value, '#ffbc89');
  editor.history.undo();
  assert.equal(spot.intensity, 3);
  assert.equal(intensity.value, '3');
  // Disabled inputs for a material its shading owns.
  assert.ok([...section('material:1').querySelectorAll('input')].every((i) => i.disabled));
  engine.plugins.get('clustered').list.push({ position: [0, 0, 0], range: 1 });
  editor.refresh();
  assert.ok(section('light:clustered:2'));
  assert.equal(editor.set('light:clustered:2', 'range', 2), true);
  assert.throws(() => editor.set('light:none', 'range', 2), TypeError);
  editor.dispose();
  assert.equal(dom.window.document.querySelector('[data-margo-package-editor]'), null);
});
