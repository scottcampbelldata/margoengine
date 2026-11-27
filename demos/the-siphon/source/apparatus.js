import { latheGeometry, sphereGeometry } from '@margoengine/geometry/primitives';
import { createMesh, MatcapMaterial, Material } from '@margoengine/materials';
import { batch, box, cyclorama, facePin, measurePath, move, pathPoint, pipe, quadrant, round, turned } from './geometry.js';
import { armLength, bore, fixedTube, gravity, maxDrop, pivot, receiver, spoutLength, supply } from './hydraulics.js';

import { createStudio } from './studio.js';

const outerPipe = .0102;
const datumZ = .047;
const vaseWall = .004;
const sourceRadius = .098;
const catchRadius = .149;
const radius = bore / 2;

function glassVessel(item, outer) {
  const { bottom, rim } = item;
  return turned([[outer - .011, bottom], [outer - .004, bottom + .0035], [outer, bottom + .010],
    [outer, rim - .007], [outer + .0013, rim - .002], [outer + .001, rim + .001],
    [outer - .001, rim + .002], [outer - vaseWall, rim], [outer - vaseWall, rim - .010],
    [outer - vaseWall, bottom + .015], [outer - .012, bottom + .009]], [item.x, 0, 0], 64);
}

function liquidBody(item, outer) {
  const edge = outer - vaseWall - .0008;
  return turned([[.0001, item.bottom + .009], [edge - .008, item.bottom + .009],
    [edge - .001, item.bottom + .016], [edge, item.level + .0016],
    [edge - .0016, item.level + .0004], [edge - .009, item.level],
    [.0001, item.level]], [item.x, 0, 0], 64);
}

function bead(item, outer) {
  return turned([[outer - .0033, item.rim + .0009], [outer - .0011, item.rim + .0023],
    [outer + .0016, item.rim + .0014], [outer + .002, item.rim - .0005],
    [outer + .001, item.rim - .0020]].reverse(), [item.x, 0, 0], 64);
}

function makeStand(add, mat) {
  add(cyclorama(), mat.background, 'Curved slate blue gallery sweep', 'floor');
  add(box(.835, .025, .421, .008, [.005, .004, 0]), mat.base, 'Enamel instrument plinth', 'shadow');
  add(box(.818, .006, .407, .0027, [.005, .020, 0]), mat.enamel, 'Inset face panel', 'shadow');
  add(box(.789, .0013, .362, .00055, [.004, .0236, 0]), mat.worktop, 'Matte stage top', 'shadow');
  const gold = [];
  const hardware = [];
  const isolation = [];
  for (const x of [-.369, .380]) {
    for (const z of [-.175, .175]) {
      hardware.push(round(.007, .0037, [x, .0245, z], 12));
      isolation.push(box(.006, .0009, .0015, .0003, [x, .0264, z], .17));
      isolation.push(round(.027, .012, [x * .91, -.0055, z * .93], 16));
    }
  }
  gold.push(box(.198, .0017, .035, .002, [-.249, .025, .171]));
  isolation.push(box(.171, .0006, .0014, .0003, [-.251, .0261, .169]));
  for (let i = 0; i < 16; i++) {
    const height = i % 5 === 0 ? .010 : i % 2 === 0 ? .0065 : .0046;
    isolation.push(box(.0012, .0008, height, .00028, [-.327 + i * .0105, .0265, .1705 + height / 2]));
  }
  for (const z of [-.067, .053]) {
    const x = supply.x + (z < 0 ? .054 : -.043);
    gold.push(turned([[.040, 0], [.040, .007], [.027, .011], [.019, .017], [.018, .057], [.025, .065]], [x, .024, z]));
    hardware.push(round(.022, .008, [x, .094, z], 32));
  }
  gold.push(turned([[.097, 0], [.105, .003], [.105, .008], [.102, .015],
    [.098, .016], [.096, .024], [.093, .025]], [supply.x, .090, 0]));
  isolation.push(round(.093, .006, [supply.x, .113, 0]));
  gold.push(turned([[.150, 0], [.154, .004], [.155, .010], [.152, .014],
    [.145, .015], [.141, .024], [.136, .025]], [receiver.x, .023, 0], 64));
  isolation.push(round(.140, .005, [receiver.x, .041, 0], 48));

  const standZ = -.072;
  gold.push(turned([[.057, 0], [.059, .007], [.053, .015], [.041, .018], [.034, .025],
    [.026, .036], [.024, .060], [.021, .063], [.020, .268], [.027, .287],
    [.034, .295], [.034, .309]], [pivot[0], .024, standZ]));
  hardware.push(round(.014, .170, [pivot[0], .199, standZ]));
  gold.push(box(.051, .028, .078, .007, [pivot[0], .339, -.037]));
  gold.push(facePin(.039, .026, [pivot[0], pivot[1], -.025], 40));
  hardware.push(facePin(.0283, .011, [pivot[0], pivot[1], -.0088], 40));
  gold.push(facePin(.0234, .019, [pivot[0], pivot[1], .009], 40));
  hardware.push(facePin(.013, .010, [pivot[0], pivot[1], .020], 8));
  const backScale = quadrant(.082, .166, Math.asin(maxDrop / armLength), -.030);
  const mounts = [move(backScale, pivot)];
  for (const angle of [-.16, -.64]) {
    const r = .059;
    mounts.push(box(.070, .016, .004, .0017,
      [pivot[0] + r * Math.cos(angle), pivot[1] + r * Math.sin(angle), -.034], angle));
    hardware.push(facePin(.0034, .0024,
      [pivot[0] + .088 * Math.cos(angle), pivot[1] + .088 * Math.sin(angle), -.029], 12));
  }
  add(batch(mounts), mat.scale, 'Outlet goniometer quadrant and mounting brackets', 'shadow');
  const ink = [];
  for (let cm = 0; cm <= 18; cm++) {
    const angle = Math.asin(cm * .01 / armLength);
    const length = cm % 5 === 0 || cm === 18 ? .020 : .011;
    const r = .158 - length / 2;
    ink.push(box(length, cm % 5 === 0 ? .0025 : .0014, .001, .00033,
      [pivot[0] + r * Math.cos(angle), pivot[1] - r * Math.sin(angle), -.0291], -angle));
  }
  add(batch(ink), mat.etched, 'Machined zero-to-eighteen centimeter scale', 'color');
  add(batch(gold), mat.brass, 'Turned brass pedestals, plaque and hinge', 'finish');
  add(batch(hardware), mat.steel, 'Shafts, set screws and pivot cap', 'finish');
  add(batch(isolation), mat.black, 'Recessed screw slots and pads', 'shadow');
}

