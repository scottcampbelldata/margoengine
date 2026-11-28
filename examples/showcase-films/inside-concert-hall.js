import { PbrMaterial, box as coreBox } from '@margoengine/core';
import { ColorBackground } from '@margoengine/environment';
import { geometryData } from '@margoengine/geometry/utils';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { parseIFC } from '@margoengine/ifc';
import { createMeshes } from '@margoengine/loaders';
import { SectionPlanes } from '@margoengine/machinery/section';
import { Material, Texture } from '@margoengine/materials';
import { SSR } from '@margoengine/post/ssr';
import { IfcAPI } from 'web-ifc';
import { finishTexture, mix, ramp, shotAt } from './film.js';
import { asset as libraryAsset } from './assets.js';

const stageY = 0.93;
const timber = ['#8f603d', '#a67449', '#ae7c54', '#956641', '#a9784e'];
const asset = (name) => new URL(libraryAsset('technical-films/' + name));

async function imageTexture(name, colorSpace) {
  const response = await fetch(asset(name));
  if (!response.ok) throw Error('Unable to read hall texture ' + name);
  const bitmap = await createImageBitmap(await response.blob());
  return new Texture(bitmap, { colorSpace, wrapS: 'repeat', wrapT: 'repeat' });
}

function apron() {
  const shape = [
    [-8.45, -15.2],
    [-8.45, -6.45],
  ];
  for (let i = 1; i < 33; i++) {
    const t = i / 32;
    shape.push([mix(-8.45, 8.45, t), -6.45 + 1.26 * Math.sin(Math.PI * t)]);
  }
  shape.push([8.45, -15.2]);
  return shape;
}

function levelSurface(points, height, scale = 1) {
  const pos = points.flatMap(([x, z]) => [x, height, z]);
  const normal = points.flatMap(() => [0, 1, 0]);
  const uv = points.flatMap(([x, z]) => [x * scale, z * scale]);
  const index = [];
  for (let i = 1; i < points.length - 1; i++) index.push(0, i, i + 1);
  return geometryData(pos, normal, uv, index);
}

async function loadStructure(engine, shadows) {
  const api = new IfcAPI();
  api.SetWasmPath('/node_modules/web-ifc/', true);
  const response = await fetch(asset('cedar-hall.ifc'));
  if (!response.ok) throw Error('Unable to read the Cedar Hall IFC file.');
  await api.Init(undefined, true);
  const ifc = parseIFC(api, new Uint8Array(await response.arrayBuffer()), { maxTriangles: 8000 });
  const structure = createMeshes(engine, ifc, { roughness: 0.63, metalness: 0.25, doubleSided: false });
  for (const mesh of structure.meshes) shadows.add(mesh);
  return { ifc, structure };
}

