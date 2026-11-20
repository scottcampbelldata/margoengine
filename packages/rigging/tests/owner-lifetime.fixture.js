// Owner/lifetime fixture for @margoengine/rigging: what an app hangs off an avatar for as long as it runs. The avatar
// is inline, a skinned triangle under a 16-joint humanoid with a mouth morph, a VRM 1.0 extension, a node constraint
// and an MToon material, so the browser leaves read no files. The model, its Animation and an Animator are the app's
// (dependencies); the face, VRM, spring, corrective, pose-tracking, VRMA, constraint, first-person and MToon bindings
// are the registrations under test. Solvers, weights, retargeting and file readers hold nothing and are left out.
import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const BONES = [
  ['hips', -1, [0, 1, 0]], ['spine', 0, [0, 0.2, 0]], ['head', 1, [0, 0.4, 0]],
  ['leftUpperLeg', 0, [0.1, -0.1, 0]], ['leftLowerLeg', 3, [0, -0.4, 0]], ['leftFoot', 4, [0, -0.4, 0]],
  ['rightUpperLeg', 0, [-0.1, -0.1, 0]], ['rightLowerLeg', 6, [0, -0.4, 0]], ['rightFoot', 7, [0, -0.4, 0]],
  ['leftUpperArm', 1, [0.2, 0.3, 0]], ['leftLowerArm', 9, [0.25, 0, 0]], ['leftHand', 10, [0.25, 0, 0]],
  ['rightUpperArm', 1, [-0.2, 0.3, 0]], ['rightLowerArm', 12, [-0.25, 0, 0]], ['rightHand', 13, [-0.25, 0, 0]],
];
// glTF node 0 is the mesh, nodes 1 to 15 the bones in BONES order, node 16 a hair tip under the head.
const HAIR = 16;
function avatarData({ mtoon = false } = {}) {
  const buffers = [], bufferViews = [], accessors = [];
  const add = (data, type, componentType = 5126) => {
    buffers.push(data);
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({ bufferView: buffers.length - 1, componentType, type,
      count: data.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type] });
    return accessors.length - 1;
  };
  const position = add(new Float32Array([-0.3, 1, 0, 0.3, 1, 0, 0, 1.6, 0]), 'VEC3');
  accessors[position].min = [-0.3, 1, 0];
  accessors[position].max = [0.3, 1.6, 0];
  const normal = add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3');
  const joints = add(new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]), 'VEC4', 5123);
  const weights = add(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4');
  const delta = add(new Float32Array([0, -0.1, 0, 0, -0.1, 0, 0, 0, 0]), 'VEC3');
  const times = add(new Float32Array([0, 1]), 'SCALAR');
  const turn = add(new Float32Array([0, 0, 0, 1, 0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)]), 'VEC4');
  const humanBones = Object.fromEntries(BONES.map(([name], i) => [name, { node: i + 1 }]));
  const vrm = {
    specVersion: '1.0', meta: { name: 'owner', authors: ['owner'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
    humanoid: { humanBones },
    expressions: { preset: { aa: { morphTargetBinds: [{ node: 0, index: 0, weight: 1 }] } } },
    firstPerson: { meshAnnotations: [{ node: 0, type: 'thirdPersonOnly' }] },
  };
  const doc = {
    asset: { version: '2.0' },
    extensionsUsed: ['VRMC_vrm', 'VRMC_node_constraint', ...(mtoon ? ['VRMC_materials_mtoon'] : [])],
    extensions: { VRMC_vrm: vrm },
    buffers: buffers.map((data) => ({ byteLength: data.byteLength })), bufferViews, accessors,
    meshes: [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal, JOINTS_0: joints, WEIGHTS_0: weights },
      targets: [{ POSITION: delta }], material: 0 }], weights: [0], extras: { targetNames: ['jawOpen'] } }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.9, 0.7, 0.6, 1], metallicFactor: 0 },
      ...(mtoon && { extensions: { VRMC_materials_mtoon: { specVersion: '1.0', shadeColorFactor: [0.5, 0.3, 0.3] } } }) }],
    nodes: [
      { mesh: 0, skin: 0 },
      ...BONES.map(([name, parent, translation], i) => ({ name, translation,
        children: [...BONES.flatMap(([, p], j) => (p === i ? [j + 1] : [])), ...(name === 'head' ? [HAIR] : [])] })),
      { name: 'hair', translation: [0, 0.1, -0.05],
        extensions: { VRMC_node_constraint: { specVersion: '1.0', constraint: { rotation: { source: 2, weight: 0.5 } } } } },
    ],
    scenes: [{ nodes: [0, 1] }],
    skins: [{ joints: [...BONES.map((_, i) => i + 1), HAIR] }],
    animations: [{ name: 'Idle', channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
      samplers: [{ input: times, output: turn }] }],
  };
  return { doc, buffers, avatar: vrm };
}
// A VRM animation of the same humanoid: the hips turn once.
function vrmaDoc() {
  const times = new Float32Array([0, 1]), turn = new Float32Array([0, 0, 0, 1, 0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)]);
  const bytes = new Uint8Array(times.byteLength + turn.byteLength);
  bytes.set(new Uint8Array(times.buffer), 0);
  bytes.set(new Uint8Array(turn.buffer), times.byteLength);
  const uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`;
  return {
    asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: { hips: { node: 0 } } } } },
    buffers: [{ byteLength: bytes.byteLength, uri }],
    bufferViews: [{ buffer: 0, byteLength: times.byteLength }, { buffer: 0, byteOffset: times.byteLength, byteLength: turn.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' }],
    nodes: [{ name: 'hips', translation: [0, 1, 0] }], scenes: [{ nodes: [0] }],
    animations: [{ name: 'Turn', channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
      samplers: [{ input: 0, output: 1 }] }],
  };
}
const signal = () => new AbortController().signal;

export async function fixtures(load = (entry) => import(entry)) {
  const { GLTFAsset, PBRModel } = await load('../../gltf/dist/pbr.js');
  const { Animation } = await load('../../animation/dist/index.js');
  const { Animator } = await load('../../animator/dist/index.js');
  const { addFace } = await load('../dist/face.js');
  const { addVRM } = await load('../dist/vrm.js');
  const { addSpringBones } = await load('../dist/springs.js');
  const { addCorrectives } = await load('../dist/correctives.js');
  const { addPoseTracking } = await load('../dist/pose-tracking.js');
  const { readVRMA, playVRMA } = await load('../dist/vrma.js');
  const { addVRMConstraints } = await load('../dist/vrm-constraints.js');
  const { addVRMFirstPerson } = await load('../dist/vrm-first-person.js');
  const { MToon } = await load('../dist/mtoon.js');
  const entries = [];
  // The app's avatar: a model registered in the scene, its Animation and, with `animator`, an Animator on it.
  const host = (engine, scene, dependency, { animator = false, mtoon = false } = {}) => {
    const data = avatarData({ mtoon });
    const model = dependency(() => new PBRModel(engine, new GLTFAsset(data.doc, data.buffers)));
    dependency(() => scene.use(model));
    const animation = dependency(() => Animation.attach(model));
    const driver = animator
      ? dependency(() => Animator.attach(animation, { initial: 'idle', states: { idle: 'Idle' }, parameters: {} }))
      : undefined;
    const dependencies = [model, animation, ...(driver ? [driver] : [])];
    return { model, animation, animator: driver, avatar: data.avatar, dependencies,
      cleanup() { driver?.dispose(); animation.dispose(); model.dispose(); } };
  };
  const bound = (name, make, options) => entries.push({ name, async create({ engine, scene, dependency }) {
    const app = host(engine, scene, dependency, options), handle = await make(app);
    return { dependencies: app.dependencies, dispose: () => handle.dispose(), cleanup: () => app.cleanup() };
  } });
  // A binding that is an Animator solver or a set of node layers registers nothing of its own: the app ties it to its
  // engine, and the shell's plugin stands for that tie.
  const tied = (name, make, options) => entries.push({ name, async create({ engine, scene, dependency }) {
    const app = host(engine, scene, dependency, options), handle = await make(app);
    return { ...ownedByEngine(scene, name, () => handle.dispose()), dependencies: app.dependencies,
      cleanup: () => app.cleanup() };
  } });
  bound('addFace', ({ animation }) => addFace(animation, { smoothing: 0 }));
  tied('addFace.animator', ({ animation, animator }) => addFace(animation, { animator, smoothing: 0 }), { animator: true });
  bound('addVRM', ({ animation, avatar }) => addVRM(animation, avatar));
  tied('addVRM.animator', ({ animation, animator, avatar }) => addVRM(animation, avatar, { animator }), { animator: true });
  tied('addSpringBones', ({ animator }) =>
    addSpringBones(animator, { chains: [{ joints: [3, HAIR], stiffness: 2, drag: 0.3 }] }), { animator: true });
  tied('addCorrectives', ({ animator }) => addCorrectives(animator,
    { shapes: [{ node: 0, target: 0, joint: 2, pose: [0, 0.2588, 0, 0.9659] }] }), { animator: true });
  bound('addPoseTracking', ({ animation, avatar }) => addPoseTracking(animation, avatar, { signal: signal() }));
  bound('playVRMA', async ({ animation, avatar }) =>
    playVRMA(await readVRMA(vrmaDoc(), { signal: signal() }), animation, avatar));
  bound('addVRMConstraints', ({ model }) => addVRMConstraints(model));
  tied('addVRMFirstPerson', ({ model }) => addVRMFirstPerson(model));
  for (const attach of [false, true]) entries.push({ name: `MToon${attach ? '.attach' : ''}`,
    create({ engine, scene, dependency }) {
      const app = host(engine, scene, dependency, { mtoon: true });
      const plugin = attach ? MToon.attach(app.model) : new MToon(app.model);
      return { plugin, dependencies: app.dependencies, dispose: () => plugin.dispose(), cleanup: () => app.cleanup() };
    } });
  return entries;
}
