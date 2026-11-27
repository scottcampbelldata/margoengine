import { cloneModel } from '@margoengine/animation/skeleton-utils';
import { exampleAsset } from '../live/asset-base.js';
import { PbrMaterial, box } from '@margoengine/core';
import { CatmullRomCurve3, cylinderGeometry, planeGeometry, toGeometry, tubeGeometry } from '@margoengine/geometry';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { Material, Texture, createMesh } from '@margoengine/materials';

const steel = (color, roughness = 0.72, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
const colors = {
  ground: steel('#575a53', 0.87),
  seabed: steel('#56534a', 0.94),
  rope: steel('#948774', 0.91),
  gray: steel('#6d7776', 0.6, 0.25),
  red: steel('#984b3c'),
  cream: steel('#cbc8b9'),
};
const fixtureLens = new Material({ color: '#fff6de', emissive: '#ffe0a6', emissiveIntensity: 2 });
const files = {
  plain: exampleAsset('first-wake/quay-plain.glb'),
  bollard: exampleAsset('first-wake/quay-bollard.glb'),
  crane: exampleAsset('first-wake/port-crane.glb'),
  office: exampleAsset('first-wake/port-office.glb'),
  warehouse: exampleAsset('first-wake/port-warehouse.glb'),
  container: exampleAsset('first-wake/cargo-container.glb'),
};

function berthSign() {
  const card = document.createElement('canvas');
  card.width = 512;
  card.height = 160;
  const c = card.getContext('2d');
  c.fillStyle = '#c7bba1';
  c.fillRect(0, 0, 512, 160);
  c.fillStyle = '#28353a';
  c.strokeStyle = c.fillStyle;
  c.lineWidth = 2;
  c.strokeRect(9, 9, 494, 142);
  c.textAlign = 'center';
  c.font = 'bold 57px sans-serif';
  c.fillText('BERTH 04', 256, 74);
  c.font = '600 25px sans-serif';
  c.fillText('PORT OPERATIONS', 256, 122);
  return new Texture(card, { colorSpace: 'srgb', anisotropy: 8 });
}

async function loadConcrete(signal) {
  const read = async (name, colorSpace) => {
    const url = exampleAsset('first-wake/concrete-' + name + '.jpg');
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Could not load ' + url + ' (' + response.status + ')');
    const bitmap = await createImageBitmap(await response.blob());
    return new Texture(bitmap, { colorSpace, anisotropy: 8, wrapS: 'repeat', wrapT: 'repeat' });
  };
  const textures = await Promise.all([read('color', 'srgb'), read('normal', 'linear'), read('orm', 'linear')]);
  const [map, normalMap, orm] = textures;
  const material = new Material({
    color: '#b4b4a9',
    roughness: 1,
    map,
    normalMap,
    metalRoughnessMap: orm,
    aoMap: orm,
  });
  return { material, textures };
}

export async function makeHarbor(engine, signal) {
  const [plain, bollard, crane, office, warehouse, container, concrete] = await Promise.all([
    ...Object.values(files).map((url) => loadGLTF(engine, url, { signal })),
    loadConcrete(signal),
  ]);
  signal.throwIfAborted();
  const fixed = engine.createMesh();
  const ship = engine.createMesh();
  const casters = [];
  const models = [];
  const solid = box();
  const round = toGeometry(cylinderGeometry(1, 1, 1, 18));

  function mesh(geometry, material, position, scale = [1, 1, 1], casts = true) {
    const node = engine.createMesh().setParent(fixed).setGeometry(geometry).setMaterial(material);
    node.setPosition(position).setScale(scale);
    if (casts) casters.push(node);
    return node;
  }
  function place(model, position, heading = 0, scale = 1) {
    model.root.setParent(fixed).setPosition(position).setRotation([0, heading, 0]).setScale([scale, scale, scale]);
    models.push(model);
    casters.push(model);
    return model;
  }
  function rope(points, radius) {
    return mesh(toGeometry(tubeGeometry(new CatmullRomCurve3(points), 12, radius, 8)), colors.rope, [0, 0, 0]);
  }
  function beacon(position, scale = 1) {
    const [x, y, z] = position;
    const light = createMesh(engine, cylinderGeometry(0.125 * scale, 0.125 * scale, 0.14 * scale, 16), fixtureLens);
    light.root.setParent(fixed).setPosition([x, y, z]);
    models.push(light);
  }

  // Ten-metre quay modules share packed mesh and texture storage across their clones.
  for (let i = 0; i < 28; i++) {
    const template = i % 2 ? plain : bollard;
    const section = i < 2 ? template : await cloneModel(template);
    place(section, [-74 + i * 10, 1.97, -10.55]);
  }
  for (let i = 0; i < 9; i++) {
    place(await cloneModel(plain), [200.4, 1.97, -15.55 - i * 10], Math.PI / 2);
  }
  signal.throwIfAborted();
  mesh(solid, colors.seabed, [10, -10.1, 7], [1390, 0.8, 1280], false);
  mesh(solid, colors.ground, [60.7, -1.92, -57.9], [279.4, 7.6, 94.4]);
  const apron = planeGeometry(279.4, 94.4);
  for (let i = 0; i < apron.uvs.length; i += 2) {
    apron.uvs[i] *= 70;
    apron.uvs[i + 1] *= 24;
  }
  const apronModel = createMesh(engine, apron, concrete.material);
  apronModel.root
    .setParent(fixed)
    .setPosition([60.7, 1.89, -57.9])
    .setRotation([-Math.PI / 2, 0, 0]);
  models.push(apronModel);

  place(warehouse, [-53, 1.93, -39], 0, 0.98);
  place(await cloneModel(warehouse), [-5, 1.93, -44], 0, 0.91);
  place(await cloneModel(warehouse), [46, 1.93, -41], Math.PI, 1.03);
  place(office, [78, 1.93, -35], -0.1, 0.88);
  place(crane, [111, 1.93, -57], 0, 0.87);
  place(await cloneModel(crane), [160, 1.93, -66], 0, 0.97);
  const containerCopies = [container, ...(await Promise.all(Array.from({ length: 9 }, () => cloneModel(container))))];
  for (const [i, model] of containerCopies.entries()) {
    const stack = Math.floor(i / 3);
    const level = i % 3;
    place(model, [91 + stack * 15.4, 1.93 + level * 2.59, -23 - 4.0 * (stack % 2)], Math.PI / 2);
  }
  signal.throwIfAborted();

  for (const x of [-59, -26, 13, 47, 78]) {
    mesh(round, colors.gray, [x, 5.35, -14.5], [0.135, 6.7, 0.135]);
    mesh(solid, colors.gray, [x, 8.65, -14.05], [0.18, 0.16, 1.1]);
    beacon([x, 8.54, -13.57], 0.75);
  }
  const sign = berthSign();
  const signModel = createMesh(
    engine,
    planeGeometry(2.4, 0.75),
    new Material({ color: '#e6e2d7', roughness: 0.82, map: sign }),
  );
  signModel.root.setParent(fixed).setPosition([-48.5, 3.16, -11.83]);
  models.push(signModel);
  for (const x of [-49.7, -47.3]) mesh(solid, colors.gray, [x, 2.72, -11.9], [0.08, 1.53, 0.08]);

  mesh(round, colors.red, [151, 4.89, -12.5], [0.65, 6.08, 0.65]);
  mesh(round, colors.cream, [151, 4.2, -12.5], [0.653, 1.32, 0.653]);
  mesh(round, colors.cream, [151, 7.27, -12.5], [0.653, 0.95, 0.653]);
  beacon([151, 8.06, -12.5], 2.3);

  const moorings = [
    rope(
      [
        [-22, 3.3, -6.15],
        [-28.3, 1.5, -8.35],
        [-34.0, 2.35, -10.94],
      ],
      0.095,
    ),
    rope(
      [
        [24, 2.9, -5.75],
        [25.4, 1.63, -8.6],
        [26.0, 2.36, -10.94],
      ],
      0.095,
    ),
    rope(
      [
        [32, 3.4, -4.2],
        [38.4, 1.58, -7.3],
        [46.0, 2.35, -10.94],
      ],
      0.095,
    ),
  ];

  return { models, casters, textures: [...concrete.textures, sign], moorings, ship };
}
