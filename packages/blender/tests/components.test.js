// @margoengine/blender/components: the tags of a real Blender 5.2.3 export (tests/fixtures/components.margo, made by
// tools/blender-addon/tests/blender_components.py) as glTF extensions, then simulated by glTF PBR's physics reader with
// the real solver: the crate and the ball come to rest on the floor where the mechanics put them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Physics } from '../../physics/dist/index.js';
import { GLTFAsset } from '../../gltf/dist/pbr.js';
import { applyGLTFPhysics } from '../../gltf/dist/physics.js';
import { decodeMargo } from '../dist/index.js';
import { margoComponents, parseMargoComponents } from '../dist/components.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const bytes = await readFile(new URL('./fixtures/components.margo', import.meta.url));
const asset = decodeMargo(bytes);
const byName = (doc, name) => doc.nodes.findIndex((n) => n.name === name);
/** The asset with one node's properties replaced. */
function tagged(name, properties) {
  const document = structuredClone(asset.document);
  document.nodes[byName(document, name)].extras.margo.properties = properties;
  return { ...asset, document };
}
const rejects = (name, properties, message) =>
  assert.throws(
    () => margoComponents(tagged(name, properties)),
    (error) => error.name === 'TypeError' && error.message.includes(message),
  );

test('tags become KHR_implicit_shapes, KHR_physics_rigid_bodies and KHR_lights_punctual', () => {
  const { document, scripts, hasPhysics, hasLights } = margoComponents(asset);
  assert.equal(hasPhysics, true);
  assert.equal(hasLights, true);
  assert.deepEqual(document.extensionsUsed, ['KHR_implicit_shapes', 'KHR_physics_rigid_bodies', 'KHR_lights_punctual']);
  const shapes = document.extensions.KHR_implicit_shapes.shapes,
    node = (name) => document.nodes[byName(document, name)],
    data = (name) => node(name).extensions?.KHR_physics_rigid_bodies;
  // The cube mesh is 1 m across; the node's scale sizes it in the world.
  assert.deepEqual(shapes[data('Floor').collider.geometry.shape], { type: 'box', box: { size: [1, 1, 1] } });
  assert.equal(data('Floor').motion, undefined);
  assert.deepEqual(data('Crate').motion, { mass: 2 });
  assert.equal(shapes[data('Crate').collider.geometry.shape].type, 'box');
  const sphere = shapes[data('Ball').collider.geometry.shape];
  assert.equal(sphere.type, 'sphere');
  assert.ok(Math.abs(sphere.sphere.radius - 0.5) < 1e-6, `radius ${sphere.sphere.radius}`);
  const materials = document.extensions.KHR_physics_rigid_bodies.physicsMaterials;
  assert.equal(materials[data('Floor').collider.physicsMaterial].dynamicFriction, 0.8);
  assert.equal(materials[data('Crate').collider.physicsMaterial].dynamicFriction, 0.5);
  // The shelf's mesh is 1.5 m above its origin: its collider is on a child at the box's centre.
  const shelf = node('Shelf');
  assert.equal(shelf.extensions, undefined);
  const child = document.nodes[shelf.children[0]];
  assert.equal(child.name, 'Shelf collider');
  assert.ok(Math.abs(child.translation[1] - 1.5) < 1e-6, `centre ${child.translation}`);
  assert.ok(child.extensions.KHR_physics_rigid_bodies.collider);
  assert.ok(data('Pad').trigger && !data('Pad').collider);
  const lights = document.extensions.KHR_lights_punctual.lights,
    light = (name) => lights[node(name).extensions.KHR_lights_punctual.light];
  assert.deepEqual(light('Lamp'), { type: 'point', intensity: 40, color: [1, 0.8, 0.6], range: 12 });
  assert.deepEqual(light('Sun'), { type: 'directional', intensity: 3 });
  assert.deepEqual(light('Spot').spot, { innerConeAngle: 0.2, outerConeAngle: 0.5 });
  assert.deepEqual(
    scripts.map((s) => [s.name, document.nodes[s.nodeIndex].name]),
    [
      ['door', 'Pad'],
      ['glow', 'Pad'],
      ['door', 'Sun'],
    ],
  );
  assert.equal(scripts[0].properties['margo:trigger'], true);
  // The source document is not changed, and exported nodes keep their indices.
  assert.equal(asset.document.extensions, undefined);
  assert.equal(document.nodes.length, asset.document.nodes.length + 1);
});

