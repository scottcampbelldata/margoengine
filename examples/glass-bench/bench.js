import {
  CatmullRomCurve3,
  circleGeometry,
  cylinderGeometry,
  latheGeometry,
  planeGeometry,
  tubeGeometry,
} from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, Texture, createInstancedMesh, createMesh } from '@margoengine/materials';
import { lensCenter, reticleHeight } from './timeline.js';

const turn = Math.PI * 2;
const down = [-Math.PI / 2, 0, 0];
const alongZ = [Math.PI / 2, 0, 0];
const identityRotation = [0, 0, 0];
export const ior = 1.5168;
export const dispersion = 20 / 64.17;
const lensRadius = 0.025;
const curvature = 0.10163;
const centerThickness = 0.01;

export function opticalElement() {
  const profile = [];
  // Sample the two spherical faces from their vertices to the protective edge bevels.
  const halfThickness = (r) => centerThickness / 2 - (curvature - Math.sqrt(curvature * curvature - r * r));
  const clear = lensRadius - 0.00032;
  for (let i = 0; i <= 32; i++) {
    const r = (clear * i) / 32;
    profile.push([r, -halfThickness(r)]);
  }
  const edgeHeight = halfThickness(lensRadius) - 0.00027;
  profile.push([lensRadius, -edgeHeight], [lensRadius, edgeHeight]);
  for (let i = 32; i >= 0; i--) {
    const r = (clear * i) / 32;
    profile.push([r, halfThickness(r)]);
  }
  return latheGeometry(profile, 128);
}

function band(inner, outer, depth, bevel = 0.00045) {
  const y = depth * 0.5;
  return latheGeometry(
    [
      [inner + bevel, -y],
      [outer - bevel, -y],
      [outer, -y + bevel],
      [outer, y - bevel],
      [outer - bevel, y],
      [inner + bevel, y],
      [inner, y - bevel],
      [inner, -y + bevel],
      [inner + bevel, -y],
    ],
    outer > 0.02 ? 224 : 32,
  );
}

const generatedTexture = (width, height, paint) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  return new Texture(canvas, { colorSpace: 'srgb', anisotropy: 8 });
};

function reticleMap() {
  return generatedTexture(1024, 1024, (c, w, h) => {
    c.fillStyle = '#c6c1af';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#4a4c47';
    c.lineWidth = 2.7;
    c.beginPath();
    for (let p = 144; p < w - 100; p += 32) {
      c.moveTo(p, 145);
      c.lineTo(p, 860);
      c.moveTo(144, p);
      c.lineTo(880, p);
    }
    c.stroke();
    c.strokeStyle = '#343635';
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(122, 512);
    c.lineTo(898, 512);
    c.moveTo(512, 134);
    c.lineTo(512, 880);
    for (const radius of [75, 132, 225]) {
      c.moveTo(512 + radius, 512);
      c.arc(512, 512, radius, 0, turn);
    }
    c.stroke();
    c.fillStyle = '#764527';
    c.beginPath();
    c.arc(512, 512, 13, 0, turn);
    c.fill();
    c.fillStyle = '#373a38';
    c.font = '600 35px Consolas, monospace';
    c.fillText('GB01   /   TARGET', 92, 98);
    c.font = '25px Consolas, monospace';
    c.fillText('0     2     4     6     8', 140, 930);
    c.textAlign = 'right';
    c.fillText('2 mm GRID', 930, 95);
  });
}

function nameplateMap() {
  return generatedTexture(768, 256, (c, w, h) => {
    c.fillStyle = '#484744';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#9e9384';
    c.lineWidth = 4;
    c.strokeRect(16, 16, w - 32, h - 32);
    c.fillStyle = '#e0d4ba';
    c.font = '600 70px "Segoe UI", sans-serif';
    c.fillText('GLASS BENCH', 44, 104);
    c.font = '43px Consolas, monospace';
    c.fillText('GB–01     Ø50 / 100', 46, 180);
  });
}

function instrumentMap() {
  return generatedTexture(768, 256, (c, w, h) => {
    c.fillStyle = '#293130';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#687b70';
    c.strokeRect(19, 19, w - 38, h - 38);
    c.fillStyle = '#aebcb1';
    c.font = '29px Consolas, monospace';
    c.fillText('REFERENCE  /  FOCUS STAGE', 38, 64);
    c.font = '72px Consolas, monospace';
    c.fillText('100.00', 38, 167);
    c.font = '36px Consolas, monospace';
    c.fillText('mm', 308, 166);
    c.font = '23px Consolas, monospace';
    c.fillStyle = '#809487';
    c.fillText('GB-01     /     D-LINE', 41, 223);
  });
}

