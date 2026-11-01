import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createRobloxCollisionScript, createRobloxUVSwap } from '@margoengine/exporters/roblox-uv';
import { createUnityUVClips, unityUVClips } from '@margoengine/exporters/unity-uv';
import { createUnrealImportScript, unrealCollisionNames, unrealFlipbooks } from '@margoengine/exporters/unreal-import';

const channel = (material, property, times, values, over = {}) => ({
  material,
  texture: 'baseColorTexture',
  property,
  interpolation: 'STEP',
  times,
  values,
  ...over,
});
function scene(times = [0, 0.25, 0.5, 0.75], offsets = [0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5], over = {}) {
  const water = { name: 'water' };
  return {
    nodes: [
      { name: 'pool', material: water, children: [{ name: 'edge', primitives: [{ material: water }] }] },
      { name: 'wall-colonly' },
      { name: 'rock-convcol' },
      { name: 'crate-convcolonly' },
      { name: 'crate-convcolonly' },
      { name: 'floor-col' },
      { name: 'plain' },
    ],
    materialAnimations: [
      {
        name: 'flow',
        channels: [channel(water, 'scale', [0], [0.5, 0.5]), channel(water, 'offset', times, offsets)],
      },
    ],
    ...over,
  };
}
const withoutColonly = () => {
  const s = scene();
  return { ...s, nodes: s.nodes.filter((n) => n.name !== 'wall-colonly') };
};

test('Unreal names: convex suffixes become UCX, UBX or USP per mesh, -col uses the mesh itself', () => {
  assert.deepEqual(unrealCollisionNames(withoutColonly(), { shapes: { 'rock-convcol': 'sphere' } }), [
    { node: 'rock-convcol', importName: 'USP_rock_00', mesh: 'rock' },
    { node: 'crate-convcolonly', importName: 'UCX_crate_00', mesh: 'crate' },
    { node: 'crate-convcolonly', importName: 'UCX_crate_01', mesh: 'crate' },
  ]);
  assert.equal(
    unrealCollisionNames({ nodes: [{ name: 'b-convcol' }] }, { shapes: { 'b-convcol': 'box' } })[0].importName,
    'UBX_b_00',
  );
  assert.throws(() => unrealCollisionNames(scene()), /wall-colonly is a concave collider.*-convcolonly/);
  assert.throws(
    () => unrealCollisionNames({ nodes: [{ name: 'b-convcol' }] }, { shapes: { 'b-convcol': 'cone' } }),
    /shape cone/,
  );
  assert.throws(
    () => unrealCollisionNames({ nodes: [{ name: 'b-convcol' }] }, { shapes: { 'b-convcol': 'toString' } }),
    /shape toString/,
  );
});

test('Unreal flipbook: a grid of cels at one rate gives its parameters, and the script references them', () => {
  assert.deepEqual(unrealFlipbooks(scene()), [
    {
      clip: 'flow',
      material: 'water',
      fps: 4,
      frames: 4,
      columns: 2,
      scale: [0.5, 0.5],
      origin: [0, 0],
      step: [0.5, 0.5],
    },
  ]);
  const python = createUnrealImportScript(withoutColonly(), { contentPath: '/Game/Hero' });
  assert.match(python, /^import unreal/);
  assert.match(python, /CONTENT = "\/Game\/Hero"/);
  assert.match(python, /COMPLEX_MESHES = \["floor"\]/, 'every -col mesh, and only those');
  assert.match(python, /"clip":"flow"/);
  assert.match(python, /CTF_USE_COMPLEX_AS_SIMPLE/);
  assert.match(python, /MaterialExpressionFmod/);
  assert.match(python, /MP_BASE_COLOR/);
  assert.throws(() => createUnrealImportScript(withoutColonly(), { contentPath: 'Game"' }), /content path/);
});

test('Unreal flipbook: a single row steps as a panner, and what no grid can hold is refused with the fix', () => {
  const row = unrealFlipbooks(scene([0, 0.5, 1], [0, 0, 0.25, 0, 0.5, 0]))[0];
  assert.deepEqual([row.columns, row.step, row.fps], [3, [0.25, 0], 2]);
  assert.throws(() => unrealFlipbooks(scene([0, 0.1, 0.5], [0, 0, 0.5, 0, 0, 0.5])), /unequal times.*regular grid/);
  assert.throws(() => unrealFlipbooks(scene([0, 1, 2], [0, 0, 0.5, 0, 0.1, 0.9])), /steps off a grid/);
  assert.throws(() => unrealFlipbooks(scene([0], [0, 0])), /has one cel/);
  const water = { name: 'w' };
  assert.throws(
    () =>
      unrealFlipbooks({
        nodes: [{ name: 'n', material: water }],
        materialAnimations: [
          {
            channels: [
              channel(water, 'scale', [0, 1], [1, 1, 0.5, 0.5]),
              channel(water, 'offset', [0, 1], [0, 0, 0, 0]),
            ],
          },
        ],
      }),
    /unequal sizes/,
  );
});

