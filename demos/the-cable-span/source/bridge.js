import { createMesh, Material } from '@margoengine/materials';
import { cylinderGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4 } from '@margoengine/geometry/utils';
import { batch, box, mix, pin, placed, randomFrom, rgb, Surface } from './craft.js';
import { equilibrium, referenceSag, saddleHeight, span } from './equilibrium.js';
import { buildGorge } from './gorge.js';

const cableZ = 1.26;
const deckEdge = 1.12;
const bolt = rgb('#a7b1ae');
const rail = rgb('#586869');
const steel = rgb('#7e8a8d');
const line = rgb('#e7bd77');
const hanger = rgb('#acb7ab');
const planking = [rgb('#a9815d'), rgb('#b6906b'), rgb('#987459'), rgb('#bb9972')];
const planks = 64;
const datum = .025;
const worldX = (x) => x - span / 2;

function deckGeometry(model) {
  const deck = new Surface();
  const details = new Surface();
  const step = span / planks;
  const random = randomFrom(200517);
  const slat = box([step - .025, .12, deckEdge * 2], [0, 0, 0], .013);
  const boltHead = pin(.026, .012, [0, 0, 0]);
  for (let index = 0; index < planks; index++) {
    const x = (index + .5) * step;
    const world = worldX(x);
    const y = model.deck(x);
    const slope = (model.deck(x + step * .5) - model.deck(x - step * .5)) / step;
    deck.rigid(placed(slat, [world, y - .06, 0], Math.atan(slope)), planking[Math.floor(4 * random())]);
    if (index % 2 === 0) {
      for (const z of [-.93, .93]) {
        deck.rigid(placed(boltHead, [world, y + .004, z]), bolt);
      }
    }
  }
  const sample = [...Array.from({ length: 65 }, (_, index) => span * index / 64), model.loadAt]
    .sort((a, b) => a - b).filter((x, index, ordered) => index === 0 || x - ordered[index - 1] > 1e-6);
  for (const side of [-1, 1]) {
    const z = side * cableZ;
    const path = (height, offset) => sample.map(x => [worldX(x), model.deck(x) + height, side * offset]);
    details.tube(sample.map(x => [worldX(x), saddleHeight - model.sag(x), z]), .071, line, 10);
    details.tube(path(-.16, 1.05), .078, steel, 8);
    details.tube(path(.85, 1.04), .039, rail, 8);
    details.tube(path(.60, 1.045), .019, hanger, 6);
    details.tube(path(.35, 1.045), .019, hanger, 6);
    for (let index = 1; index < 24; index++) {
      const x = index;
      const world = worldX(x);
      const y = model.deck(x);
      const top = saddleHeight - model.sag(x);
      details.tube([[world, y - .16, z], [world, top, z]], .023, hanger, 6);
      details.tube([[world, top - .085, z], [world, top + .064, z]], .092, bolt, 6);
      details.tube([[world, y - .19, side * 1.08], [world, y + .87, side * 1.04]], .027, rail, 6);
      details.tube([[world, y - .16, side * .99], [world, y - .16, z]], .049, bolt, 6);
      if (index % 2 === 0 && side === 1) {
        details.tube([[world, y - .16, -1.08], [world, y - .16, 1.08]], .056, rail, 6);
      }
    }
  }
  return { deck: deck.geometry, details: details.geometry };
}