export async function buildConcertHall(engine, shop, cluster, shadows) {
  const { group, part, box, beam, sign } = shop;
  ColorBackground.attach(engine, { color: '#111a23', bottom: '#29353d' });
  const [plankColor, plankNormal, plankRough, piano, { ifc, structure }] = await Promise.all([
    imageTexture('wood-floor-diff.jpg', 'srgb'),
    imageTexture('wood-floor-nor_gl.jpg', 'linear'),
    imageTexture('wood-floor-rough.jpg', 'linear'),
    loadGLTF(engine, asset('grand-piano.glb').href),
    loadStructure(engine, shadows),
  ]);
  piano.root.setPosition([-0.96, stageY, -10.55]).setRotation([0, -0.29, 0]);
  const timberGrain = finishTexture(27212, { r: 169, grain: 24, streak: true, mottling: 22 });
  const fabricGrain = finishTexture(62718, { r: 202, grain: 28, mottling: 11 });
  const mineral = finishTexture(5132, { r: 199, grain: 30, mottling: 24 });
  const finish = (color, roughness, metalness = 0, roughnessMap) =>
    new Material({ color, roughness, metalness, roughnessMap });
  const emitter = (color, emissiveIntensity) =>
    new Material({ color, roughness: 0.33, emissive: color, emissiveIntensity });
  const cedar = timber.map((color) => finish(color, 0.48, 0, timberGrain));
  const walnut = finish('#674831', 0.53, 0, timberGrain);
  const shellMat = finish('#5b4231', 0.49, 0, timberGrain);
  const brass = finish('#a98658', 0.36, 0.78, timberGrain);
  const guard = finish('#4d534c', 0.53, 0.59, mineral);
  const shadow = finish('#343a38', 0.75, 0, mineral);
  const fireCurtain = finish('#42514c', 0.94, 0, fabricGrain);
  const ceiling = finish('#c1a27f', 0.55, 0, timberGrain);
  const pile = ['#35514b', '#36514e', '#435e56', '#405853'].map((c) => finish(c, 0.86, 0, fabricGrain));
  const floor = new Material({
    color: '#d5b69a',
    map: plankColor,
    normalMap: plankNormal,
    roughnessMap: plankRough,
    roughness: 0.65,
    metalness: 0,
  });
  const aisleLamp = emitter('#ffcb82', 1.2);
  const fixtureLamp = emitter('#ffdfad', 2.5);
  const exitLamp = emitter('#799e9d', 0.95);
  const houseWall = new PbrMaterial({ color: '#8e8173', roughness: 0.71 });
  const finishedFloor = new PbrMaterial({ color: '#6d675f', roughness: 0.68 });
  const closed = (name, size, position, material) => {
    const mesh = engine
      .createMesh()
      .setGeometry(coreBox(...size))
      .setMaterial(material)
      .setPosition(position);
    mesh.name = name;
    shadows.add(mesh);
    return mesh;
  };

  closed('Ground and floor slab', [31, 0.45, 43], [0, -0.26, 0], finishedFloor);
  for (const x of [-10.12, 10.12]) closed('Closed side wall', [0.43, 10.95, 34.6], [x, 5.47, 0], houseWall);
  for (const z of [-17.28, 17.28]) closed('Closed transverse wall', [20.4, 10.95, 0.43], [0, 5.47, z], houseWall);
  closed('Roof slab', [20.7, 0.33, 35.1], [0, 11.08, 0], houseWall);

  const stage = apron();
  part(levelSurface(stage, stageY, 0.37), floor);
  for (let i = 1; i < stage.length - 1; i++) {
    const [ax, az] = stage[i],
      [bx, bz] = stage[i + 1];
    const midX = (ax + bx) / 2,
      midZ = (az + bz) / 2;
    const length = Math.hypot(bx - ax, bz - az);
    const angle = Math.atan2(-(bz - az), bx - ax);
    box([length + 0.019, stageY, 0.145], walnut, [midX, stageY / 2 - 0.012, midZ], [0, angle, 0], undefined, 0.014);
    box([length + 0.023, 0.039, 0.036], brass, [midX, stageY - 0.021, midZ + 0.083], [0, angle, 0], undefined, 0.009);
  }
  box([16.8, 0.84, 8.4], shadow, [0, 0.437, -11.1], undefined, undefined, 0.04);
  const bench = group('Piano bench', null, [-0.48, stageY, -9.15]);
  box([1, 0.1, 0.43], pile[1], [0, 0.5, 0], undefined, bench, 0.061);
  box([0.95, 0.055, 0.42], walnut, [0, 0.435, 0], undefined, bench, 0.014);
  for (const x of [-0.38, 0.38])
    for (const z of [-0.147, 0.147]) beam([x * 1.09, 0, z * 1.09], [x, 0.442, z], 0.058, walnut, bench);

  const stalls = group('Raked stalls');
  const seatBack = roundedBoxGeometry(0.515, 0.432, 0.09, 2, 0.055);
  const seatPad = roundedBoxGeometry(0.53, 0.094, 0.41, 2, 0.041);
  const backShell = roundedBoxGeometry(0.533, 0.433, 0.055, 2, 0.025);
  function chair(x, y, z, row, col, parent) {
    const cloth = pile[(row + col * 3) % pile.length];
    part(seatPad, cloth, [x, y + 0.492, z + 0.032], undefined, parent);
    part(seatBack, cloth, [x, y + 0.699, z + 0.235], [0.091, 0, 0], parent);
    part(backShell, shellMat, [x, y + 0.697, z + 0.285], [0.091, 0, 0], parent);
    for (const dx of [-0.268, 0.268]) {
      box([0.035, 0.588, 0.13], guard, [x + dx, y + 0.294, z + 0.09], [0.027, 0, 0], parent, 0.011);
      box([0.061, 0.022, 0.17], guard, [x + dx, y + 0.013, z + 0.092], undefined, parent, 0.007);
      box([0.048, 0.039, 0.372], walnut, [x + dx, y + 0.602, z + 0.064], undefined, parent, 0.013);
    }
  }
  const banks = [
    [-7.33, -6.72, -6.11, -5.5, -4.89, -4.28],
    [-3.13, -2.51, -1.89, -1.27, -0.65, 0, 0.65, 1.27, 1.89, 2.51, 3.13],
    [4.28, 4.89, 5.5, 6.11, 6.72, 7.33],
  ];
  for (let row = 0; row < 18; row++) {
    const z = -3.6 + row * 0.988,
      y = 0.05 + row * 0.119;
    box([17.58, y + 0.04, 0.992], shadow, [0, y / 2 - 0.02, z], undefined, stalls, 0.008);
    box([17.59, 0.015, 0.989], shellMat, [0, y - 0.008, z], undefined, stalls, 0.006);
    for (const [bank, columns] of banks.entries())
      for (const [col, x] of columns.entries()) chair(x, y, z, row, col + bank, stalls);
    for (const x of [-8.09, -3.72, 3.72, 8.09]) {
      box([0.66, 0.013, 0.028], brass, [x, y + 0.004, z - 0.461], undefined, stalls, 0.003);
      box([0.138, 0.016, 0.028], aisleLamp, [x * 1.036, y + 0.013, z - 0.445], undefined, stalls, 0.004);
    }
  }
  const rear = group('Rear balcony');
  const galleryDepth = 5.03;
  closed('Reinforced balcony soffit', [18.8, 0.37, galleryDepth + 0.22], [0, 3.84, 14.56], houseWall);
  box([18.9, 0.21, 0.195], walnut, [0, 4.04, 11.97], undefined, rear, 0.04);
  box([18.93, 0.038, 0.197], aisleLamp, [0, 3.924, 11.966], undefined, rear, 0.009);
  for (let row = 0; row < 5; row++) {
    const z = 12.49 + row * 0.93,
      y = 4.075 + row * 0.224;
    box([18.7, y - 3.93, 0.938], walnut, [0, (y + 3.93) / 2, z], undefined, rear, 0.014);
    for (const [bank, columns] of banks.entries())
      for (const [col, x] of columns.entries()) chair(x, y, z, row + 19, col + bank, rear);
  }
  for (let x = -9.21; x < 9.41; x += 0.74) beam([x, 4.02, 11.94], [x, 4.99, 11.94], 0.024, brass, rear, true);
  beam([-9.25, 4.99, 11.94], [9.25, 4.99, 11.94], 0.043, brass, rear, true);
  for (const side of [-1, 1]) {
    const x = 8.93 * side;
    closed('Lateral acoustic gallery slab', [1.86, 0.32, 24.3], [x, 3.78, 0.05], houseWall);
    box([0.18, 0.24, 24.4], walnut, [side * 7.96, 3.96, 0.05], undefined, undefined, 0.035);
    beam([side * 7.91, 4.92, -12.15], [side * 7.91, 4.92, 12.15], 0.05, brass, undefined, true);
    for (let z = -12.15; z < 12.2; z += 0.78)
      beam([side * 7.91, 3.97, z], [side * 7.91, 4.92, z], 0.024, brass, undefined, true);
  }

  // Relief panels, service doors and recessed house fixtures.
  for (const side of [-1, 1]) {
    for (let panel = 0; panel < 73; panel++) {
      const z = -15.9 + panel * 0.444;
      const shift = 0.1 + 0.066 * Math.sin(panel * 0.71) + 0.045 * Math.sin(panel * 0.235);
      const x = side * (9.83 - shift);
      if (!(z > 12.15 && z < 13.65))
        box(
          [0.24 + shift, 3.38, 0.43],
          cedar[panel % 5],
          [x, 1.72, z],
          [0, side * 0.057 * Math.sin(panel * 0.45), 0],
          undefined,
          0.018,
        );
      box(
        [0.27 + shift, 3.64, 0.428],
        cedar[(panel + 2) % 5],
        [x - side * 0.1, 6.08, z],
        [0, side * 0.085 * Math.sin(panel * 0.44), 0],
        undefined,
        0.018,
      );
    }
    for (const y of [0.31, 3.55, 8.14])
      box([0.22, 0.115, 32.3], walnut, [side * 9.65, y, 0], undefined, undefined, 0.022);
    for (const z of [-12.1, -7.2, -2.3, 2.6, 7.5, 12.4]) {
      box([0.106, 0.702, 0.26], brass, [side * 9.47, 2.58, z], undefined, undefined, 0.035);
      box([0.029, 0.496, 0.111], fixtureLamp, [side * 9.405, 2.58, z], undefined, undefined, 0.013);
      box([0.12, 0.042, 0.53], shadow, [side * 9.43, 2.915, z], undefined, undefined, 0.009);
    }
    for (const y of [2.11, 5.48]) {
      box([0.144, 2.24, 1.43], walnut, [9.56 * side, y - 1.1, 12.89], undefined, undefined, 0.035);
      box([0.04, 0.13, 0.57], exitLamp, [9.46 * side, y + 0.168, 12.89], undefined, undefined, 0.011);
    }
  }
  for (let i = 0; i < 69; i++) {
    const x = (i - 34) * 0.257;
    const z = -15.98 + 0.102 * Math.cos(x * 0.5) + 0.055 * Math.cos(i * 0.55);
    box(
      [0.221, 7.3 + (i % 3) * 0.055, 0.29],
      cedar[(i + 1) % 5],
      [x, 4.98, z],
      [0, 0.043 * Math.sin(i * 0.91), 0],
      undefined,
      0.016,
    );
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 20; i++) {
      const x = side * (6.15 + i * 0.155);
      box([0.195, 6.34, 0.2 + 0.065 * Math.sin(i * 1.9)], fireCurtain, [x, 4.054, -14.95], undefined, undefined, 0.065);
    }
    box([3.12, 0.17, 0.26], walnut, [side * 7.65, 7.319, -14.95], undefined, undefined, 0.03);
  }
  sign(['CEDAR HALL'], [2.3, 0.37], [0, 4.46, -15.68], undefined, undefined, {
    background: '#61442e',
    foreground: '#e3caa7',
    lit: 0.45,
  });

  const canopy = group('Suspended acoustic reflectors');
  for (let row = 0; row < 9; row++) {
    const z = -13.5 + row * 3.43;
    for (const bay of [-1, 0, 1]) {
      const x = bay * 4.66;
      const y = 8.12 + (bay === 0 ? 0.64 : 0.17) + 0.24 * Math.sin(row * 0.64 + bay);
      const tilt = [-0.043 + 0.057 * Math.cos(row * 0.64), 0, bay * 0.18];
      box([4.6, 0.174, 2.62], ceiling, [x, y, z], tilt, canopy, 0.051);
      for (const dx of [-1.7, 1.7]) beam([x + dx, y + 0.085, z], [x + dx, 10.54, z], 0.009, guard, canopy, true);
      if (bay === 0) box([3.44, 0.041, 0.059], fixtureLamp, [x, y - 0.088, z + 1.03], tilt, canopy, 0.014);
    }
  }
  // The catwalks flank two real IFC supply runs. Flanges and rails remain visible in the building section.
  for (const side of [-1, 1]) {
    const x = side * 7.93;
    for (const dx of [-0.48, 0.48]) {
      for (const y of [8.92, 9.42]) beam([x + dx, y, -14.04], [x + dx, y, 14.7], 0.025, guard, undefined, true);
      for (let z = -14.03; z < 14.8; z += 1.05)
        beam([x + dx, 8.4, z], [x + dx, 9.43, z], 0.025, guard, undefined, true);
    }
    for (let z = -13.95; z < 14.7; z += 0.159) box([1.015, 0.015, 0.025], guard, [x, 8.413, z]);
    for (let z = -13; z < 15; z += 2.44) {
      box([0.94, 0.656, 0.051], brass, [side * 6.7, 10.041, z], undefined, undefined, 0.008);
    }
    for (let bay = 0; bay < 8; bay++)
      box([1.68, 0.14, 0.235], guard, [side * 8.42, 8.22, -14.35 + 4.1 * bay], undefined, undefined, 0.014);
  }

  const lights = [
    {
      position: [-4.3, 7.36, -8.03],
      direction: [0.35, -0.62, -0.45],
      range: 19,
      angle: 0.68,
      penumbra: 0.82,
      color: [1, 0.74, 0.49],
      intensity: 222,
    },
    {
      position: [4.25, 7.46, -7.74],
      direction: [-0.4, -0.65, -0.42],
      range: 18,
      angle: 0.73,
      penumbra: 0.68,
      color: [1, 0.82, 0.6],
      intensity: 196,
    },
    {
      position: [0.55, 7.83, -13.55],
      direction: [-0.14, -0.75, 0.45],
      range: 17,
      angle: 0.6,
      penumbra: 0.72,
      color: [1, 0.7, 0.45],
      intensity: 167,
    },
    {
      position: [0, 7.92, 7.74],
      direction: [0, -0.75, -0.14],
      range: 18,
      angle: 0.91,
      penumbra: 0.7,
      color: [0.83, 0.91, 1],
      intensity: 128,
    },
  ];
  for (const side of [-1, 1])
    for (const z of [-10.1, -3.1, 4.1, 11.1])
      lights.push({
        position: [side * 9.04, 4.43, z],
        direction: [side * -0.27, -0.82, -0.1],
        range: 12,
        angle: 0.88,
        penumbra: 0.68,
        color: [1, 0.69, 0.44],
        intensity: 61,
      });
  for (const x of [-7.93, 7.93])
    for (const z of [-10.6, -3.3, 4.1, 11.3]) {
      beam([x, 10.59, z], [x, 10.95, z], 0.035, guard);
      box([0.65, 0.08, 0.19], guard, [x, 10.57, z], undefined, undefined, 0.017);
      box([0.56, 0.025, 0.105], fixtureLamp, [x, 10.524, z], undefined, undefined, 0.008);
      lights.push({
        position: [x, 10.46, z],
        direction: [0, -1, 0],
        range: 6,
        angle: 0.92,
        penumbra: 0.74,
        color: [1, 0.83, 0.6],
        intensity: 43,
      });
    }
  const surveyLight = {
    position: [13.5, 13.5, 5.6],
    direction: [-0.76, -0.51, -0.14],
    range: 36,
    angle: 0.86,
    penumbra: 0.79,
    color: [0.72, 0.85, 1],
    intensity: 0,
  };
  lights.push(surveyLight);
  cluster.setLights(lights);

  const cut = [-1, 0, 0, 10.8];
  const section = SectionPlanes.attach(engine, { planes: [cut], color: '#d2a675', hatch: 4 });
  section.enabled = false;
  const reflections = new SSR({ maxRoughness: 0.57, thickness: 0.12, maxDistance: 17, steps: 36 });
  const shots = [
    [5.5, [-7.7, 5.61, 11.66], [-6.2, 5.38, 10.13], [-1, 2.5, -7.8], [-0.58, 2.2, -9.6], 53],
    [14.0, [3.72, 2.8, 11.2], [3.72, 2.61, 6.43], [-0.36, 1.89, -9.1], [-0.87, 1.82, -10.3], 50],
    [22.4, [-3.7, 1.86, 2.1], [-3.7, 1.78, -1.3], [-1.28, 1.24, -4.1], [-0.67, 1.36, -7.1], 42],
    [32.4, [2.64, 2.58, -7.1], [0.95, 2.57, -7.82], [-0.9, 1.92, -10.5], [-1.0, 1.93, -10.52], 42],
    [40.9, [-7.65, 5.68, -5.23], [-7.6, 5.9, -1.93], [0.55, 2.96, 1.5], [0.15, 3.18, 6.8], 56],
    [51.8, [0.0, 3.6, 7.8], [0.72, 4.68, 1.82], [0.1, 7.82, -3.3], [-0.13, 8.13, -7.08], 59],
    [64.1, [25.8, 13.9, 19.5], [24.6, 12.35, 13.9], [-0.2, 4.47, -0.8], [-0.93, 4.73, -0.6], 60],
    [72.8, [20.2, 15.8, 1.0], [16.9, 13.5, -4.3], [-0.32, 8.64, -1.8], [-0.5, 8.88, -4.4], 54],
    [78.6, [7.94, 9.85, -12.21], [7.92, 9.87, -9.35], [7.73, 9.03, -6.88], [7.74, 9.01, -4.68], 56],
    [90, [2.27, 5.85, 10.81], [0.91, 5.47, 7.48], [-0.87, 2.34, -10.2], [-0.89, 2.27, -10.23], 52],
  ];
  const cues = [
    [0.24, 4.9, 'What makes a room sound like this?'],
    [6.6, 12.79, 'Inside Cedar Hall'],
    [16.16, 21.43, 'The stepped floor keeps the stage in view.'],
    [25.35, 31.49, 'A room for unamplified music'],
    [34.28, 40.19, 'The balcony soffit reflects sound toward the stalls.'],
    [43.57, 50.54, 'Suspended panels help distribute reflections.'],
    [53.83, 61.7, 'A building section reveals the structure.'],
    [65.07, 72.55, 'Supply ducts run above the acoustic ceiling.'],
    [73.38, 78.29, 'Catwalks give crews access to the services.'],
  ];
  function apply(time) {
    const sectionShot = time >= 51.8 && time < 78.6;
    section.enabled = sectionShot;
    cut[3] = mix(10.8, 5.1, ramp(time, 52.06, 58.28)) + 3.54 * ramp(time, 64.1, 67.5);
    surveyLight.intensity = sectionShot ? 975 : 0;
    cluster.setLights(lights);
    return shotAt(shots, time);
  }
  return {
    apply,
    cues,
    models: [piano],
    effects: [reflections],
    receivers: [reflections],
    dispose() {
      section.dispose();
      structure.dispose();
      piano.dispose();
      for (const texture of [plankColor, plankNormal, plankRough, timberGrain, fabricGrain, mineral]) texture.dispose();
    },
    inspection: { ifcSchema: ifc.schema, ifcProductCount: ifc.products.length },
  };
}