function finishMap(seed) {
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < height; y++) {
    const grain = 212 + 40 * random();
    for (let x = 0; x < width; x++) {
      const n = (y * width + x) * 4;
      const variation = grain + 8 * random() * Math.cos((x / width) * turn + y * 0.23);
      data.set([255, variation, 255, 255], n);
    }
  }
  return new Texture({ width, height, data }, { colorSpace: 'linear', anisotropy: 8 });
}

function placeInstances(engine, geometry, material, points, parent) {
  const model = createInstancedMesh(engine, geometry, material, points.length);
  if (parent) model.root.setParent(parent);
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  points.forEach(({ position, angle = 0 }, i) => {
    m[0] = Math.cos(angle);
    m[2] = -Math.sin(angle);
    m[8] = -m[2];
    m[10] = m[0];
    m.set(position, 12);
    model.instances.setMatrixAt(i, m);
  });
  return model;
}

export function buildBench(engine) {
  const models = [];
  const casters = [];
  const texture = reticleMap();
  const plateTexture = nameplateMap();
  const displayTexture = instrumentMap();
  const brush = finishMap(455);
  const latheFinish = finishMap(289);
  const textures = [texture, plateTexture, displayTexture, brush, latheFinish];
  const m = {
    cloth: new Material({ color: '#25292c', roughness: 0.86 }),
    wall: new Material({ color: '#36393b', roughness: 0.92 }),
    breadboard: new Material({ color: '#464d51', roughness: 0.47, roughnessMap: brush, anisotropy: 0.36 }),
    gunmetal: new Material({ color: '#445055', roughness: 0.33, metalness: 0.67, anisotropy: 0.38 }),
    edge: new Material({ color: '#6b7377', roughness: 0.38, metalness: 0.64 }),
    aluminum: new Material({
      color: '#bfc4c0',
      roughness: 0.34,
      roughnessMap: brush,
      metalness: 0.87,
      anisotropy: 0.37,
    }),
    brass: new Material({ color: '#c5a470', roughness: 0.33, roughnessMap: latheFinish, metalness: 0.87 }),
    copper: new Material({ color: '#9d653c', roughness: 0.39, metalness: 0.84 }),
    rubber: new Material({ color: '#2c3033', roughness: 0.75 }),
    socket: new Material({ color: '#232527', roughness: 0.9 }),
    mark: new Material({ color: '#c9beab', roughness: 0.55 }),
    target: new Material({ color: '#ffffff', map: texture, roughness: 0.63 }),
    name: new Material({ color: '#ffffff', map: plateTexture, roughness: 0.5 }),
    display: new Material({
      color: '#bec6b9',
      map: displayTexture,
      emissiveMap: displayTexture,
      emissive: '#d1f1d9',
      emissiveIntensity: 0.67,
      roughness: 0.63,
    }),
    glass: new Material({
      color: '#f7f9f9',
      roughness: 0.052,
      transmission: 1,
      thickness: centerThickness,
      ior,
      dispersion,
      attenuationColor: '#ebf4fa',
      attenuationDistance: 0.23,
    }),
    diffuser: new Material({ color: '#dcccb3', emissive: '#ffe4c0', emissiveIntensity: 1.8, roughness: 0.46 }),
    pearl: new Material({ color: '#8c9a9f', roughness: 0.51, metalness: 0.46 }),
  };

  const add = (name, geometry, material, position, { rotation = identityRotation, parent, shadow = true } = {}) => {
    const model = createMesh(engine, geometry, material);
    if (parent) model.root.setParent(parent);
    model.root.setPosition(position).setRotation(rotation);
    model.root.name = name;
    models.push(model);
    if (shadow) casters.push(model);
    return model;
  };
  const box = (name, size, material, position, opts = {}) => {
    const radius = Math.min(...size) * 0.13;
    return add(name, roundedBoxGeometry(...size, 3, radius), material, position, opts);
  };
  const rod = (name, radius, length, material, position, opts) =>
    add(name, cylinderGeometry(radius, radius, length, 64), material, position, opts);

  box('Graphite worktop', [1.22, 0.029, 0.82], m.cloth, [0, -0.035, -0.052], { shadow: false });
  box('Anodized breadboard', [0.59, 0.02, 0.39], m.breadboard, [0, -0.01, -0.016], { shadow: false });
  box('Rear lab wall', [1.4, 0.6, 0.02], m.wall, [0.06, 0.24, -0.47], { shadow: false });
  box('Rear cable raceway', [0.9, 0.011, 0.02], m.rubber, [-0.05, 0.023, -0.447], { shadow: false });
  box('Rack left side panel', [0.016, 0.46, 0.47], m.wall, [-0.6, 0.215, -0.16], { shadow: false });
  for (const x of [-0.28, -0.22, -0.16, -0.1, -0.04, 0.02, 0.08, 0.14, 0.2]) {
    box('Rear instrument baffle', [0.022, 0.22, 0.011], m.wall, [x, 0.123, -0.447], { shadow: false });
  }

  const holes = [];
  for (let ix = -11; ix <= 11; ix++) {
    for (let iz = -7; iz <= 6; iz++) {
      holes.push({ position: [ix * 0.025, 0.00015, iz * 0.025 - 0.016] });
    }
  }
  const socketBase = circleGeometry(0.00265, 24);
  const socket = placeInstances(
    engine,
    socketBase,
    m.socket,
    holes.map(({ position }) => ({
      position: [position[0], -position[2], position[1]],
    })),
  );
  socket.root.setRotation(down);
  models.push(socket);
  models.push(placeInstances(engine, band(0.00249, 0.00323, 0.00026, 0.0001), m.edge, holes));

  const ring = engine.createMesh();
  ring.name = 'Graduated rotary carrier axis';
  ring.setPosition(lensCenter);
  add('Anodized rotary carrier', band(0.0248, 0.037, 0.008), m.gunmetal, [0, 0, 0], { parent: ring });
  add('Turned brass retaining ring', band(0.02457, 0.0325, 0.0026, 0.00032), m.brass, [0, 0.0046, 0], { parent: ring });
  add('Lower retaining shoulder', band(0.02475, 0.031, 0.002, 0.00025), m.copper, [0, -0.0037, 0], { parent: ring });
  const tickGeometry = roundedBoxGeometry(0.00038, 0.00017, 0.00224, 2, 0.00004);
  const marks = Array.from({ length: 72 }, (_, i) => {
    const angle = (i * turn) / 72;
    return { position: [0.0343 * Math.sin(angle), 0.00411, 0.0343 * Math.cos(angle)], angle };
  });
  models.push(placeInstances(engine, tickGeometry, m.mark, marks, ring));
  const longMarks = marks
    .filter((_, i) => i % 6 === 0)
    .map(({ position, angle }) => ({
      position: [position[0] * 0.964, position[1], position[2] * 0.964],
      angle,
    }));
  models.push(
    placeInstances(engine, roundedBoxGeometry(0.00057, 0.00016, 0.0013, 2, 0.00003), m.mark, longMarks, ring),
  );
  const carrierGrip = Array.from({ length: 144 }, (_, i) => {
    const angle = (i * turn) / 144;
    return { position: [0.03713 * Math.sin(angle), -0.00075, 0.03713 * Math.cos(angle)], angle };
  });
  models.push(
    placeInstances(engine, roundedBoxGeometry(0.00061, 0.005, 0.00051, 2, 0.00015), m.gunmetal, carrierGrip, ring),
  );

  const lens = opticalElement();
  add('N-BK7 double-convex optical element', lens, m.glass, lensCenter, { shadow: false });
  const photonGeometry = {
    positions: Float32Array.from(lens.positions, (value, i) => value + lensCenter[i % 3]),
    normals: lens.normals,
    indices: new Uint32Array(lens.indices),
  };

  for (const x of [-0.046, 0.046]) {
    box('Dovetail saddle foot', [0.029, 0.007, 0.106], m.gunmetal, [x, 0.0036, -0.012]);
    rod('Ground steel carrier pillar', 0.0067, 0.095, m.aluminum, [x, 0.052, -0.012]);
    box('Cantilever clamp', [0.03, 0.015, 0.031], m.gunmetal, [x, 0.1, -0.011]);
    rod('Lock nut', 0.0087, 0.005, m.brass, [x, 0.11, -0.011]);
    rod('Rail', 0.00325, 0.157, m.aluminum, [x * 0.68, 0.0074, -0.007], { rotation: alongZ });
    for (const z of [-0.069, 0.028]) {
      rod('Saddle cap screw', 0.0037, 0.0025, m.edge, [x, 0.008, z]);
      add('Hex socket', cylinderGeometry(0.00165, 0.00165, 0.00025, 6), m.socket, [x, 0.0094, z], { shadow: false });
    }
  }

  const slide = engine.createMesh();
  slide.name = 'Reticle carriage';
  box('Carriage', [0.071, 0.004, 0.081], m.gunmetal, [0, 0.0022, 0], { parent: slide });
  add('Ceramic reticle with etched scale', planeGeometry(0.064, 0.064), m.target, [0, reticleHeight, 0], {
    rotation: down,
    parent: slide,
    shadow: false,
  });
  const dial = engine.createMesh();
  dial.name = 'Micrometer drive';
  dial.setPosition([0.05, 0.017, 0.077]);
  rod('Micrometer sleeve', 0.008, 0.042, m.pearl, [0.05, 0.017, 0.047], { rotation: alongZ });
  rod('Micrometer brass knob', 0.014, 0.019, m.brass, [0, 0, 0], { rotation: alongZ, parent: dial });
  const grooves = Array.from({ length: 40 }, (_, i) => {
    const angle = (i * turn) / 40;
    return { position: [0.01415 * Math.sin(angle), 0, 0.01415 * Math.cos(angle)], angle };
  });
  const knurl = placeInstances(engine, roundedBoxGeometry(0.00082, 0.0172, 0.00081, 2, 0.0002), m.brass, grooves);
  knurl.root.setParent(dial).setRotation(alongZ);
  models.push(knurl);
  rod('Dial indicator centre', 0.0072, 0.0013, m.gunmetal, [0, 0, 0.01], { rotation: alongZ, parent: dial });
  box('Dial position mark', [0.0008, 0.004, 0.0004], m.mark, [0, 0.0083, 0.01], { parent: dial });

  add('Identification plate', planeGeometry(0.068, 0.023), m.name, [-0.051, 0.001, 0.097], {
    rotation: down,
    shadow: false,
  });
  const spare = [-0.133, 0.009, -0.046];
  rod('Spare optic storage cap', 0.031, 0.016, m.gunmetal, spare);
  add('Spare cap brass rim', band(0.0273, 0.0314, 0.0022), m.brass, [-0.133, 0.017, -0.046]);
  rod('Spare cap end panel', 0.0263, 0.0008, m.rubber, [-0.133, 0.017, -0.046]);
  box('Instrument rail cabinet', [0.15, 0.062, 0.073], m.gunmetal, [-0.12, 0.031, -0.144]);
  box('Cabinet face plate', [0.133, 0.047, 0.002], m.edge, [-0.12, 0.031, -0.1062]);
  box('Display recessed gasket', [0.056, 0.024, 0.0024], m.rubber, [-0.087, 0.036, -0.104]);
  add('Stage readout and reference focal length', planeGeometry(0.052, 0.0173), m.display, [-0.087, 0.036, -0.1027], {
    shadow: false,
  });
  for (const x of [-0.162, -0.139, -0.116]) {
    rod('Cabinet trim knob', 0.0061, 0.008, m.rubber, [x, 0.022, -0.101], { rotation: alongZ });
    box('Cabinet trim marker', [0.001, 0.0028, 0.0004], m.mark, [x, 0.026, -0.0969], { shadow: false });
  }
  for (let i = 0; i < 11; i++) {
    box('Driver air slot', [0.0009, 0.00028, 0.033], m.socket, [-0.169 + i * 0.0085, 0.0622, -0.149], {
      shadow: false,
    });
  }

  const ledHead = [-0.076, 0.193, -0.108];
  rod('Collimator support post', 0.0065, 0.193, m.aluminum, [-0.106, 0.1, -0.128]);
  box('Collimator support foot', [0.045, 0.009, 0.039], m.gunmetal, [-0.106, 0.005, -0.128]);
  box('Inspection light body', [0.079, 0.017, 0.033], m.gunmetal, ledHead);
  box('Recessed LED diffuser', [0.071, 0.0021, 0.024], m.diffuser, [-0.076, 0.1836, -0.103]);
  const lead = new CatmullRomCurve3([
    [-0.111, 0.194, -0.121],
    [-0.142, 0.158, -0.145],
    [-0.144, 0.072, -0.174],
    [-0.179, 0.006, -0.187],
  ]);
  add('Collimator power lead', tubeGeometry(lead, 38, 0.0016, 11), m.rubber, [0, 0, 0]);

  return { models, casters, textures, photonGeometry, ring, slide, dial, diffuser: m.diffuser };
}
