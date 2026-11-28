import { PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry, torusGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { bore, radius, startX, timedDistance } from './motion.js';

const Z = [0, 0, 1];
const noTilt = axisAngleToQuaternion([1, 0, 0], Math.PI / 2);
const hinge = [.418, .097, 0];
const lanes = [.108, -.105];
const finishX = startX + timedDistance;
const trackTop = .005;

export function makeRig(engine, shadows) {
  const surface = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const room = surface('#637365', .85);
  const dark = surface('#363f39', .66);
  const walnut = surface('#6b4f3b', .55);
  const plate = surface('#495a54', .52);
  const enamel = surface('#4a6660', .46);
  const lane = surface('#364742', .74);
  const metal = surface('#a5aeaa', .29, 1);
  const silver = surface('#b4bdbe', .28, 1);
  const machined = surface('#697b7d', .38, 1);
  const brass = surface('#ba8b4c', .38, 1);
  const bronze = surface('#806544', .44, 1);
  const white = surface('#d9d5b7', .59);
  const rubber = surface('#353e39', .82);
  const done = surface('#db9b49', .48);
  const waiting = surface('#536963', .53);

  function node(name, at, parent = null) {
    const item = engine.createMesh(parent).setPosition(at);
    item.name = name;
    return item;
  }
  function attach(name, data, paint, at, parent = null, casts = true, dynamic = false) {
    const item = node(name, at, parent).setGeometry('uvs' in data ? toGeometry(data) : data).setMaterial(paint);
    if (casts) shadows.add(item, { static: !dynamic });
    return item;
  }
  function block(name, dimensions, bevel, paint, at, parent = null, casts = true) {
    return attach(name, roundedBoxGeometry(...dimensions, 2, bevel), paint, at, parent, casts, !!parent);
  }
  function barrel(name, r, length, paint, at, parent = null, sides = 48, dynamic = !!parent) {
    return attach(name, cylinderGeometry(r, r, length, sides), paint, at, parent, true, dynamic);
  }
  function axle(...args) {
    return barrel(...args).setQuaternion(noTilt);
  }

  attach('Neutral studio sweep', box(42, .072, 42), room, [0, -.068, 0], null, false);
  block('Walnut isolation bed', [1.142, .046, .550], .018, walnut, [-.052, -.003, 0]);
  block('Machined brass bed hairline', [1.105, .0048, .518], .0021, brass, [-.052, .020, 0]);
  block('Cast support plate', [1.075, .015, .502], .007, plate, [-.052, .027, 0]);
  for (const x of [-.494, .375]) {
    for (const z of [-.20, .20]) {
      block('Rubber mounting shoe', [.106, .015, .065], .0068, rubber, [x, -.022, z]);
      barrel('Base anchor bolt', .0085, .005, metal, [x, .038, z], null, 6);
    }
  }

  for (const z of [-.209, .209]) {
    block('Hinge supporting side', [.086, .076, .055], .011, plate, [.419, .058, z]);
    axle('Ramp trunnion', .021, .016, bronze, [.419, .097, z * 1.12]);
    axle('Concentric hinge cap', .010, .0055, metal, [.419, .097, z * 1.17], null, 36);
  }
  axle('Hinge axle', .014, .435, machined, hinge);

  const ramp = node('Adjustable ramp', hinge);
  block('Ramp integral chassis', [1.011, .030, .430], .010, enamel, [-.442, -.019, 0], ramp);
  block('Ramp edge strip', [.997, .013, .022], .006, machined, [-.445, -.005, -.207], ramp);
  block('Ramp edge strip', [.997, .013, .022], .006, machined, [-.445, -.005, .207], ramp);
  block('Central raised divider', [.996, .014, .021], .006, enamel, [-.444, .000, .001], ramp);
  for (const z of lanes) {
    block('Fine abrasive runway', [.984, .008, .179], .0034, lane, [-.443, .001, z], ramp);
    block('Engraved check line', [.004, .0011, .155], .00039, white, [finishX, .00559, z], ramp, false);
    block('Starting line', [.002, .00068, .154], .00025, white, [startX, .00539, z], ramp, false);
    const guard = block('Catch zone bed', [.083, .0025, .168], .0011, rubber,
      [finishX + .077, .0049, z], ramp);
    guard.receiveShadow = true;
    block('Padded roller stop', [.026, .052, .166], .012, rubber, [finishX + .168, .023, z], ramp);
  }

  const tickShape = toGeometry(roundedBoxGeometry(.0017, .0008, .010, 1, .0003));
  for (let i = 0; i <= 14; i++) {
    const x = startX + i * .050;
    for (const z of [-.190, .190]) {
      const tick = attach('Engraved distance division', tickShape, white, [x, .0061, z], ramp, false);
      if (i % 5 === 0) tick.setScale([1, 1, 1.52]);
    }
  }

  const gate = node('Quick release crossbar', [startX + .069, 0, 0], ramp);
  block('Release stop bar', [.017, .013, .365], .0042, brass, [0, .074, 0], gate);
  for (const z of [-.204, .209]) {
    block('Gate linear guide', [.025, .148, .026], .0055, machined, [startX + .070, .073, z], ramp);
    block('Gate slide carriage', [.029, .023, .027], .005, metal, [0, .075, z], gate);
  }
  for (const z of [-.203, .204]) {
    block('Timing head upright', [.028, .067, .032], .0058, enamel, [finishX, .039, z], ramp);
    block('Polished timing head face', [.018, .012, .008], .0024, metal, [finishX, .061, z * .944], ramp);
  }
  const indicators = [0, 1].map((i) => {
    const z = i === 0 ? .203 : -.203;
    return block('Timed lane indicator', [.014,.0028,.010], .0011, waiting, [finishX,.074,z], ramp, false);
  });

  const discProfile = [
    [.0005, -.027], [.059, -.027], [.0623, -.0255], [.063, -.0238],
    [.063, .0238], [.0623, .0256], [.059, .027], [.0005, .027], [.0005, -.027],
  ];
  const ringProfile = [
    [bore, -.023], [bore + .0014, -.026], [.061, -.026], [.063, -.0237],
    [.063, .0237], [.061, .026], [bore + .0014, .026], [bore, .023], [bore, -.023],
  ];
  const bodies = [discProfile, ringProfile].map((profile, index) => {
    const body = node(index === 0 ? 'Solid cylindrical disc' : 'Uniform annular cylinder', [startX, radius + trackTop, lanes[index]], ramp);
    attach('Turned specimen', latheGeometry(profile, 120), index === 0 ? brass : silver, [0, 0, 0], body, true, true)
      .setQuaternion(noTilt);
    attach('Machined face highlight', torusGeometry(index ? .0591 : .049, .00075, 7, 96), index ? machined : bronze,
      [0, 0, .02704], body, false);
    block('Rotation witness', [index ? .0042 : .0130, .0019, .00061], .00028, index ? machined : white,
      [radius - (index ? .0031 : .015), 0, .02729], body, false);
    if (index === 0) axle('Disc face inspection mark', .007, .00076, bronze, [0, 0, .02725], body, 56);
    return body;
  });

  const lowerJack = [-.401, .039, .034];
  block('Angle screw mounting', [.114, .014, .108], .006, plate, [lowerJack[0], .040, lowerJack[2]]);
  barrel('Angle jack lower housing', .027, .075, machined, [lowerJack[0], .081, lowerJack[2]]);
  barrel('Knurled angle wheel', .043, .019, brass, [lowerJack[0], .123, lowerJack[2]], null, 36);
  const screw = barrel('Angle jack shank', .009, 1, metal, lowerJack, null, 36, true);
  const cradle = block('Angle jack head', [.064, .020,.059], .005, metal, [-.397, .206,.034], ramp);

  let previous = [false, false];
  return {
    pose(angle, distances, elapsed, finished) {
      ramp.setQuaternion(axisAngleToQuaternion(Z, -angle));
      const rx = -.838, ry = -.041;
      const x = hinge[0] + rx * Math.cos(angle) + ry * Math.sin(angle);
      const y = hinge[1] - rx * Math.sin(angle) + ry * Math.cos(angle);
      const low = [lowerJack[0], .106, lowerJack[2]];
      const dx = x - low[0], dy = y - low[1];
      screw.setPosition([(x + low[0]) * .5, (y + low[1]) * .5, low[2]]);
      screw.setScale([1, Math.hypot(dx, dy), 1]).setQuaternion(axisAngleToQuaternion(Z, -Math.atan2(dx,dy)));
      cradle.setPosition([rx, ry + .012, low[2]]);
      const rise = .094 * (1 - Math.exp(-38 * elapsed));
      gate.setPosition([startX + .069, rise, 0]);
      bodies.forEach((body, i) => {
        body.setPosition([startX + distances[i], radius + trackTop, lanes[i]]);
        body.setQuaternion(axisAngleToQuaternion(Z, -distances[i] / radius));
        if (finished[i] !== previous[i]) indicators[i].setMaterial(finished[i] ? done : waiting);
      });
      previous = finished;
    },
  };
}