function buildTowerHardware(add, materials) {
  const surfaces = new Map();
  const store = (material, geometry) => {
    if (!surfaces.has(material)) surfaces.set(material, []);
    surfaces.get(material).push(geometry);
  };
  const painted = new Surface();
  const anchors = new Surface();
  const alloy = rgb('#bd694c');
  const weld = rgb('#703e39');
  const safety = rgb('#d4b068');
  for (const side of [-1, 1]) {
    const x = side * span / 2;
    const landing = side * 15.29;
    store(materials.roughMetal, box([6.58, .25, 2.32], [landing, -.16, 0], .055));
    store(materials.rock, box([6.82, .47, 2.62], [landing, -.42, 0], .075));
    for (let slat = 0; slat < 17; slat++) {
      const spacing = 6.56 / 17;
      const center = side * (12.02 + (slat + .5) * spacing);
      painted.rigid(box([spacing - .028, .087, 2.23], [center, -.049, 0], .012), planking[slat % 4]);
    }
    for (const edge of [-1, 1]) {
      const z = edge * cableZ;
      const foot = [x, -.16, z];
      const top = [x, saddleHeight + .03, z];
      store(materials.rock, box([1.20, .60, 1.01], [x, -.36, z], .083));
      store(materials.roughMetal, box([.91, .13, .79], [x, -.043, z], .035));
      painted.rigid(box([.53, saddleHeight + .03, .43], [x, saddleHeight / 2, z], .032), alloy);
      painted.rigid(box([.72, .18, .59], [x, .23, z], .036), weld);
      painted.rigid(box([.74, .20, .63], [x, saddleHeight - .19, z], .036), alloy);
      painted.rigid(box([.74, .12, .64], [x, saddleHeight - .10, z], .022), weld);
      painted.rigid(box([.52, .09, .31], [x, saddleHeight - .04, z], .021), safety);
      for (const left of [-1, 1]) {
        store(materials.roughMetal, pin(.05, .075, [x + left * .36, .04, z + edge * .24]));
        store(materials.roughMetal, pin(.05, .075, [x + left * .36, .04, z - edge * .24]));
      }
      const anchorX = side * 18.90;
      store(materials.rock, box([1.67, .66, 1.18], [anchorX, -.28, edge * 1.54], .11));
      store(materials.roughMetal, box([.48, .29, .54], [anchorX, .14, edge * 1.54], .052));
      const anchor = [anchorX, .24, edge * 1.54];
      anchors.tube([[top[0], saddleHeight, z], [x + side * .24, saddleHeight - .06, z],
        [x + side * .67, saddleHeight - .25, z + edge * .02], anchor], .069, line, 10);
      anchors.tube([mix(anchor, [x, saddleHeight, z], .012), mix(anchor, [x, saddleHeight, z], .088)], .102, bolt, 8);
      anchors.tube([[foot[0] + side * .40, .13, z], [foot[0] + side * 2.70, .13, z]],
        .030, steel, 6);
      anchors.tube([[foot[0] + side * .40, .82, z], [foot[0] + side * 2.70, .82, z]],
        .036, steel, 8);
      anchors.tube([[foot[0] + side * 2.70, .10, z], [foot[0] + side * 2.70, .82, z]],
        .042, steel, 8);
    }
    for (const level of [3.70, 4.18]) {
      painted.rigid(box([.36, .17, 2.55], [x, level, 0], .028), alloy);
    }
    for (const slope of [-1, 1]) {
      painted.tube([[x, 3.17, slope * 1.18], [x, 3.77, slope * .51]], .075, alloy, 8);
      painted.tube([[x, 3.72, slope * 1.16], [x, 4.17, 0]], .070, weld, 8);
    }
    painted.rigid(box([.10, .38, .55], [x + side * .22, 3.92, 0], .020), weld);
    painted.rigid(box([.11, .06, .33], [x + side * .23, 3.95, 0], .012), safety);
  }
  for (const [material, pieces] of surfaces) {
    add(batch(pieces), material, 'Approach castings and hardware', { static: true });
  }
  add(painted.geometry, materials.paint, 'Vermilion steel saddle portals', { static: true });
  add(anchors.geometry, materials.cables, 'Backstay and anchorage fittings', { static: true });
}

