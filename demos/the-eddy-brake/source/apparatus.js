import { PbrMaterial, box } from '@margoengine/core';
import { CatmullRomCurve3 } from '@margoengine/geometry/shapes';
import { cylinderGeometry, latheGeometry, torusGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';

const TAU = 2 * Math.PI;
const shaftAxis = [0, 0, 1];
const alongShaft = axisAngleToQuaternion([1, 0, 0], Math.PI / 2);
const discCenter = [0, .296, .066];
const poleAngle = .55;
const polePosition = [.177 * Math.cos(poleAngle), .177 * Math.sin(poleAngle)];
const frontFace = .002;
const fieldWidth = .0135;

function section(r) {
  return -Math.expm1(-r * r / 2) / r;
}

function radiusAt(value, lo, hi, ascending) {
  for (let i = 0; i < 25; i++) {
    const middle = (lo + hi) / 2;
    if ((section(middle) < value) === ascending) lo = middle;
    else hi = middle;
  }
  return (lo + hi) / 2;
}

export function currentLine(fraction, lobe) {
  const peakRadius = 1.5852;
  const limit = Math.acos(fraction) * .9995;
  const cut = section(peakRadius) * fraction;
  const lines = [];
  for (const outer of [true, false]) {
    for (let index = 0; index <= 24; index++) {
      const theta = (index / 24 * 2 - 1) * limit * (outer ? 1 : -1);
      const value = cut / Math.cos(theta);
      const r = (outer ? radiusAt(value, peakRadius, 12, false) : radiusAt(value, 1e-7, peakRadius, true)) * fieldWidth;
      const x = lobe * r * Math.cos(theta), y = r * Math.sin(theta);
      lines.push([
        polePosition[0] - x * Math.sin(poleAngle) - y * Math.cos(poleAngle),
        polePosition[1] + x * Math.cos(poleAngle) - y * Math.sin(poleAngle),
        frontFace + .0034,
      ]);
    }
  }
  return new CatmullRomCurve3(lines, true, 'centripetal');
}

export function makeApparatus(engine, shadows) {
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness, doubleSided: false });
  const floor = finish('#6d6b61', .86);
  const matteIron = finish('#4b5550', .59);
  const graphite = finish('#313a35', .65);
  const platen = finish('#606463', .58);
  const cast = finish('#646d6c', .5, 1);
  const chrome = finish('#b8c2be', .23, 1);
  const darkSteel = finish('#69767a', .35, 1);
  const copper = finish('#bd794e', .37, 1);
  const shoulderCopper = finish('#886047', .48);
  const brightCopper = finish('#d89b6f', .31, 1);
  const brass = finish('#b5a16a', .31, 1);
  const ceramic = finish('#b9b6a2', .49);
  const index = finish('#d6e3d2', .37);
  const lacquer = finish('#3c6b5d', .48);
  const flowMaterial = [finish('#ace0d0', .56), finish('#a8cceb', .57)];
  const flowHeads = finish('#dbeee3', .55);

  function node(name, position, parent = null) {
    const mesh = engine.createMesh(parent).setPosition(position);
    mesh.name = name;
    return mesh;
  }
  function mount(name, shape, material, at, parent, caster = true) {
    const mesh = node(name, at, parent).setGeometry('uvs' in shape ? toGeometry(shape) : shape).setMaterial(material);
    if (caster) shadows.add(mesh, { static: !parent });
    return mesh;
  }
  function block(name, size, lip, material, at, parent) {
    return mount(name, roundedBoxGeometry(...size, 2, lip), material, at, parent);
  }
  function round(name, radius, depth, material, at, parent, count = 72) {
    return mount(name, cylinderGeometry(radius, radius, depth, count), material, at, parent)
      .setQuaternion(alongShaft);
  }
  function collar(name, radial, depth, thickness, material, at, parent, detail = 128) {
    const inner = radial - thickness;
    const d = depth / 2;
    const c = Math.min(depth * .30, thickness * .24, .0025);
    const profile = [
      [inner, d - c], [inner, -d + c], [inner + c, -d], [radial - c, -d],
      [radial, -d + c], [radial, d - c], [radial - c, d], [inner + c, d], [inner, d - c],
    ];
    return mount(name, latheGeometry(profile, detail), material, at, parent).setQuaternion(alongShaft);
  }

  mount('Studio sweep', box(40, .08, 40), floor, [0, -.072, 0], null, false);
  block('Cast bed', [.783, .049, .398], .013, graphite, [.045, -.001, -.015]);
  block('Ground platen', [.746, .011, .358], .005, platen, [.045, .029, -.015]);
  for (const x of [-.265, .355]) {
    for (const z of [-.151, .121]) {
      block('Rubber isolation pad', [.092, .027, .061], .010, graphite, [x, -.022, z]);
      mount('Platen bolt', cylinderGeometry(.0085, .0085, .007, 6), chrome, [x, .0375, z]);
    }
  }
  block('Recessed test strip', [.393, .0045, .035], .0019, matteIron, [-.032, .035, .122]);
  block('Test strip inlay', [.362, .0011, .0021], .00042, brass, [-.032, .0374, .124]);
  for (let mark = -10; mark <= 10; mark++) {
    block('Bed position mark', [.0019, .0012, mark % 5 === 0 ? .015 : .007], .00042, ceramic,
      [-.032 + mark * .0155, .0376, .116]);
  }

  const back = node('Bearing pedestal', [0, 0, -.093]);
  block('Bearing foot', [.201, .023, .177], .010, cast, [0, .049, 0], back);
  block('Bearing web', [.112, .228, .098], .027, matteIron, [0, .165, -.002], back);
  for (const sign of [-1, 1]) {
    const brace = block('Pedestal gusset', [.025, .167, .073], .009, matteIron, [sign * .061, .123, -.004], back);
    brace.setQuaternion(axisAngleToQuaternion(shaftAxis, sign * -.29));
    for (const z of [-.058, .058]) {
      mount('Bearing foot bolt', cylinderGeometry(.012, .012, .011, 6), darkSteel, [sign * .078, .066, z], back);
    }
  }
  round('Bearing barrel', .066, .086, cast, [0, discCenter[1], -.070]);
  collar('Bearing collar', .062, .026, .015, chrome, [0, discCenter[1], -.031]);
  round('Rotor spindle', .027, .170, chrome, [0, discCenter[1], .035]);

  const rotor = node('Copper rotor assembly', discCenter);
  const discProfile = [
    [.033, -.002], [.2389, -.002], [.2397, -.0011], [.240, .0008], [.2387, .002],
    [.234, .002], [.2335, .00170], [.2327, .00170], [.2321, .002],
    [.217, .002], [.2166, .00177], [.2158, .00177], [.2153, .002],
    [.115, .002], [.11455, .00172], [.11365, .00172], [.11325, .002],
    [.033, .002], [.033, -.002],
  ];
  mount('Turned copper disc', latheGeometry(discProfile, 176), copper, [0, 0, 0], rotor)
    .setQuaternion(alongShaft);
  collar('Aluminium hat', .081, .017, .049, darkSteel, [0, 0, .007], rotor);
  collar('Machined hub ring', .074, .0048, .0052, chrome, [0, 0, .018], rotor);
  round('Spindle locknut', .031, .022, darkSteel, [0, 0, .033], rotor, 12);
  round('Spindle cap', .021, .0035, chrome, [0, 0, .047], rotor);
  for (let i = 0; i < 8; i++) {
    const a = i * TAU / 8;
    round('Hatched hub screw', .0057, .0043, brass, [.057 * Math.cos(a), .057 * Math.sin(a), .017], rotor, 6);
  }
  for (let i = 0; i < 24; i++) {
    const a = TAU * i / 24, r = i % 6 === 0 ? .2305 : .232;
    const tick = block('Stroboscope track', [i % 6 === 0 ? .011 : .0065, .00185, .00036], .00016,
      i === 0 ? index : shoulderCopper, [r * Math.cos(a), r * Math.sin(a), .0025], rotor);
    tick.setQuaternion(axisAngleToQuaternion(shaftAxis, a));
  }
  const witness = block('Rotor timing witness', [.027, .003, .0008], .00032, index, [-.196, -.103, .0028], rotor);
  witness.setQuaternion(axisAngleToQuaternion(shaftAxis, .485));

  const px = polePosition[0], py = polePosition[1] + discCenter[1], pz = discCenter[2];
  const rail = px + .186;
  block('Caliper mounting pad', [.158, .019, .205], .008, cast, [rail - .003, .044, .055]);
  block('Caliper pedestal', [.073, .322, .085], .014, matteIron, [rail, .214, .059]);
  block('Caliper side spine', [.081, .124, .144], .011, cast, [rail - .004, py - .005, .059]);
  for (const z of [-.013, .134]) {
    block('Yoke arm', [.207, .045, .033], .010, darkSteel, [px + .090, py, z]);
    round('Pole shoe', .026, .053, darkSteel, [px, py, z < pz ? .032 : .103]);
    round('Ceramic winding bobbin', .0315, .045, ceramic, [px + .015, py, z + (z < pz ? -.023 : .023)]);
    for (let i = 0; i < 14; i++) {
      const wire = torusGeometry(.0335 + (i % 2) * .0004, .00130, 6, 52);
      mount('Enamelled copper winding', wire, i % 5 ? copper : brightCopper,
        [px + .015, py, z + (z < pz ? -.025 : .025) + (i - 6.5) * .00245], null, false);
    }
    collar('Bobbin flange', .044, .006, .010, brass, [px + .015, py, z + (z < pz ? -.043 : .043)], null, 72);
    collar('Pole end flange', .044, .0055, .007, darkSteel, [px + .015, py, z + (z < pz ? -.005 : .005)], null, 72);
    for (const x of [.252, .321]) round('Caliper fastening bolt', .010, .008, chrome, [x, py, z + .02], null, 6);
  }
  round('Magnet face insert', .027, .0054, darkSteel, [px + .015, py, .183], null, 32);
  round('Magnet face screw', .0080, .0054, brass, [px + .015, py, .187], null, 6);
  block('Coil terminal block', [.055, .053, .047], .007, lacquer, [rail, py + .084, .061]);
  for (const i of [-1, 1]) {
    round('Terminal ferrule', .007, .013, brass, [rail + .011 * i, py + .084, .090], null, 24);
    const lead = new CatmullRomCurve3([
      [rail + .011 * i, py + .084, .094], [rail + .006 * i, py + .11, .106],
      [rail - .087, py + .085 - i * .011, .167], [px + .035 + .008 * i, py + .028, .181],
    ]);
    mount('Insulated coil lead', tubeGeometry(lead, 28, .0043, 8), i > 0 ? graphite : lacquer, [0, 0, 0], null, false);
  }
  for (const x of [rail - .052, rail + .052]) {
    for (const z of [.001, .114]) mount('Caliper foot bolt', cylinderGeometry(.010, .010, .009, 6), chrome, [x, .056, z]);
  }

  const flow = [];
  for (const [color, lobe] of [-1, 1].entries()) {
    for (const [layer, fraction] of [.49, .63, .76, .89].entries()) {
      const route = currentLine(fraction, lobe);
      const line = mount('Induced current streamline', tubeGeometry(route, 96, .00092 - layer * .00006, 6, true),
        flowMaterial[color], discCenter, null, false);
      const tracer = mount('Flow direction marker', cylinderGeometry(.00019, .00155, .0055, 7), flowHeads,
        discCenter, null, false);
      line.visible = tracer.visible = false;
      flow.push({ line, tracer, route, offset: layer * .193 + color * .34 });
    }
  }

  let lastVisible = false, lastShade = -1;
  return {
    render(angle, clock, strength, showFlow) {
      rotor.setQuaternion(axisAngleToQuaternion(shaftAxis, angle % TAU));
      if (lastVisible !== showFlow) {
        for (const { line, tracer } of flow) line.visible = tracer.visible = showFlow;
        lastVisible = showFlow;
      }
      if (!showFlow) return;
      const shade = Math.round(Math.min(1, .25 + .75 * Math.sqrt(strength)) * 24);
      if (shade !== lastShade) {
        flowMaterial[0].set({ color: [.22 * shade / 24, .72 * shade / 24, .55 * shade / 24] });
        flowMaterial[1].set({ color: [.20 * shade / 24, .50 * shade / 24, .85 * shade / 24] });
        lastShade = shade;
      }
      for (const { tracer, route, offset } of flow) {
        const phase = (offset + clock) % 1;
        const p = route.getPointAt(phase);
        const q = route.getPointAt((phase + .005) % 1);
        tracer.setPosition(p.map((value, i) => value + discCenter[i]));
        tracer.setQuaternion(axisAngleToQuaternion(shaftAxis, Math.atan2(q[1] - p[1], q[0] - p[0]) - Math.PI / 2));
      }
    },
  };
}
