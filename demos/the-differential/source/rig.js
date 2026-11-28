import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { sideTeeth, pinionTeeth } from './mechanism.js';

const tau = Math.PI * 2;
const Y = [0, 1, 0];
const X = [1, 0, 0];
const Z = [0, 0, 1];
const axleHeight = .244;
const coneAngle = Math.atan(sideTeeth / pinionTeeth);

function toothBand(teeth, pitch, start, end, height, thickness) {
  const contour = [[0, 0], [.12, 0], [.24, .18], [.34, .86], [.41, 1], [.59, 1], [.66, .86], [.76, .18], [.88, 0]];
  const positions = [], normals = [], indices = [];
  const ringCount = teeth * contour.length;
  const sin = Math.sin(pitch), cos = Math.cos(pitch);
  const rows = [[start + .0015, -.004, .89], [start, 0, 1], [end, 0, 1], [end + .0015, -.004, .89],
    [end + .0015, -thickness, 0], [start + .0015, -thickness, 0]];
  const rings = rows.map(([distance, offset, strength]) => Array.from({ length: ringCount }, (_, index) => {
    const [phase, crest] = contour[index % contour.length];
    const angle = tau * (Math.floor(index / contour.length) + phase) / teeth;
    const normalOffset = offset + height * (crest - .37) * strength;
    const radius = distance * sin + normalOffset * cos;
    const axial = distance * cos - normalOffset * sin;
    return [radius * Math.cos(angle), axial, radius * Math.sin(angle)];
  }));
  for (let j = 0; j < rings.length; j++) {
    const from = rings[j], to = rings[(j + 1) % rings.length];
    for (let i = 0; i < ringCount; i++) {
      const next = (i + 1) % ringCount;
      const corners = [from[i], from[next], to[next], to[i]];
      const u = corners[1].map((value, axis) => value - corners[0][axis]);
      const v = corners[3].map((value, axis) => value - corners[0][axis]);
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...cross);
      const first = positions.length / 3;
      for (const point of corners) {
        positions.push(...point);
        normals.push(...cross.map((value) => -value / length));
      }
      indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
    }
  }
  return new Geometry(positions, normals, indices);
}

function coneBack(pitch, start, end, thickness) {
  const sin = Math.sin(pitch), cos = Math.cos(pitch);
  const outerRadius = end * sin - thickness * cos;
  const rear = end * cos + thickness * sin;
  const innerRadius = start * sin - thickness * cos;
  const front = start * cos + thickness * sin;
  return toGeometry(latheGeometry([
    [.022, rear + .014], [outerRadius - .009, rear + .014], [outerRadius, rear + .004],
    [outerRadius, rear - .001], [innerRadius, front - .001], [.021, front + .002], [.020, front + .008],
    [.020, rear + .013], [.022, rear + .014],
  ].reverse(), 96));
}