function buildCart(add, materials) {
  const platform = box([1.34, .19, 1.51], [0, .28, 0], .057);
  const bed = box([1.33, .052, 1.49], [0, .40, 0], .032);
  const load = [];
  const paint = [];
  const alloy = [];
  const rubber = [];
  for (const x of [-.39, .39]) {
    const wheel = cylinderGeometry(.148, .148, .112, 16, 1);
    const hub = cylinderGeometry(.064, .064, .119, 12, 1);
    for (const z of [-.60, .60]) {
      const upright = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, .148, z, 1];
      rubber.push(applyMatrix4(wheel, upright));
      alloy.push(applyMatrix4(hub, upright));
    }
  }
  for (const offset of [-.31, .31]) {
    load.push(box([.50, .22, 1.18], [offset, .523, 0], .048));
    load.push(box([.50, .20, 1.18], [offset, .734, 0], .048));
    paint.push(box([.42, .038, .86], [offset, .848, 0], .018));
    for (const z of [-.47, .47]) alloy.push(pin(.045, .024, [offset, .87, z]));
  }
  for (const z of [-.70, .70]) {
    alloy.push(box([1.31, .038, .035], [0, .409, z], .014));
    for (const x of [-.51, 0, .51]) alloy.push(pin(.030, .022, [x, .418, z]));
  }
  const caution = new Surface();
  for (const edge of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      caution.rigid(box([.12, .038, .059], [-.27 + i * .18, .419, edge * .657], .01, .18), rgb('#dbad62'));
    }
  }
  const objects = [
    add(platform, materials.matte, 'Proof cart frame', {}),
    add(bed, materials.roughMetal, 'Cart deck', {}),
    add(batch(load), materials.ballast, 'Calibrated iron ballast weights', {}),
    add(batch(paint), materials.tag, 'Ballast safety grips', {}),
    add(batch(alloy), materials.roughMetal, 'Fasteners and hubs', {}),
    add(batch(rubber), materials.rubber, 'Cart tires', {}),
    add(caution.geometry, materials.paint, 'Cart safety markings'),
  ];
  return (model) => {
    const position = model.loadAt;
    const back = model.deck(Math.max(0, position - .39));
    const front = model.deck(Math.min(span, position + .39));
    const slope = (front - back) / .78;
    for (const { root } of objects) {
      root.setPosition([worldX(position), (back + front) / 2 + datum, 0]);
      root.setRotation([0, 0, Math.atan(slope)]);
    }
  };
}

export function createSpan(engine, shadows, position) {
  const owned = [];
  const materials = {
    rock: new Material({ color: '#ffffff', roughness: .91 }),
    paint: new Material({ color: '#ffffff', roughness: .59 }),
    cables: new Material({ color: '#ffffff', roughness: .44, metalness: .22 }),
    timber: new Material({ color: '#ffffff', roughness: .81 }),
    rubber: new Material({ color: '#2b3032', roughness: .83 }),
    matte: new Material({ color: '#303a41', roughness: .58 }),
    ballast: new Material({ color: '#356e78', roughness: .50 }),
    tag: new Material({ color: '#e4a266', roughness: .54 }),
    roughMetal: new Material({ color: '#81918f', roughness: .52, metalness: .47 }),
    brass: new Material({ color: '#927e62', roughness: .48, metalness: .37 }),
    floor: new Material({ color: '#ffffff', roughness: .87 }),
    water: new Material({ color: '#ffffff', roughness: .27, metalness: .08 }),
    ripple: new Material({ color: '#ffffff', roughness: .45 }),
    datum: new Material({ color: '#e1e8e6', roughness: .72 }),
  };
  const add = (geometry, material, name, shadow) => {
    const mesh = createMesh(engine, geometry, material);
    mesh.root.name = name;
    owned.push(mesh);
    if (shadow) shadows.add(mesh, shadow);
    return mesh;
  };
  buildGorge(add, materials);
  buildTowerHardware(add, materials);
  const moveCart = buildCart(add, materials);
  let model = equilibrium(position);
  const startGeometry = deckGeometry(model);
  const deck = add(startGeometry.deck, materials.timber, 'Segmented timber deck', {});
  const cable = add(startGeometry.details, materials.cables, 'Suspended deck cables and galvanized hangers', {});
  const comparison = new Surface();
  const stroke = rgb('#dcf2ef');
  for (const z of [cableZ, -cableZ]) {
    for (let x = .28; x < span - .22; x += .55) {
      const end = Math.min(span, x + .27);
      comparison.tube([[worldX(x), saddleHeight - referenceSag(x), z + .13],
        [worldX(end), saddleHeight - referenceSag(end), z + .13]], .046, stroke, 5);
    }
  }
  const trace = add(comparison.geometry, materials.datum, 'Unloaded cable reference');
  trace.root.setPosition([0, -500, 0]);
  moveCart(model);
  return {
    update(nextPosition) {
      model = equilibrium(nextPosition);
      const geometry = deckGeometry(model);
      deck.setGeometry(geometry.deck);
      cable.setGeometry(geometry.details);
      moveCart(model);
      return model;
    },
    showDatum(visible) {
      trace.root.setPosition([0, visible ? 0 : -500, 0]);
    },
    get model() { return model; },
    dispose() {
      for (const mesh of owned.reverse()) mesh.dispose();
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}