test('the real solver drops the crate and the ball onto the floor and holds the shelf where its mesh is', async () => {
  const { document } = margoComponents(asset),
    physics = new Physics(null),
    gltf = await applyGLTFPhysics({ asset: new GLTFAsset(document, []), nodes: [] }, { physics });
  assert.deepEqual(gltf.notes, []);
  const crate = gltf.bodies.get(byName(document, 'Crate')),
    ball = gltf.bodies.get(byName(document, 'Ball'));
  assert.equal(crate.mass, 2);
  assert.equal(gltf.triggers.length, 1);
  assert.equal(gltf.triggers[0].nodeIndex, byName(document, 'Pad'));
  // Without margo:mass the mass follows the shape's volume at density 1.
  assert.ok(Math.abs(ball.mass - (4 / 3) * Math.PI * 0.125) < 1e-3, `ball mass ${ball.mass}`);
  for (let i = 0; i < 300; i++) physics.step();
  // The floor's top is y = 0: a 1 m crate rests at 0.5 and a 0.5 m ball at 0.5 (contact within 1 cm).
  const near = (actual, expected, bound, what) =>
    assert.ok(Math.abs(actual - expected) <= bound, `${what}: ${actual} against ${expected}`);
  near(crate.position[1], 0.5, 0.01, 'crate height');
  near(crate.position[0], 0, 0.01, 'crate x');
  near(ball.position[1], 0.5, 0.01, 'ball height');
  near(ball.position[0], 3, 0.01, 'ball x');
  const shelf = gltf.bodyOf(document.nodes[byName(document, 'Shelf')].children[0]);
  near(shelf.position[1], 1.5, 1e-6, 'shelf collider centre');
  near(shelf.position[0], -3, 1e-6, 'shelf x');
  gltf.dispose();
});

test('a tag that cannot be read names the object and the property', () => {
  rejects(
    'Crate',
    { 'margo:body': 'floating' },
    "Object 'Crate': 'margo:body' must be one of static, dynamic, kinematic",
  );
  rejects(
    'Crate',
    { 'margo:collider': 'cone' },
    "'margo:collider' must be one of box, sphere, capsule, cylinder, hull, mesh, decomposition",
  );
  rejects('Crate', { 'margo:body': 'dynamic', 'margo:collider': 'mesh' }, "'margo:collider' must be hull or decomposition");
  rejects('Crate', { 'margo:collider': 'hull', 'margo:size': [1, 1, 1] }, "'margo:size' must be on a box, sphere");
  rejects('Crate', { 'margo:body': 'dynamic', 'margo:density': -2 }, "'margo:density' must be kilograms a cubic metre");
  rejects('Crate', { 'margo:body': 'static', 'margo:density': 'oak' }, "'margo:density' must be on a dynamic body");
  rejects('Crate', { 'margo:body': 'dynamic', 'margo:density': 5, 'margo:mass': 2 }, "'margo:density' must be or margo:mass");
  rejects('Crate', { 'margo:body': 'static', 'margo:mass': 3 }, "'margo:mass' must be on a dynamic body");
  rejects('Crate', { 'margo:friction': 0.3 }, "'margo:friction' must be on an object with margo:collider");
  rejects('Crate', { 'margo:collider': 'box', 'margo:size': [1, 0, 1] }, "'margo:size' must be 3 positive numbers");
  rejects(
    'Crate',
    { 'margo:colider': 'box' },
    "'margo:colider' must be spelt as a component tag (did you mean 'margo:collider'?)",
  );
  rejects('Lamp', { 'margo:light': 'area' }, "'margo:light' must be one of point, spot, directional");
  rejects('Lamp', { 'margo:light': 'directional', 'margo:range': 4 }, "'margo:range' must be on a point or spot light");
  rejects(
    'Lamp',
    { 'margo:light': 'spot', 'margo:inner_cone': 0.6, 'margo:outer_cone': 0.5 },
    "'margo:outer_cone' must be above",
  );
  rejects('Lamp', { 'margo:intensity': 4 }, "'margo:intensity' must be on an object with margo:light");
  rejects('Lamp', { 'margo:light': 'point', 'margo:color': [1, 1] }, "'margo:color' must be 3 numbers");
  rejects('Pad', { 'margo:script': ' ' }, "'margo:script' must be a script name");
  rejects('Pad', { 'margo:trigger': 'yes' }, "'margo:trigger' must be true or false");
});

