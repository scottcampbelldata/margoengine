import { PbrMaterial } from '@margoengine/core';
import { extrudeGeometry } from '@margoengine/geometry/extrude';
import { parametricGeometry, roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { CatmullRomCurve3, Path, Shape } from '@margoengine/geometry/shapes';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion, multiplyQuaternions, rotationToQuaternion } from '@margoengine/math/quat';

const turn = Math.PI * 2;
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
function unit(v) {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
}

export const lampPosition = [-.72, .74, .42];
export const lampAxis = unit([1.06, -.37, -.71]);
const fixtureRight = unit(cross([0, 1, 0], lampAxis));
const fixtureUp = cross(lampAxis, fixtureRight);
const fixtureRotation = rotationToQuaternion([...fixtureRight, ...fixtureUp, ...lampAxis]);
const axialRotation = multiplyQuaternions(fixtureRotation, axisAngleToQuaternion([1, 0, 0], Math.PI / 2));
const gateDistance = .250;
const gateScale = 1.49;
const handleRadius = .154;
const gateHinge = [.157, .096];
const hingeDistance = Math.hypot(...gateHinge);

function fixturePoint(x, y, z) {
  return lampPosition.map((coordinate, index) =>
    coordinate + x * fixtureRight[index] + y * fixtureUp[index] + z * lampAxis[index]);
}

