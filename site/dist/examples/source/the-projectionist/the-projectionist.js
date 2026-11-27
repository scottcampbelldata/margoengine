import { Animation } from '@margoengine/animation';
import { FogVolumes } from '@margoengine/environment/fog-volumes';
import { VolumetricFog } from '@margoengine/environment/volumetric';
import { geometryData } from '@margoengine/geometry/utils';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { Material, Texture, UnlitMaterial } from '@margoengine/materials';
import { exampleAsset } from '../live/asset-base.js';
import { finishTexture, mix, ramp, shotAt } from './film.js';
import { surface, texturedGround } from './environment-films.js';

const input = exampleAsset('the-projectionist/projectionist.glb');
const motorStart = 49.7;
const lampStart = 54.3;
const countdownStart = 66;
const feed = [0.282, 2.12, 0.105];
const takeUp = [0.282, 0.9, 0.105];

function printLeader(canvas, time) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const running = time - countdownStart;
  const square = 34;
  ctx.fillStyle = '#161819';
  ctx.fillRect(0, 0, width, height);
  if (time < lampStart) return;
  if (running < 0) {
    ctx.fillStyle = '#b3aa95';
    ctx.fillRect(square, square, width - square * 2, height - square * 2);
    ctx.fillStyle = '#39362d';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '46px Georgia';
    ctx.fillText('35 MM LEADER', width / 2, height / 2);
    return;
  }
  if (running < 7.6) {
    const center = [width / 2, height / 2];
    ctx.fillStyle = '#d9cdad';
    ctx.fillRect(square, square, width - square * 2, height - square * 2);
    ctx.strokeStyle = '#565348';
    ctx.lineWidth = 4;
    for (const radius of [height * 0.3, height * 0.315]) {
      ctx.beginPath();
      ctx.arc(...center, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(center[0], square);
    ctx.lineTo(center[0], height - square);
    ctx.moveTo(square, center[1]);
    ctx.lineTo(width - square, center[1]);
    ctx.stroke();
    const sweep = ((running % 1) - 0.25) * Math.PI * 2;
    ctx.strokeStyle = '#806b58';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(...center);
    ctx.lineTo(center[0] + Math.cos(sweep) * height * 0.29, center[1] + Math.sin(sweep) * height * 0.29);
    ctx.stroke();
    ctx.fillStyle = '#242321';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 218px Georgia';
    ctx.fillText(String(Math.max(1, 8 - Math.floor(running))), ...center);
    return;
  }
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#1d2530');
  gradient.addColorStop(1, '#4b3936');
  ctx.fillStyle = gradient;
  ctx.fillRect(square, square, width - square * 2, height - square * 2);
  ctx.strokeStyle = '#c4ab7b';
  ctx.lineWidth = 3;
  ctx.strokeRect(67, 61, width - 134, height - 122);
  ctx.fillStyle = '#efe4c2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '68px Georgia';
  ctx.fillText('PICTURE START', width / 2, height / 2 - 9);
  ctx.font = '22px Georgia';
  ctx.fillText('35 MM  •  24 FRAMES PER SECOND', width / 2, height / 2 + 72);
}

function threadedFilm(shop, material) {
  const { group, box } = shop;
  const yz = [
    [1.98, 0.299],
    [1.9, 0.27],
    [1.82, 0.09],
    [1.75, 0.027],
    [1.7, 0.071],
    [1.62, 0.107],
    [1.52, 0.107],
    [1.441, 0.046],
    [1.38, 0.015],
    [1.331, 0.14],
    [1.16, 0.22],
    [1.12, 0.285],
  ];
  const sequence = [];
  for (let i = 0; i < yz.length - 1; i++) {
    const root = group(`Leader segment ${i + 1}`);
    const [a, b] = [yz[i], yz[i + 1]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const point = (t, x) => [
      x,
      ...a.map((p, axis) => {
        const start = yz[Math.max(0, i - 1)][axis],
          end = yz[Math.min(yz.length - 1, i + 2)][axis],
          q = b[axis];
        return (
          0.5 *
          (2 * p +
            (-start + q) * t +
            (2 * start - 5 * p + 4 * q - end) * t * t +
            (-start + 3 * p - 3 * q + end) * t * t * t)
        );
      }),
    ];
    const count = Math.round(length / 0.0072);
    const positions = [],
      normals = [],
      uvs = [],
      indices = [];
    for (const [left, right] of [
      [0.2615, 0.263],
      [0.2665, 0.2915],
      [0.295, 0.2965],
    ]) {
      let prior = -1;
      for (let step = 0; step <= 16; step++) {
        const current = positions.length / 3;
        const t = step / 16;
        positions.push(...point(t, left), ...point(t, right));
        const delta = point(Math.min(1, t + 0.004), 0).map((v, j) => v - point(Math.max(0, t - 0.004), 0)[j]);
        const n = Math.hypot(delta[1], delta[2]);
        normals.push(0, -delta[2] / n, delta[1] / n, 0, -delta[2] / n, delta[1] / n);
        uvs.push(0, t, 1, t);
        if (prior >= 0) indices.push(prior, current, prior + 1, prior + 1, current, current + 1);
        prior = current;
      }
    }
    shop.part(geometryData(positions, normals, uvs, indices), material, undefined, undefined, root);
    const orient = [Math.atan2(b[1] - a[1], b[0] - a[0]), 0, 0];
    for (let k = 0; k < count; k++)
      for (const x of [0.2658, 0.2922]) {
        box([0.0062, 0.0018, 0.0014], material, point((k + 0.5) / count, x), orient, root);
      }
    sequence.push(root);
  }
  return sequence;
}

export async function buildProjectionist(engine, shop, cluster) {
  const [actor, floor, plaster] = await Promise.all([
    loadGLTF(engine, input, { signal: AbortSignal.timeout(30_000) }),
    surface('concrete_floor_02', { color: '#707070', normalScale: 0.58 }),
    surface('concrete_floor_02', { color: '#655e57', normalScale: 0.3 }),
  ]);
  const performance = new Animation(actor);
  performance.play('Thread the projector');
  performance.loop = false;
  performance.playing = false;
  engine.use(performance);
  actor.root.setPosition([0.83, 0, 0.08]).setRotation([0, -Math.PI / 2, 0]);
  const { group, box, ring, beam, sign } = shop;
  const strip = finishTexture(391, { grain: 26, streak: true, mottling: 19 });
  const painted = new Material({ color: '#282c28', roughness: 0.61, roughnessMap: strip });
  const tread = new Material({ color: '#191b1f', roughness: 0.76, roughnessMap: strip });
  const machined = new Material({ color: '#a9a699', roughness: 0.34, metalness: 0.87, roughnessMap: strip });
  const chromed = new Material({ color: '#9b9b93', roughness: 0.28, metalness: 0.93 });
  const filmStock = new Material({
    color: '#805339',
    metalness: 0.02,
    roughness: 0.39,
    roughnessMap: strip,
    doubleSided: true,
  });
  const red = new Material({ color: '#713734', emissive: '#c55a36', emissiveIntensity: 0.35 });
  const lens = new Material({
    color: '#4a5360',
    roughness: 0.12,
    metalness: 0.42,
    emissive: '#f8ecce',
    emissiveIntensity: 0,
  });
  const stand = group('35 mm projector pedestal');
  box([0.69, 0.14, 0.73], painted, [0, 0.078, -0.06], undefined, stand, 0.036);
  box([0.38, 1.0, 0.49], painted, [0, 0.62, -0.078], undefined, stand, 0.08);
  box([0.63, 0.08, 0.61], machined, [0, 1.15, -0.032], undefined, stand, 0.036);
  box([0.44, 0.53, 0.52], painted, [0, 1.54, 0.067], undefined, stand, 0.06);
  box([0.212, 0.352, 0.245], tread, [-0.225, 1.64, 0.18], undefined, stand, 0.044);
  box([0.28, 0.39, 0.38], painted, [0, 1.64, 0.484], undefined, stand, 0.042);
  for (let i = 0; i < 8; i++) box([0.23, 0.008, 0.012], tread, [0, 1.535 + i * 0.025, 0.674], undefined, stand, 0.003);
  for (const [width, radius, z] of [
    [0.106, 0.106, -0.209],
    [0.128, 0.092, -0.314],
    [0.094, 0.097, -0.418],
    [0.034, 0.108, -0.477],
  ]) {
    ring([radius, radius, width], machined, [0, 1.58, z], [Math.PI / 2, 0, 0], stand, 60);
  }
  ring([0.081, 0.081, 0.014], lens, [0, 1.58, -0.5], [Math.PI / 2, 0, 0], stand, 62);
  for (const [y, z] of [
    [1.84, 0.074],
    [1.67, 0.105],
    [1.46, 0.061],
    [1.35, 0.153],
  ]) {
    ring([0.039, 0.039, 0.041], machined, [0.279, y, z], [0, 0, Math.PI / 2], stand, 42);
    ring([0.019, 0.019, 0.05], chromed, [0.282, y, z], [0, 0, Math.PI / 2], stand, 28);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      box(
        [0.037, 0.008, 0.006],
        chromed,
        [0.278, y + Math.sin(a) * 0.04, z + Math.cos(a) * 0.04],
        [a, 0, 0],
        stand,
        0.001,
      );
    }
  }
  const gate = group('Picture gate hinge', stand, [0.326, 1.584, 0.182]);
  box([0.024, 0.194, 0.101], machined, [-0.018, 0, -0.051], undefined, gate, 0.014);
  box([0.055, 0.066, 0.022], tread, [0.015, 0, -0.096], undefined, gate, 0.007);
  box([0.062, 0.059, 0.051], machined, [0.298, 1.245, -0.229], undefined, stand, 0.013);
  const toggle = group('Projector drive switch', stand, [0.329, 1.245, -0.229]);
  beam([0, 0, 0], [0.045, 0.025, 0], 0.01, chromed, toggle, true);
  box([0.022, 0.042, 0.041], red, [0.312, 1.206, -0.138], undefined, stand, 0.007);
  const wheels = [feed, takeUp].map((center, index) => {
    const reel = group(index ? 'Take-up reel' : 'Feed reel', stand, center);
    const radius = index ? 0.238 : 0.255;
    const torus = (x, r, w) => {
      for (let i = 0; i < 56; i++) {
        const s = (i * Math.PI) / 28,
          t = ((i + 1) * Math.PI) / 28;
        beam([x, r * Math.sin(s), r * Math.cos(s)], [x, r * Math.sin(t), r * Math.cos(t)], w, machined, reel, true);
      }
    };
    for (const side of [-1, 1]) {
      torus(side * 0.027, radius, 0.024);
      for (let j = 0; j < 5; j++) {
        const a = j * Math.PI * 0.4;
        beam(
          [side * 0.027, 0.032 * Math.sin(a), 0.032 * Math.cos(a)],
          [side * 0.027, radius * Math.sin(a + 0.12), radius * Math.cos(a + 0.12)],
          0.045,
          machined,
          reel,
        );
      }
    }
    ring([0.054, 0.054, 0.077], chromed, [0, 0, 0], [0, 0, Math.PI / 2], reel);
    return reel;
  });
  const rolls = [feed, takeUp].map((center, i) => {
    const root = group('Wound film', stand, center);
    ring([0.208, 0.208, 0.035], filmStock, [0, 0, 0], [0, 0, Math.PI / 2], root, 72);
    if (i) root.setScale([1, 0.26, 0.26]);
    return root;
  });
  const ribbon = threadedFilm(shop, filmStock);
  const booth = group('Projection booth');
  const base = texturedGround(
    engine,
    () => 0,
    floor.material,
    { origin: [-4, -3.1], size: [8, 7.2], resolution: 18 },
    1.6,
  );
  const house = texturedGround(
    engine,
    () => -2.55,
    floor.material,
    { origin: [-7, -20], size: [14, 21], resolution: 22 },
    2.3,
  );
  const boothWall = group('Projection port bulkhead', booth);
  for (const x of [-2.65, 2.65]) box([4.15, 3.6, 0.19], plaster.material, [x, 1.75, -2.85], undefined, boothWall, 0.03);
  box([1.22, 1.29, 0.19], plaster.material, [0, 0.64, -2.85], undefined, boothWall, 0.02);
  box([1.22, 1.42, 0.19], plaster.material, [0, 2.56, -2.85], undefined, boothWall, 0.02);
  for (const x of [-3.3, 3.65]) box([0.13, 3.4, 6.3], plaster.material, [x, 1.7, 0.55], undefined, booth, 0.025);
  box([7.4, 3.6, 0.18], plaster.material, [0, 1.8, 3.13], undefined, booth, 0.025);
  box([7.4, 0.18, 6.25], plaster.material, [0, 3.35, 0.18], undefined, booth, 0.032);
  const rack = group('Rewind bench', booth, [-1.7, 0, -0.8]);
  box([1.42, 0.072, 0.62], painted, [0, 0.96, 0], undefined, rack, 0.025);
  for (const x of [-0.59, 0.59])
    for (const z of [-0.23, 0.23]) box([0.063, 0.91, 0.062], machined, [x, 0.47, z], undefined, rack, 0.015);
  for (let i = 0; i < 4; i++)
    ring(
      [0.226, 0.226, 0.068],
      i % 2 ? machined : painted,
      [-0.2 + i * 0.04, 1.04 + i * 0.073, -0.04],
      undefined,
      rack,
      52,
    );
  sign(['PROJECTION', 'REWIND / INSPECTION'], [0.58, 0.2], [-1.91, 1.63, -2.742], undefined, booth, {
    background: '#3c3128',
    foreground: '#e7d1a5',
    lit: 0.13,
  });
  const lamp = new Material({ color: '#ded0a9', emissive: '#ffd6a2', emissiveIntensity: 2.2 });
  box([0.77, 0.042, 0.095], lamp, [-1.54, 2.23, -2.66], undefined, booth, 0.018);
  box([0.47, 0.069, 0.16], red, [1.7, 2.22, -2.69], undefined, booth, 0.012);
  const auditorium = group('Screen and auditorium');
  const velvet = new Material({ color: '#4d2224', roughness: 0.91 });
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 576;
  printLeader(canvas, 0);
  const picture = new Texture(canvas, { colorSpace: 'srgb' });
  box([9, 5.75, 0.18], tread, [0, 1.5, -17.21], undefined, auditorium, 0.035);
  box([14.4, 0.16, 16.8], tread, [0, 4.18, -11.62], undefined, auditorium, 0.04);
  box([14.4, 6.72, 0.2], velvet, [0, 0.78, -18.5], undefined, auditorium, 0.04);
  for (const x of [-7.02, 7.02]) {
    box([0.21, 6.72, 16.8], velvet, [x, 0.78, -11.62], undefined, auditorium, 0.04);
    for (const z of [-6, -9.4, -12.7, -16]) {
      box([0.21, 6.62, 0.27], tread, [x * 0.98, 0.78, z], undefined, auditorium, 0.022);
      box([0.026, 0.082, 0.22], lamp, [x * 0.966, -0.84, z], undefined, auditorium, 0.016);
    }
  }
  box([5.74, 3.29, 0.05], velvet, [0, 1.58, -17.09], undefined, auditorium, 0.047);
  box([5.58, 3.14, 0.027], new UnlitMaterial({ map: picture }), [0, 1.58, -17.04], undefined, auditorium, 0.009);
  for (let row = 0; row < 7; row++)
    for (let seat = -5; seat <= 5; seat++) {
      if (seat === 0) continue;
      const x = seat * 0.63,
        z = -6.2 - row * 1.22;
      box([0.47, 0.76, 0.16], velvet, [x, -2.13, z + 0.26], [0.16, 0, 0], auditorium, 0.078);
      box([0.46, 0.122, 0.49], velvet, [x, -2.18, z - 0.02], undefined, auditorium, 0.055);
    }
  const volumes = new FogVolumes([
    { shape: 'box', min: [-0.55, 1.1, -2.9], max: [0.55, 2.05, -0.56], density: 0.018, edge: 0.12 },
    { shape: 'box', min: [-3.1, -0.2, -17.03], max: [3.1, 3.52, -2.7], density: 0.014, edge: 0.36 },
  ]);
  const haze = VolumetricFog.attach(engine, {
    density: 0,
    range: 25,
    grid: [128, 72, 72],
    lights: cluster,
    volumes,
    anisotropy: 0.32,
    ambient: [0.005, 0.005, 0.005],
    temporal: 0.56,
  });
  const shots = [
    [5.4, [0.97, 2.11, -0.7], [0.94, 2.09, -0.61], [0.28, 1.95, 0.104], [0.28, 1.89, 0.098], 42],
    [17.5, [1.85, 1.65, 1.42], [1.61, 1.65, 1.27], [0.43, 1.5, 0.03], [0.39, 1.52, 0.04], 45],
    [33.8, [1.16, 1.91, -0.39], [1.08, 1.82, -0.35], [0.29, 1.73, 0.105], [0.3, 1.58, 0.091], 36],
    [45, [0.9, 1.44, 0.68], [0.88, 1.51, 0.61], [0.3, 1.6, 0.12], [0.3, 1.59, 0.11], 36],
    [54.4, [0.86, 1.29, -0.35], [0.85, 1.32, -0.32], [0.32, 1.26, -0.22], [0.323, 1.31, -0.17], 48],
    [65.7, [-1.67, 1.68, 1.87], [-1.19, 1.74, 1.06], [0, 1.57, -4.8], [0, 1.52, -6.6], 47],
    [78.9, [0.8, -0.15, -8.85], [0.34, -0.22, -10.05], [0, 1.1, -17.06], [0, 1.13, -17.06], 52],
    [90, [1.72, 1.75, 1.34], [1.9, 1.76, 1.49], [0.12, 1.56, -1.75], [0.05, 1.57, -1.92], 53],
  ];
  let lastPictureFrame = -1;
  return {
    apply(time) {
      performance.seek(time);
      gate.setRotation([0, mix(-0.97, 0, ramp(time, 38.6, 41.1)), 0]);
      toggle.setRotation([0, 0, mix(-0.55, 0.53, ramp(time, 49.3, 49.8))]);
      const speed = ramp(time, motorStart, motorStart + 3.2);
      const elapsed = Math.max(0, time - motorStart);
      const angle = 2.52 * elapsed * (0.53 + 0.47 * speed);
      wheels[0].setRotation([angle, 0, 0]);
      wheels[1].setRotation([-angle * 1.27, 0, 0]);
      const transferred = ramp(time, motorStart, 113);
      rolls[0].setScale([1, mix(1, 0.45, transferred), mix(1, 0.45, transferred)]);
      rolls[1].setScale([1, mix(0.26, 0.89, transferred), mix(0.26, 0.89, transferred)]);
      for (let i = 0; i < ribbon.length; i++) ribbon[i].visible = time >= 17.7 + i * 1.54;
      const light = ramp(time, lampStart, lampStart + 0.65);
      lens.emissiveIntensity = 2.13 * light;
      const pictureFrame = Math.floor(time * 24);
      if (pictureFrame !== lastPictureFrame) {
        printLeader(canvas, pictureFrame / 24);
        picture.update();
        lastPictureFrame = pictureFrame;
      }
      cluster.setLights([
        { position: [-1.39, 2.09, -2.55], color: [1, 0.7, 0.42], intensity: 19, range: 6.5 },
        { position: [1.34, 2.1, -1.06], color: [0.6, 0.73, 1], intensity: 9.5, range: 4.8 },
        { position: [1.58, 2.04, -2.52], color: [1, 0.29, 0.14], intensity: 4.1, range: 4 },
        {
          position: [0, 1.58, -0.55],
          direction: [0, 0, -1],
          color: [0.88, 0.93, 1],
          intensity: 410 * light,
          range: 19.4,
          outerAngle: 0.148,
          innerAngle: 0.106,
        },
      ]);
      return shotAt(shots, time);
    },
    cues: [
      [0.2, 5.1, 'A 35 mm screening starts here.'],
      [7, 15.4, 'The feed reel sits above the gate.'],
      [18.7, 31.4, 'The leader feeds through the upper sprocket and the gate.'],
      [41.22, 44.73, 'The gate holds the film flat in front of the lens.'],
      [49.78, 54.15, 'The motor starts. The take-up reel begins winding.'],
      [56.1, 64.5, 'The lamp sends the image through the projection port.'],
      [66.7, 72.7, 'The countdown fills the auditorium screen.'],
    ],
    models: [actor, base, house],
    dispose() {
      performance.dispose();
      actor.dispose();
      floor.dispose();
      plaster.dispose();
      strip.dispose();
      picture.dispose();
      haze.dispose();
      volumes.dispose();
    },
  };
}