function markings(add, mat) {
  const indicator = [];
  const near = sourceRadius - .00015;
  for (let index = 0; index <= 23; index++) {
    const level = supply.bottom + .032 + index * .01;
    const length = index % 5 === 0 ? .021 : index % 2 === 0 ? .014 : .010;
    const phi = .65;
    const segment = 10;
    const angles = Array.from({ length: segment + 1 }, (_, i) => phi - .13 + length / near * i / segment);
    const positions = [];
    const normals = [];
    const indices = [];
    for (const [i, a] of angles.entries()) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (const y of [-.00064, .00064]) {
        positions.push(supply.x + (near + .0008) * s, level + y, (near + .0008) * c);
        normals.push(s, 0, c);
      }
      if (i) {
        const base = (i - 1) * 2;
        indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }
    indicator.push({ positions, normals, indices, uvs: Array.from({ length: positions.length / 3 * 2 }, () => 0) });
  }
  add(batch(indicator), mat.etched, 'Graduated reservoir markings', 'color');
}

function jetGeometry(height, speed) {
  const which = (end) => {
    const drop = height * (1 - end);
    const current = Math.sqrt(speed ** 2 + 2 * gravity * drop);
    return [radius * Math.sqrt(speed / current), height * end];
  };
  return latheGeometry(Array.from({ length: 15 }, (_, i) => which(i / 14)), 22);
}

function hoop(radius, thickness, height) {
  return latheGeometry([[radius + thickness, height], [radius, height + thickness * .18],
    [radius - thickness, height]], 40);
}

function apexRings(add, mat, fixed) {
  const pipeBottom = fixed[0][1];
  const fit = [];
  fit.push(turned([[.0100, 0], [.0124, .002], [.0131, .005], [.0131, .012],
    [.0105, .014]], [supply.x, pipeBottom - .004, 0], 30));
  fit.push(turned([[.0104, 0], [.0141, .0026], [.0147, .006], [.0146, .024],
    [.0127, .026], [.0103, .028]], [pivot[0], pivot[1] + .026, 0], 36));
  const test = fixed[15];
  fit.push(move(turned([[.0101, 0], [.0108, .001], [.0136, .004], [.0136, .015],
    [.0128, .017], [.0103, .018]], [0, 0, 0], 30), [test[0] + .073, test[1], 0], Math.PI / 2));
  add(batch(fit), mat.steel, 'Priming, inlet and swivel collars', 'finish');
}