function circle(radius, segments) {
  return Array.from({ length: segments }, (_, i) => {
    const angle = i / segments * turn;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
}

function slottedDisk() {
  const disk = new Shape(circle(.090 * gateScale, 96));
  for (const [height, halfWidth, halfHeight] of [[-.036, .054, .008], [0, .071, .010], [.036, .062, .008]]) {
    const contour = [];
    const radius = halfHeight;
    for (const sign of [1, -1]) {
      for (let segment = 0; segment <= 10; segment++) {
        const phase = -Math.PI / 2 + segment / 10 * Math.PI;
        const x = sign * (halfWidth - radius + Math.cos(phase) * radius);
        const bend = .006 * (1 - (x / halfWidth) ** 2);
        contour.push([x * gateScale, (height + bend + sign * Math.sin(phase) * radius) * gateScale]);
      }
    }
    disk.holes.push(new Path(contour));
  }
  return extrudeGeometry(disk, { depth: .003, bevelThickness: .00045, bevelSize: .00045, bevelSegments: 2 });
}

function cyclorama() {
  return parametricGeometry((u, v) => {
    const x = (u - .5) * 13;
    if (v < .43) return [x, -.152, 5 - 6.09 * v / .43];
    if (v < .71) {
      const sweep = (v - .43) / .28 * Math.PI / 2;
      return [x, -.152 + .58 * (1 - Math.cos(sweep)), -1.09 - .58 * Math.sin(sweep)];
    }
    return [x, .428 + (v - .71) * 11, -1.67];
  }, 4, 112);
}

function plasterFold() {
  return parametricGeometry((u, v) => {
    const a = u * turn, b = v * turn;
    const c = Math.cos(a), s = Math.sin(a);
    const base = .199 + .026 * Math.cos(3 * a - .65) + .016 * Math.sin(2 * a + .2);
    const thickness = .069 + .023 * Math.sin(a - 1.08) + .010 * Math.cos(3 * a + .45);
    const groove = .0010 * Math.sin(49 * a + 2 * Math.sin(4 * b)) * (.38 + .62 * Math.sin(b) ** 2);
    const tooling = .00046 * Math.sin(37 * a - 7 * b) * Math.cos(67 * a + 11 * b);
    const twist = b + .49 * Math.sin(a + .45);
    const across = (thickness + groove + tooling) * Math.cos(twist);
    const front = (.106 + .018 * Math.cos(2 * a - .4) + groove) * Math.sin(twist);
    return [
      (base + across) * c - .10 * (base + across) * s,
      1.17 * (base + across) * s,
      front + .074 * Math.sin(2 * a + .55) + .065 * c,
    ];
  }, 176, 80);
}

export function createBench(engine, light) {
  const material = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const slate = material('#394347', .82);
  const paintedAlloy = material('#414e54', .47);
  const aluminum = material('#869698', .35, 1);
  const darkMetal = material('#484846', .52, 1);
  const blackenedSteel = material('#626868', .54);
  const copper = material('#b17a59', .28, 1);
  const bronze = material('#97714d', .44, 1);
  const slateEdge = material('#3c5357', .59);
  const board = material('#c9bda9', .89);
  const plaster = material('#ded1b5', .66);
  const graphite = material('#36494d', .90);
  const cobalt = material('#305872', .32);
  const ceramic = material('#d0bca6', .64);
  const ivory = material('#d7c7a2', .68);
  const cableMaterial = material('#363e41', .82);
  let meshCount = 0;

  function mount(data, finish, position, { rotation, caster = false } = {}) {
    const geometry = 'uvs' in data ? toGeometry(data) : data;
    const mesh = engine.createMesh().setGeometry(geometry).setMaterial(finish).setPosition(position);
    if (rotation) mesh.setQuaternion(rotation);
    if (caster) light.addShadowCaster(mesh);
    meshCount++;
    return mesh;
  }
  const block = (width, height, depth, bevel) => roundedBoxGeometry(width, height, depth, 3, bevel);
  const box = (size, radius, finish, position, options) => mount(block(...size, radius), finish, position, options);
  const upright = (radius, height, finish, position, options) =>
    mount(cylinderGeometry(radius, radius, height, 40, 1), finish, position, options);
  function sleeve(profile, finish) {
    return mount(latheGeometry(profile, 64), finish, lampPosition, { rotation: axialRotation });
  }
  function collar(back, front, inner, outer, finish, caster = false) {
    const bevel = Math.min(.004, (front - back) * .2, (outer - inner) * .28);
    const path = [[inner, back + bevel], [inner + bevel, back], [outer - bevel, back], [outer, back + bevel],
      [outer, front - bevel], [outer - bevel, front], [inner + bevel, front], [inner, front - bevel], [inner, back + bevel]];
    return mount(latheGeometry(path, 64), finish, lampPosition, { rotation: axialRotation, caster });
  }

  box([2.72, .108, 1.5], .033, slate, [-.04, -.005, .01]);
  box([2.66, .034, 1.437], .016, slateEdge, [-.04, -.063, .01]);
  box([2.55, .064, 1.33], .010, graphite, [-.04, -.109, .01]);
  mount(cyclorama(), graphite, [0, 0, 0]);

  // A bare off-white backboard receives the same live spot as the plaster and the bench.
  box([1.36, .84, .054], .018, darkMetal, [.445, .486, -.578]);
  box([1.308, .786, .025], .011, board, [.445, .486, -.548]);
  for (const x of [-.14, 1.01]) {
    box([.084, .082, .155], .01, darkMetal, [x, .069, -.543]);
  }

  const plinth = [.27, .075, -.13];
  box([.64, .052, .43], .018, paintedAlloy, plinth, { caster: true });
  box([.592, .012, .382], .005, darkMetal, [.27, .108, -.13], { caster: true });
  mount(plasterFold(), plaster, [.27, .448, -.132], { caster: true });

  const swatchRotation = axisAngleToQuaternion([0, 1, 0], -.14);
  box([.139, .028, .138], .008, cobalt, [.85, .065, .213], { rotation: swatchRotation, caster: true });
  box([.139, .03, .138], .008, ceramic, [1.002, .066, .190], { rotation: swatchRotation, caster: true });
  box([.32, .009, .020], .004, bronze, [.88, .054, .313], { rotation: swatchRotation });

  const post = [-.965, .338, .443];
  box([.393, .055, .403], .027, paintedAlloy, [post[0], .076, post[2]]);
  box([.362, .012, .373], .006, aluminum, [post[0], .108, post[2]]);
  upright(.084, .020, darkMetal, [post[0], .123, post[2]]);
  upright(.047, .341, blackenedSteel, [post[0], .30, post[2]]);
  upright(.031, .224, aluminum, [post[0], .547, post[2]]);
  upright(.058, .054, darkMetal, [post[0], .431, post[2]]);
  upright(.049, .031, copper, [post[0], .638, post[2]]);
  box([.192, .048, .052], .012, darkMetal, [-.936, .661, .488], {
    rotation: axisAngleToQuaternion([0, 1, 0], -.26),
  });
  box([.052, .129, .031], .011, paintedAlloy, [-.938, .718, .534]);
  upright(.021, .031, bronze, [-.937, .747, .562], {
    rotation: axisAngleToQuaternion([1, 0, 0], Math.PI / 2),
  });

  sleeve([
    [.081, -.305], [.11, -.305], [.12, -.297], [.121, -.230], [.110, -.216], [.109, -.094],
    [.133, -.067], [.141, -.042], [.141, -.013], [.133, .008], [.112, .046], [.111, .116],
    [.104, .130], [.095, .130], [.095, .062], [.115, .010], [.122, -.025], [.116, -.052],
    [.093, -.086], [.092, -.222], [.081, -.287], [.081, -.305],
  ], paintedAlloy);
  collar(-.307, -.284, .081, .123, aluminum);
  collar(-.218, -.199, .102, .124, darkMetal);
  collar(-.086, -.061, .106, .139, bronze);
  collar(-.036, -.005, .122, .148, copper);
  collar(.057, .073, .106, .119, darkMetal);
  collar(.114, .151, .087, .125, copper, true);
  collar(.149, .162, .087, .120, darkMetal, true);
  collar(gateDistance - .019, gateDistance - .002, .128, .163, paintedAlloy, true);
  collar(gateDistance + .005, gateDistance + .015, .128, .153, copper, true);
  const rails = toGeometry(block(.014, .018, .092, .003));
  for (const side of [-1, 1]) {
    mount(rails, darkMetal, fixturePoint(side * .126, -.041, .194), { rotation: fixtureRotation });
    mount(rails, darkMetal, fixturePoint(side * .125, .042, .194), { rotation: fixtureRotation });
  }
  mount(block(.041, .026, .022, .006), darkMetal, fixturePoint(.145, .090, gateDistance));
  mount(cylinderGeometry(.012, .012, .024, 24, 1), bronze,
    fixturePoint(...gateHinge, gateDistance + .012), { rotation: axialRotation });

  // The grip ribs are small machined pieces; all share one instanced geometry.
  const rib = toGeometry(block(.009, .006, .023, .002));
  for (let index = 0; index < 34; index++) {
    const angle = index * turn / 34;
    mount(rib, bronze, fixturePoint(.142 * Math.cos(angle), .142 * Math.sin(angle), -.019), {
      rotation: multiplyQuaternions(fixtureRotation, axisAngleToQuaternion([0, 0, 1], angle)),
    });
  }
  const vent = toGeometry(block(.020, .005, .069, .002));
  for (let index = 0; index < 12; index++) {
    const angle = index * turn / 12;
    mount(vent, darkMetal, fixturePoint(.111 * Math.cos(angle), .111 * Math.sin(angle), -.155), {
      rotation: multiplyQuaternions(fixtureRotation, axisAngleToQuaternion([0, 0, 1], angle - Math.PI / 2)),
    });
  }
  const screw = toGeometry(cylinderGeometry(.0075, .0075, .006, 16, 1));
  for (let index = 0; index < 6; index++) {
    const angle = index * turn / 6;
    mount(screw, bronze, fixturePoint(.107 * Math.cos(angle), .107 * Math.sin(angle), .165), { rotation: axialRotation });
  }
  const cable = new CatmullRomCurve3([
    fixturePoint(0, -.042, -.302), [-1.237, .56, .641], [-1.265, .28, .636],
    [-1.16, .059, .599], [-1.04, .055, .34], [-1.12, .056, .165], [-1.22, .055, -.14],
  ]);
  mount(tubeGeometry(cable, 52, .007, 12), cableMaterial, [0, 0, 0]);
  box([.071, .012, .018], .004, ivory, [-1.072, .057, .303], {
    rotation: axisAngleToQuaternion([0, 1, 0], -.37),
  });

  const disk = mount(slottedDisk(), blackenedSteel, fixturePoint(0, 0, gateDistance), { caster: true });
  const handle = mount(block(.025, .074, .014, .005), bronze, fixturePoint(0, handleRadius, gateDistance + .005));
  const notch = mount(block(.003, .020, .002, .001), ivory, fixturePoint(0, handleRadius, gateDistance + .014));
  const hingeArm = mount(block(.013, hingeDistance - .124, .008, .003), bronze, [0, 0, 0]);

  return {
    get meshCount() { return meshCount; },
    setMask(angle, lift) {
      const swing = -2.15 * lift;
      const c = Math.cos(swing), s = Math.sin(swing);
      const [hingeX, hingeY] = gateHinge;
      const armX = hingeX * c - hingeY * s;
      const armY = hingeX * s + hingeY * c;
      const x = hingeX - armX, y = hingeY - armY;
      const direction = angle + swing;
      const rotation = multiplyQuaternions(fixtureRotation, axisAngleToQuaternion([0, 0, 1], direction));
      const handleX = x - handleRadius * Math.sin(direction);
      const handleY = y + handleRadius * Math.cos(direction);
      disk.setQuaternion(rotation).setPosition(fixturePoint(x, y, gateDistance));
      handle.setQuaternion(rotation).setPosition(fixturePoint(handleX, handleY, gateDistance + .005));
      notch.setQuaternion(rotation).setPosition(fixturePoint(handleX, handleY, gateDistance + .014));
      const armCenter = (.124 + hingeDistance) * .5 / hingeDistance;
      hingeArm.setQuaternion(multiplyQuaternions(fixtureRotation,
        axisAngleToQuaternion([0, 0, 1], Math.atan2(armY, armX) - Math.PI / 2)));
      hingeArm.setPosition(fixturePoint(x + armX * armCenter, y + armY * armCenter, gateDistance));
    },
  };
}
