import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { contact, drumRadius, loadedTension, ropeRadius, tail, winding } from './model.js';

const up = [0, 1, 0];
const across = [1, 0, 0];
const front = [0, 0, 1];
const tau = 2 * Math.PI;
const twoEnds = [-.235, .147];

function cross(a, b) {
  return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
}
function unit(v) {
  const length = Math.hypot(...v);
  return v.map(value => value / length);
}

function sampleCenters(angle) {
  const radius = drumRadius + ropeRadius;
  const span = radius * angle;
  const length = span + twoEnds[1] - twoEnds[0];
  const count = Math.ceil(length / .0025);
  return Array.from({ length: count + 1 }, (_, i) => {
    const distance = length * i / count + twoEnds[0];
    const frame = distance < 0 ? tail(0, distance) : distance > span
      ? tail(angle, distance - span) : winding(distance / radius);
    return { ...frame, distance };
  });
}

function braid(frames, strand) {
  const points = frames.map(({ position, outward, towardHold, distance }) => {
    const helix = 2 * tau * distance / .044 + strand * tau / 3;
    const height = unit(cross(towardHold, outward));
    return position.map((value, axis) => value + .00210 * (outward[axis] * Math.cos(helix) + height[axis] * Math.sin(helix)));
  });
  const segments = 7, stride = segments + 1;
  const positions = [], normals = [], indices = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)], next = points[Math.min(i + 1, points.length - 1)];
    const tangent = unit(next.map((value, axis) => value - previous[axis]));
    const vertical = unit(cross(tangent, frames[i].outward));
    const radial = unit(cross(vertical, tangent));
    for (let j = 0; j <= segments; j++) {
      const phase = tau * j / segments;
      const n = radial.map((value, k) => value * Math.cos(phase) + vertical[k] * Math.sin(phase));
      normals.push(...n);
      positions.push(...points[i].map((value, k) => value + n[k] * .00204));
      if (i > 0 && j > 0) {
        const vertex = i * stride + j;
        indices.push(vertex - stride - 1, vertex - stride, vertex - 1, vertex - stride, vertex, vertex - 1);
      }
    }
  }
  return new Geometry(positions, normals, indices);
}