// PA-87: a hull, mesh or decomposition is the object's own mesh, and a density (kg/m³ or a material name) gives the mass,
// centre and inertia the solver integrates from that closed mesh, the same as from a box of the same cube.
test('hull, mesh and decomposition colliders take the mesh itself, and margo:density gives their mass from its volume', async () => {
  const load = async (properties) => {
    const { document } = margoComponents(tagged('Crate', properties)),
      physics = new Physics(null),
      index = byName(document, 'Crate'),
      crate = document.nodes[index],
      // As parseMargo's model has them: the crate's primitives in its node's frame, from the prepared geometry.
      primitives = asset.geometry[crate.mesh].flat().map(({ vertices, indices }) => ({ nodeIndex: index, vertices, indices })),
      gltf = await applyGLTFPhysics({ asset: new GLTFAsset(document, []), nodes: [], primitives }, { physics });
    return {
      gltf,
      collider: crate.extensions.KHR_physics_rigid_bodies.collider,
      body: gltf.bodies.get(byName(document, 'Crate')),
    };
  };
  const box = await load({ 'margo:body': 'dynamic', 'margo:collider': 'box', 'margo:density': 1 }),
    volume = box.body.mass;
  assert.ok(volume > 0);
  const hull = await load({ 'margo:body': 'dynamic', 'margo:collider': 'hull', 'margo:density': 'steel' });
  assert.equal(hull.collider.geometry.convexHull, true);
  assert.equal(typeof hull.collider.geometry.mesh, 'number');
  assert.deepEqual(hull.collider.extras, { margo: { density: 'steel' } });
  assert.equal(hull.body.colliders[0].shape, 'convexHull');
  assert.ok(Math.abs(hull.body.mass - 7850 * volume) < 1e-3 * 7850 * volume, `steel hull ${hull.body.mass} of ${volume}`);
  // The cube's inertia from its hull is the box's, times the density, about the same centre.
  const a = box.body.principalInertia.map((v) => v * 7850).sort((x, y) => x - y),
    b = hull.body.principalInertia.slice().sort((x, y) => x - y);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 2e-3 * a[i], `inertia ${b} against ${a}`);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(hull.body.centerOfMass[i] - box.body.centerOfMass[i]) < 1e-4);
  const split = await load({ 'margo:body': 'dynamic', 'margo:collider': 'decomposition', 'margo:density': 1000 });
  assert.deepEqual(split.collider.extras, { margo: { density: 1000, decomposition: true } });
  assert.equal(split.body.colliders[0].shape, 'convexDecomposition');
  assert.ok(Math.abs(split.body.mass - 1000 * volume) < 1e-3 * 1000 * volume, `decomposed cube ${split.body.mass}`);
  const mesh = await load({ 'margo:body': 'static', 'margo:collider': 'mesh' });
  assert.equal(mesh.collider.geometry.convexHull, undefined);
  assert.equal(mesh.body.colliders[0].shape, 'trimesh');
  for (const loaded of [box, hull, split, mesh]) loaded.gltf.dispose();
});

test('sizes, capsules and cylinders follow the tags, and an untagged scene is unchanged', () => {
  const shape = (properties) => {
    const { document } = margoComponents(tagged('Crate', properties)),
      data = document.nodes[byName(document, 'Crate')].extensions.KHR_physics_rigid_bodies;
    return document.extensions.KHR_implicit_shapes.shapes[data.collider.geometry.shape];
  };
  assert.deepEqual(shape({ 'margo:collider': 'box', 'margo:size': [2, 1, 3] }).box, { size: [2, 1, 3] });
  assert.deepEqual(shape({ 'margo:collider': 'capsule' }).capsule, { radiusTop: 0.5, radiusBottom: 0.5, height: 0 });
  assert.deepEqual(shape({ 'margo:collider': 'cylinder' }).cylinder, { radiusTop: 0.5, radiusBottom: 0.5, height: 1 });
  assert.deepEqual(shape({ 'margo:collider': 'capsule', 'margo:size': [0.2, 0.6] }).capsule, {
    radiusTop: 0.2,
    radiusBottom: 0.2,
    height: 0.6,
  });
  const document = structuredClone(asset.document);
  for (const node of document.nodes) node.extras.margo.properties = {};
  const plain = margoComponents({ ...asset, document });
  assert.deepEqual(plain.document, document);
  assert.equal(plain.hasPhysics || plain.hasLights, false);
});

test('a script the scene names but the caller did not register fails before any GPU work', async () => {
  await assert.rejects(
    parseMargoComponents(null, bytes, { scripts: { door() {} } }),
    (error) =>
      error.name === 'TypeError' &&
      error.message === "Object 'Pad': script 'glow' is not registered; pass it in the scripts option",
  );
});