export function createApparatus(engine, shadows, initial) {
  const studio = createStudio();
  const material = {
    background: new Material({ color: '#e4e3de', roughness: .88 }),
    base: new Material({ color: '#324449', roughness: .47 }),
    enamel: new Material({ color: '#42626a', roughness: .36 }),
    worktop: new Material({ color: '#273a40', roughness: .85 }),
    brass: new MatcapMaterial({ color: '#ece4d5', matcap: studio.brass }),
    steel: new MatcapMaterial({ color: '#e6e4df', matcap: studio.nickel }),
    black: new Material({ color: '#262f31', roughness: .73 }),
    scale: new Material({ color: '#374b49', roughness: .52 }),
    etched: new Material({ color: '#d5c4a0', roughness: .66, emissive: '#957e5e', emissiveIntensity: .14 }),
    glass: new MatcapMaterial({ color: '#d7e6e6', matcap: studio.glass, transparent: true, opacity: .37, depthWrite: false }),
    rim: new MatcapMaterial({ color: '#d6e8e9', matcap: studio.glass, transparent: true, opacity: .62, depthWrite: false }),
    fluid: new MatcapMaterial({ color: '#abd2e0', matcap: studio.water }),
    dye: new MatcapMaterial({ color: '#90d4e0', matcap: studio.water }),
    pulse: new Material({ color: '#8fe8e7', roughness: .36, emissive: '#78d9e5', emissiveIntensity: .53 }),
    ripples: new Material({ color: '#73b4bb', roughness: .29, transparent: true, opacity: .31, depthWrite: false }),
    guide: new Material({ color: '#e2c084', roughness: .48, emissive: '#d7b176', emissiveIntensity: .38 }),
  };
  const meshes = [];
  const add = (geometry, appearance, name, role) => {
    const mesh = createMesh(engine, geometry, appearance);
    mesh.root.name = name;
    meshes.push(mesh);
    if (role === 'shadow' || role === 'finish') shadows.add(mesh, { static: true });
    if (role === 'floor') shadows.add(mesh, { static: true, castShadow: false });
    return mesh;
  };
  makeStand(add, material);
  const fixed = fixedTube();
  for (const [item, outer] of [[supply, sourceRadius], [receiver, catchRadius]]) {
    add(glassVessel(item, outer), material.glass, 'Borosilicate vessel shell', 'glass');
    add(liquidBody(item, outer), material.fluid, 'Dyed water and meniscus', 'finish');
    add(bead(item, outer), material.rim, 'Blown glass lip', 'glass');
  }
  markings(add, material);
  add(pipe(fixed, outerPipe, 24), material.glass, 'Borosilicate siphon crown', 'glass');
  add(pipe(fixed, radius, 18), material.dye, 'Primed water supply column', 'finish');
  apexRings(add, material, fixed);

  const localArm = [[0, 0, 0], [armLength, 0, 0]];
  const armGlass = add(pipe(localArm, outerPipe, 24), material.glass, 'Swinging glass outlet arm', 'glass');
  const armWater = add(pipe(localArm, radius, 20), material.dye, 'Primed water in the outlet arm', 'glass');
  const armClamp = add(batch([
    move(turned([[.008, 0], [.0134, .0008], [.0145, .006], [.0145, .026],
      [.0125, .029], [.008, .03]], [0, 0, 0], 28), [.011, 0, 0], -Math.PI / 2),
    move(turned([[.008, 0], [.0131, .0008], [.0146, .004], [.0146, .021],
      [.0121, .023], [.008, .024]], [0, 0, 0], 28), [armLength - .031, 0, 0], -Math.PI / 2),
    box(.035, .004, .005, .0013, [.176, 0, .0126]),
  ]), material.brass, 'Outlet clamp and scale index', 'glass');
  const nozzle = add(batch([
    turned([[.007, -spoutLength], [.011, -spoutLength], [.0125, -.028], [.0122, -.025],
      [.0105, -.023], [.0108, -.011], [.0165, -.008], [.0188, -.004], [.018, .003],
      [.0126, .008], [.0055, .009]], [0, 0, 0], 36),
    facePin(.011, .0018, [0, 0, .0180], 30),
  ]), material.brass, 'Self-leveling brass discharge nozzle', 'glass');
  const aperture = add(round(.0066, .001, [0, -.0318, 0]), material.dye, 'Water at nozzle mouth', 'color');
  const drop = add(jetGeometry(.12, .45), material.dye, 'Discharge stream contracts during free fall', 'glass');
  const rippleMeshes = Array.from({ length: 3 }, () => add(hoop(1, .026, 0), material.ripples, 'Impact wavelet', 'color'));
  const particles = Array.from({ length: 10 }, () => add(sphereGeometry(1, 9, 6), material.pulse, 'Moving dye streak', 'color'));
  const guideTop = add(batch([
    ...Array.from({ length: 21 }, (_, index) => round(.0014, .0012, [supply.x + .069 + index * .0196, supply.level, datumZ], 10)),
    box(.021, .0017, .002, .0005, [supply.x + .077, supply.level, datumZ]),
  ]), material.guide, 'Source waterline guide', 'color');
  const guideBelow = add(box(.023, .0017, .002, .0006, [0, 0, 0]), material.guide, 'Outlet height tick', 'color');
  const ruler = add(box(.0017, 1, .002, .0005, [0, -.50, 0]), material.guide, 'Vertical head above nozzle', 'color');

  let model;
  let path;
  let show = false;
  let travelled = 0;
  const hide = (asset) => asset.root.setPosition([0, -20, 0]);
  function setGuide() {
    const x = model.arm.outlet[0] + .022;
    guideTop.root.setPosition([0, show ? 0 : -20, 0]);
    guideBelow.root.setPosition([x, show ? model.arm.outlet[1] : -20, datumZ]);
    ruler.root.setPosition([x + .009, show && model.head > 0 ? supply.level : -20, datumZ]);
    ruler.root.setScale([1, Math.max(.00001, model.head), 1]);
  }

  function setModel(next) {
    model = next;
    for (const mesh of [armGlass, armWater, armClamp]) {
      mesh.root.setPosition(pivot);
      mesh.root.setRotation([0, 0, -model.arm.angle]);
    }
    nozzle.root.setPosition(model.arm.upper);
    aperture.root.setPosition(model.arm.upper);
    if (model.speed > 0) {
      drop.setGeometry(jetGeometry(model.arm.outlet[1] - receiver.level, model.speed));
      drop.root.setPosition([model.arm.outlet[0], receiver.level, 0]);
    } else hide(drop);
    path = measurePath([...fixed, model.arm.upper, model.arm.outlet]);
    setGuide();
  }

  function animate(seconds, reduced) {
    if (model.speed === 0) {
      for (const object of [...rippleMeshes, ...particles]) hide(object);
      return;
    }
    if (!reduced) travelled += model.speed * seconds;
    const distance = path.at(-1).total;
    for (const [i, marker] of particles.entries()) {
      const along = (travelled + distance * (i + .35) / particles.length) % distance;
      const a = pathPoint(path, along);
      const b = pathPoint(path, Math.min(distance - 1e-7, along + .0033));
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      marker.root.setRotation([0, 0, angle]);
      marker.root.setScale([.0074, .00142, .00170]);
      if ((a[1] < supply.level && a[0] < -.225) || along < .036 || along > distance - .038) hide(marker);
      else marker.root.setPosition([a[0], a[1], radius * .93]);
    }
    for (const [i, ripple] of rippleMeshes.entries()) {
      const phase = (travelled * 3.1 + i / rippleMeshes.length) % 1;
      const r = .007 + phase * (.039 + .011 * model.speed);
      ripple.root.setScale([r, r, r]);
      ripple.root.setPosition([model.arm.outlet[0], receiver.level + .0019 + i * .00012, 0]);
    }
  }

  setModel(initial);
  animate(0, true);
  return {
    setModel, animate,
    guide(visible) { show = visible; setGuide(); },
    dispose() {
      for (const mesh of meshes.reverse()) mesh.dispose();
      for (const appearance of Object.values(material).reverse()) appearance.dispose();
      for (const texture of Object.values(studio)) texture.dispose();
    },
  };
}