test('channels nothing can map are refused for every engine, with the fix named', async () => {
  const water = { name: 'w' },
    build = (over) => ({
      nodes: [{ name: 'n', material: water }],
      materialAnimations: [{ channels: [channel(water, 'offset', [0], [0, 0], over)] }],
    }),
    texture = () => ({ data: new Uint8Array(4), width: 1, height: 1 });
  for (const run of [unrealFlipbooks, unityUVClips, (s) => createRobloxUVSwap(s, { texture })]) {
    await assert.rejects(async () => run(build({ interpolation: 'LINEAR' })), /LINEAR keys; bake it to STEP/);
    await assert.rejects(async () => run(build({ property: 'rotation' })), /animate base-color offset or scale/);
    await assert.rejects(
      async () => run({ nodes: [], materialAnimations: build({}).materialAnimations }),
      /which no node draws/,
    );
  }
});

test('Unity: every channel and every drawing node maps to _ST curves, with V flipped', () => {
  const [clip] = unityUVClips(scene());
  assert.equal(clip.name, 'flow');
  assert.deepEqual([...new Set(clip.curves.map((c) => c.path))], ['pool', 'pool/edge']);
  const byAxis = Object.fromEntries(clip.curves.filter((c) => c.path === 'pool').map((c) => [c.property, c]));
  assert.deepEqual(byAxis['material.baseColorTexture_ST.x'].values, [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(byAxis['material.baseColorTexture_ST.z'].values, [0, 0.5, 0, 0.5]);
  assert.deepEqual(byAxis['material.baseColorTexture_ST.w'].values, [0.5, 0.5, 0, 0], 'a top row is high in Unity');
  assert.deepEqual(byAxis['material.baseColorTexture_ST.w'].times, [0, 0.25, 0.5, 0.75]);
  const files = createUnityUVClips(scene(), { folder: 'Hero' });
  assert.deepEqual(
    files.map((f) => f.name),
    ['Editor/BuildUVClips.cs', 'uv-clips.json'],
  );
  assert.deepEqual(JSON.parse(files[1].data).clips[0].name, 'flow');
  assert.match(files[0].data, /"Assets\/Hero"/);
  assert.match(files[0].data, /namespace MargoExport\.Hero/);
  assert.match(files[0].data, /float\.PositiveInfinity/, 'constant keys');
  assert.throws(() => createUnityUVClips(scene(), { folder: 'a/b' }), /folder a\/b/);
});

// The RGBA pixels of a PNG this package wrote: Sub filter rows.
function decode(file) {
  const view = new DataView(file.buffer, file.byteOffset),
    width = view.getUint32(16),
    height = view.getUint32(20),
    rows = inflateSync(file.subarray(41, 41 + view.getUint32(33))),
    out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 4; x++)
      out[y * width * 4 + x] = rows[y * (width * 4 + 1) + 1 + x] + (x < 4 ? 0 : out[y * width * 4 + x - 4]);
  return { width, height, data: out };
}

test('Roblox: one PNG per cel holds exactly that cel, and the Luau names every cel and part', async () => {
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set([i, i * 2, i * 3, 255], i * 4);
  const files = await createRobloxUVSwap(scene(), {
      texture: (material) => (assert.equal(material.name, 'water'), { data, width: 4, height: 4 }),
    }),
    names = files.map((f) => f.name);
  assert.deepEqual(names, [
    'UVIds.luau',
    'UVSwap.luau',
    'cels/flow_water_0.png',
    'cels/flow_water_1.png',
    'cels/flow_water_2.png',
    'cels/flow_water_3.png',
  ]);
  const cel = decode(files.find((f) => f.name === 'cels/flow_water_3.png').data);
  assert.deepEqual([cel.width, cel.height], [2, 2]);
  assert.deepEqual([...cel.data.subarray(0, 4)], [10, 20, 30, 255], 'pixel (2, 2) of the texture');
  const ids = files.find((f) => f.name === 'UVIds.luau').data,
    swap = files.find((f) => f.name === 'UVSwap.luau').data;
  for (let k = 0; k < 4; k++) {
    assert.match(ids, new RegExp(`\\["flow_water_${k}"\\] = ""`));
    assert.match(swap, new RegExp(`time = ${k / 4}, cel = "flow_water_${k}"`));
  }
  assert.match(swap, /length = 1,/);
  assert.match(swap, /parts = \{ "pool", "pool\/edge" \}/);
  assert.match(swap, /part\.TextureID = ids\[step\.cel\]/);
  assert.match(swap, /UVIds has no id for/);
  await assert.rejects(
    createRobloxUVSwap(scene([0], [0.75, 0]), { texture: () => ({ data, width: 4, height: 4 }) }),
    /leaves its 4x4 texture/,
  );
  await assert.rejects(createRobloxUVSwap(scene(), { texture: () => ({ data, width: 3, height: 4 }) }), /for 3x4/);
});

test('Roblox collision: colliders turn invisible with CanCollide; plain nodes are left alone', () => {
  const luau = createRobloxCollisionScript(scene());
  assert.match(luau, /path = "wall-colonly", convex = false, visible = false/);
  assert.match(luau, /path = "rock-convcol", convex = true, visible = true/);
  assert.match(luau, /path = "floor-col", convex = false, visible = true/);
  assert.doesNotMatch(luau, /"plain"/);
  assert.match(luau, /Transparency = 1/);
  assert.match(luau, /CanCollide = true/);
  assert.match(luau, /Enum\.CollisionFidelity\.Hull/);
});