export function assembleCapstan(engine, shadows) {
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const studio = finish('#414b5f', .92);
  const jacket = finish('#294458', .53), skirt = finish('#203040', .64);
  const brass = finish('#bc8957', .31, 1), burnished = finish('#ddae70', .29, 1);
  const steel = finish('#adbac0', .29, 1), darkSteel = finish('#607480', .38, 1);
  const face = finish('#f4dcb3', .65), marker = finish('#58362e', .72);
  const coral = finish('#d06848', .52);
  const cords = ['#efc383', '#b97d52', '#d8af7b'].map(color => finish(color, .77));

  function node(name, at, parent = null) {
    const mesh = engine.createMesh(parent).setPosition(at);
    mesh.name = name;
    return mesh;
  }
  function part(name, geometry, surface, at, parent = null, casts = true, dynamic = !!parent) {
    const mesh = node(name, at, parent).setGeometry('uvs' in geometry ? toGeometry(geometry) : geometry).setMaterial(surface);
    if (casts) shadows.add(mesh, { static: !dynamic });
    return mesh;
  }
  const round = (name, dims, radius, coat, at, parent = null, casts = true) =>
    part(name, roundedBoxGeometry(...dims, 2, radius), coat, at, parent, casts);
  const pin = (name, radius, height, coat, at, parent = null, sides = 48) =>
    part(name, cylinderGeometry(radius, radius, height, sides), coat, at, parent);
  const profile = (name, points, coat, at = [0, 0, 0], parent = null) =>
    part(name, latheGeometry(points, 96), coat, at, parent);
  part('Studio sweep', box(32, .071, 32), studio, [0, -.054, 0], null, false);
  round('Cast-iron foundation', [.55, .031, .514], .015, skirt, [0, 0, 0]);
  round('Blue-enamel test bed', [.523, .013, .481], .0060, jacket, [0, .020, 0]);
  for (const x of [-.231,.231]) {
    for (const z of [-.211,.211]) {
      pin('Bronze mounting washer', .010, .004, brass, [x,.027,z], null, 24);
      pin('Steel deck fastener', .0068, .004, steel, [x,.030,z], null, 6);
    }
  }
  profile('Fixed outer bed ring', [[.192,.028],[.192,.035],[.189,.039],[.183,.040],[.180,.036],[.180,.028],[.192,.028]],darkSteel);
  profile('Inlaid ring', [[.189,.038],[.1875,.041],[.183,.041],[.1818,.038]],brass);
  for (let i = 0; i < 36; i++) {
    const angle = tau * i / 36;
    const tick = round('Track engraving', [i % 3 === 0 ? .006 : .003, .0007, .0011], .00024,
      i % 3 === 0 ? burnished : brass, [.185 * Math.cos(angle), .0411, .185 * Math.sin(angle)], null, false);
    tick.setQuaternion(axisAngleToQuaternion(up, -angle));
  }
  profile('Capstan foot', [[0,.029],[.102,.029],[.107,.033],[.107,.044],[.102,.052],[.071,.055],[0,.055]],steel);
  profile('Pedestal casting', [[0,.048],[.061,.048],[.068,.063],[.063,.070],[.056,.075],[.058,.109],[.063,.117],[0,.117]],jacket);
  pin('Lower thrust washer', .069, .011, brass, [0,.113,0]);
  profile('Brass drum', [[0,.113],[.092,.113],[.097,.118],[.097,.126],[.093,.132],[.089,.137],
    [.0876,.145],[.0876,.181],[.094,.187],[.099,.194],[.098,.204],[.091,.211],[0,.211]],brass);
  profile('Worn traction collar', [[.0877,.145],[.0877,.180],[.088,.181],[.088,.145],[.0877,.145]],burnished);
  profile('Black and bronze drum crown', [[0,.211],[.084,.211],[.086,.215],[.082,.220],[.057,.222],[.052,.227],[0,.227]],darkSteel);
  pin('Crown bearing lock ring', .035, .007, burnished, [0,.226,0]);
  pin('Hex drive locknut', .019, .012, steel, [0,.235,0], null, 6);
  for (let i = 0; i < 8; i++) {
    const phase = tau * i / 8;
    pin('Countersunk cap fastener', .0048, .0024, steel, [.069*Math.cos(phase),.220,.069*Math.sin(phase)], null, 6);
  }

  function gauge(name, coat) {
    const root = node(name, [0,0,0]);
    round('Sliding saddle', [.044,.014,.049], .0045, darkSteel, [0,.047,0], root);
    round('Fluted pedestal', [.026,.084,.026], .004, coat, [0,.089,0], root);
    pin('Guide tube', .0072, .132, steel, [0,.108,0], root);
    const casing = pin('Bronze force gauge case', .022, .013, brass, [0,.119,.017], root);
    casing.setQuaternion(axisAngleToQuaternion(across, Math.PI/2));
    const dial = pin('Ivory force gauge dial', .0184, .0024, face, [0,.119,.024], root);
    dial.setQuaternion(axisAngleToQuaternion(across, Math.PI/2));
    for (let i = 0; i < 11; i++) {
      const angle = (-.76 + 1.52*i/10) * Math.PI;
      const tick = round('Gauge scale graduation', [.00069, .0024, .0005], .00020, marker,
        [-.015*Math.sin(angle),.119 + .015*Math.cos(angle),.0255], root, false);
      tick.setQuaternion(axisAngleToQuaternion(front, angle));
    }
    const pivot = node('Needle pivot', [0,.119,.0262], root);
    round('Tension needle', [.0013,.014,.0007], .0003, coral, [0,.005,.0004], pivot, false);
    const coupling = pin('Rope end clamp', .0072, .012, coat, [0,.170,0], root, 12);
    return { root, pivot, coupling };
  }
  const loadEnding = gauge('Load-end gauge', darkSteel);
  const effortEnding = gauge('Holding-end gauge', coral);
  let lastAngle = -1;
  let ropes;
  function moveGauge(gauge, frame, tension) {
    const [x,y,z] = frame.position;
    gauge.root.setPosition([x,0,z]);
    gauge.coupling.setPosition([0,y,0]);
    gauge.pivot.setQuaternion(axisAngleToQuaternion(front, (.76 - 1.52 * tension / loadedTension) * Math.PI));
  }
  return {
    pose(turns, friction) {
      const model = contact(turns, friction);
      if (model.angle !== lastAngle) {
        const samples = sampleCenters(model.angle);
        if (ropes) {
          for (const [i, mesh] of ropes.entries()) mesh.setGeometry(braid(samples, i));
        } else {
          ropes = cords.map((coat, i) => part('Braided linen strand', braid(samples, i), coat, [0,0,0], null, false, true));
        }
        lastAngle = model.angle;
      }
      moveGauge(loadEnding, tail(0, twoEnds[0]), loadedTension);
      moveGauge(effortEnding, tail(model.angle, twoEnds[1]), model.holdingTension);
      return model;
    },
  };
}