export function makeRig(engine, shadows) {
  const material = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const cast = material('#575f61', .53, 1);
  const brushed = material('#aab0a9', .29, 1);
  const pins = material('#a6aa9a', .22, 1);
  const bronze = material('#c18b54', .32, 1);
  const silver = material('#a6babe', .24, 1);
  const oxide = material('#393e3d', .48);
  const cradle = material('#586465', .64);
  const base = material('#363f42', .65);
  const lino = material('#4d5758', .87);
  const amber = material('#b08050', .38);
  const teal = material('#487f7c', .37);
  const enamel = material('#d1ddd0', .47);

  function node(position, parent) {
    return engine.createMesh(parent).setPosition(position);
  }
  function mesh(shape, finish, position, parent, caster = true) {
    const geometry = shape instanceof Geometry ? shape : toGeometry(shape);
    const item = node(position, parent).setGeometry(geometry).setMaterial(finish);

    if (caster) shadows.add(item, { static: !parent });
    return item;
  }
  function cylinder(radius, length, finish, position, parent, segments = 48) {
    return mesh(cylinderGeometry(radius, radius, length, segments), finish, position, parent);
  }
  function rounded(width, height, depth, radius, finish, position, parent) {
    return mesh(roundedBoxGeometry(width, height, depth, 2, radius), finish, position, parent);
  }
  function xAxis(item) {
    return item.setQuaternion(axisAngleToQuaternion(Z, -Math.PI / 2));
  }
  function xCollar(parent, x, inner, outer, depth, finish) {
    const half = depth / 2;
    const bevel = Math.min(.0024, depth * .22);
    const profile = [
      [inner + bevel, half], [outer - bevel, half], [outer, half - bevel], [outer, -half + bevel],
      [outer - bevel, -half], [inner + bevel, -half], [inner, -half + bevel], [inner, half - bevel], [inner + bevel, half],
    ];
    return xAxis(mesh(latheGeometry(profile.reverse(), 112), finish, [x, 0, 0], parent));
  }

  mesh(box(15, .12, 15), lino, [0, -.096, 0], null, false);
  rounded(.92, .044, .466, .014, base, [0, -.011, 0]);
  rounded(.887, .009, .434, .005, cradle, [0, .015, 0]);
  for (const sign of [-1, 1]) {
    for (const depth of [-.152, .152]) {
      rounded(.11, .026, .055, .009, oxide, [sign * .33, -.025, depth]);
      cylinder(.009, .003, brushed, [sign * .384, .020, depth], null, 6);
    }
  }
  rounded(.468, .004, .037, .0019, cast, [0, .0205, .176]);
  rounded(.432, .0017, .0030, .00072, brushed, [0, .0229, .178]);
  const tickFinishes = [amber, brushed, teal];
  for (let group = 0; group < tickFinishes.length; group++) {
    for (let index = -4; index <= 4; index++) {
      const length = index === 0 ? .015 : index % 2 === 0 ? .009 : .006;
      rounded(.0015, .0012, length, .00052, tickFinishes[group],
        [(group - 1) * .147 + index * .0115, .02295, .178 - length / 2]);
    }
  }
  const axleOrigin = node([0, axleHeight, 0]);
  for (const sign of [-1, 1]) {
    const x = sign * .263;
    const standX = x + sign * .031;
    rounded(.093, .014, .185, .007, cast, [standX, .027, 0]);
    rounded(.061, .176, .092, .017, cradle, [standX, .125, 0]);
    for (const depth of [-.055, .055]) {
      const rib = rounded(.052, .142, .019, .007, cast, [standX, .099, depth * .87]);
      rib.setQuaternion(axisAngleToQuaternion(X, depth * -5.8));
      cylinder(.011, .008, pins, [standX, .038, depth * 1.45], null, 6);
    }
    xCollar(axleOrigin, standX, .027, .058, .053, cradle);
    xCollar(axleOrigin, standX - sign * .028, .029, .046, .011, brushed);
    xCollar(axleOrigin, standX + sign * .028, .028, .050, .009, cast);
    for (let index = 0; index < 6; index++) {
      const a = tau * index / 6 + .19;
      xAxis(cylinder(.0048, .0045, pins, [standX + sign * .034, .042 * Math.cos(a), .042 * Math.sin(a)], axleOrigin, 6));
    }
  }

  const carrier = node([0, 0, 0], axleOrigin);
  const ring = toothBand(38, Math.PI / 2 - .16, .180, .204, .010, .013);
  xAxis(mesh(ring, brushed, [-.150, 0, 0], carrier));
  xCollar(carrier, -.134, .125, .188, .026, cast);
  xCollar(carrier, -.119, .126, .156, .010, brushed);
  xCollar(carrier, .127, .103, .134, .024, cast);
  xCollar(carrier, .141, .103, .122, .009, brushed);
  for (let index = 0; index < 10; index++) {
    const a = tau * index / 10;
    xAxis(cylinder(.007, .006, pins, [-.111, .144 * Math.cos(a), .144 * Math.sin(a)], carrier, 6));
  }
  // Two saddle ribs support the cross shaft and leave the tooth contacts visible.
  for (const side of [-1, 1]) {
    const rib = node([0, 0, 0], carrier).setQuaternion(axisAngleToQuaternion(X, side * Math.PI / 2));
    rounded(.262, .033, .059, .012, cast, [0, .132, 0], rib);
    cylinder(.028, .026, brushed, [0, .150, 0], rib);
    cylinder(.011, .010, pins, [0, .166, 0], rib, 6);
  }
  const cross = node([0, 0, 0], carrier);
  cross.setQuaternion(axisAngleToQuaternion(X, Math.PI / 2));
  cylinder(.012, .318, pins, [0, 0, 0], cross);

  const sideBand = toothBand(sideTeeth, coneAngle, .108, .168, .010, .015);
  const sideCore = coneBack(coneAngle, .108, .168, .015);
  const spinAxes = [-1, 1].map((sign) => {
    const root = node([0, 0, 0], axleOrigin);
    const gear = node([0, 0, 0], root).setQuaternion(axisAngleToQuaternion(Z, -sign * Math.PI / 2));
    const tint = sign < 0 ? bronze : silver;
    const paint = sign < 0 ? amber : teal;
    mesh(sideBand, tint, [0, 0, 0], gear);
    mesh(sideCore, tint, [0, 0, 0], gear);
    xAxis(cylinder(.024, .343, brushed, [sign * .242, 0, 0], root));
    xAxis(cylinder(.034, .034, cast, [sign * .178, 0, 0], root));
    xAxis(cylinder(.039, .025, paint, [sign * .365, 0, 0], root));
    xCollar(root, sign * .382, .022, .039, .009, brushed);
    for (let index = 0; index < 3; index++) {
      const a = tau * index / 3;
      rounded(.023, .0017, .007, .0006, enamel, [sign * .365, .0395 * Math.cos(a), .0395 * Math.sin(a)], root)
        .setQuaternion(axisAngleToQuaternion(X, a));
    }
    for (let index = 0; index < 12; index++) {
      const a = tau * index / 12;
      xAxis(cylinder(.0031, .039, brushed,
        [sign * .404, .024 * Math.cos(a), .024 * Math.sin(a)], root, 8));
    }
    return root;
  });
  const pinionPitch = Math.PI / 2 - coneAngle;
  const pinionBand = toothBand(pinionTeeth, pinionPitch, .108, .168, .010, .015);
  const pinionCore = coneBack(pinionPitch, .108, .168, .015);
  const spiders = [-1, 1].map((sign) => {
    const holder = node([0, 0, 0], cross).setQuaternion(axisAngleToQuaternion(X, sign < 0 ? Math.PI : 0));
    const gear = node([0, 0, 0], holder);
    mesh(pinionBand, brushed, [0, 0, 0], gear);
    mesh(pinionCore, pins, [0, 0, 0], gear);
    return gear;
  });
  return {
    setAngles({ carrier: carrierAngle, left, right, pinions }) {
      carrier.setQuaternion(axisAngleToQuaternion(X, carrierAngle));
      spinAxes[0].setQuaternion(axisAngleToQuaternion(X, left));
      spinAxes[1].setQuaternion(axisAngleToQuaternion(X, right));
      for (const gear of spiders) gear.setQuaternion(axisAngleToQuaternion(Y, pinions));
    },
  };
}
