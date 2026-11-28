import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry, torusGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';

const tau = Math.PI * 2;
const axial = axisAngleToQuaternion([1, 0, 0], Math.PI / 2);
const aim = [0, .262, .093];
const turn = (angle) => axisAngleToQuaternion([0, 0, 1], angle);

function machinedRing(inside, outside, depth, bevel) {
  const z = depth / 2;
  const profile = [
    [inside + bevel, -z], [outside - bevel, -z], [outside, -z + bevel], [outside, z - bevel],
    [outside - bevel, z], [inside + bevel, z], [inside, z - bevel], [inside, -z + bevel], [inside + bevel, -z],
  ];
  return latheGeometry(profile, 112);
}

export function createInstrument(engine, shadows) {
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const labTable = finish('#576773', .81);
  const slate = finish('#2d363e', .52);
  const rubber = finish('#343638', .8);
  const navy = finish('#204b63', .37);
  const edgeBlue = finish('#307289', .28);
  const grip = finish('#2c5a70', .53);
  const bronze = finish('#b98551', .31, 1);
  const satin = finish('#d0a775', .45, 1);
  const steel = finish('#b6c1c1', .28, 1);
  const ceramic = finish('#8d9ea1', .48);
  const ivory = finish('#dfd8b9', .46);
  const baffle = finish('#303438', .82);
  let count = 0;
  const geometries = new WeakMap();

  function mount(shape, material, position, { parent, rotation, cast } = {}) {
    if (!geometries.has(shape)) geometries.set(shape, toGeometry(shape));
    const mesh = engine.createMesh(parent).setGeometry(geometries.get(shape)).setMaterial(material).setPosition(position);
    if (rotation) mesh.setQuaternion(rotation);
    if (cast) shadows.add(mesh, { static: true });
    count++;
    return mesh;
  }
  const block = (width, height, depth, bevel) => roundedBoxGeometry(width, height, depth, 3, bevel);
  const solid = (r, depth) => cylinderGeometry(r, r, depth, 76, 1);
  const box = (dims, bevel, material, at, options) => mount(block(...dims, bevel), material, at, options);
  const ring = (inside, outside, depth, bevel, material, at, { parent, cast } = {}) =>
    mount(machinedRing(inside, outside, depth, bevel), material, at, { rotation: axial, parent, cast });
  const disc = (r, depth, material, at, options) => mount(solid(r, depth), material, at, { rotation: axial, ...options });
  const staticCaster = { cast: true };

  box([80, .12, 80], .016, labTable, [0, -.115, 0]);
  box([.596, .044, .605], .021, slate, [0, -.005, -.015], staticCaster);
  box([.570, .009, .580], .004, steel, [0, .017, -.015]);
  box([.550, .015, .560], .007, slate, [0, .025, -.015]);
  const foot = solid(.036, .035);
  for (const x of [-.23, .23]) for (const z of [-.25, .21]) mount(foot, rubber, [x, -.037, z], staticCaster);

  // Paired dovetail rails preserve the assembly's optical alignment.
  for (const x of [-.081, .081]) {
    box([.026, .021, .481], .007, ceramic, [x, .045, -.027], staticCaster);
    box([.013, .008, .469], .003, steel, [x, .055, -.027]);
  }
  const fastener = cylinderGeometry(.008, .008, .004, 20, 1);
  const slot = block(.010, .0008, .002, .0003);
  for (const x of [-.081, .081]) for (const z of [-.238, -.111, .022, .153]) {
    mount(fastener, steel, [x, .061, z]);
    mount(slot, rubber, [x, .0632, z], { rotation: axisAngleToQuaternion([0, 1, 0], x * 5 + z * 3) });
  }
  // Rear lamp, fixed brass polarizer, and blue turning analyzer.
  box([.228, .033, .119], .015, slate, [0, .072, -.201], staticCaster);
  box([.080, .139, .090], .014, navy, [0, .139, -.201], staticCaster);
  disc(.105, .114, slate, [0, aim[1], -.242], staticCaster);
  ring(.076, .111, .018, .0035, bronze, [0, aim[1], -.184], staticCaster);
  ring(.077, .100, .013, .002, steel, [0, aim[1], -.297]);
  for (let z = -.281; z < -.197; z += .011) ring(.102, .117, .0068, .0019, navy, [0, aim[1], z]);
  disc(.078, .008, ivory, [0, aim[1], -.176]);

  box([.221, .035, .105], .012, slate, [0, .073, -.087], staticCaster);
  box([.101, .124, .052], .017, ceramic, [0, .142, -.079], staticCaster);
  ring(.106, .147, .036, .005, slate, [0, aim[1], -.087], staticCaster);
  const polarizer = engine.createMesh().setPosition([0, aim[1], -.079]);
  const polarizerShell = ring(.091, .151, .038, .005, bronze, [0, 0, 0], { parent: polarizer });
  shadows.add(polarizerShell, { static: true });
  ring(.113, .155, .011, .003, satin, [0, 0, .023], { parent: polarizer });
  ring(.091, .117, .014, .003, baffle, [0, 0, .030], { parent: polarizer });
  // One index pointer marks the top of each mount, so a half turn reads differently from no turn. The rim lamp
  // lights on the filter the angle control turns.
  box([.015, .023, .013], .003, ivory, [0, .149, .030], { parent: polarizer });
  box([.016, .030, .016], .004, ivory, [0, .168, .010], { parent: polarizer });
  box([.004, .015, .004], .001, baffle, [0, .151, .037], { parent: polarizer });
  box([.011, .012, .010], .003, baffle, [0, -.149, .030], { parent: polarizer });
  const polarizerLamp = finish([.05, .045, .04], .5);
  ring(.144, .152, .004, .0012, polarizerLamp, [0, 0, .0305], { parent: polarizer });
  box([.257, .034, .117], .012, slate, [0, .074, .073], staticCaster);
  box([.105, .113, .048], .015, navy, [0, .143, .071], staticCaster);
  ring(.116, .160, .033, .005, slate, [0, aim[1], .067], staticCaster);
  ring(.138, .164, .013, .003, steel, [0, aim[1], .079]);

  const analyzer = engine.createMesh().setPosition(aim);
  const analyzerShell = ring(.117, .162, .021, .005, navy, [0, 0, 0], { parent: analyzer });
  shadows.add(analyzerShell, { static: true });
  ring(.128, .161, .009, .0025, edgeBlue, [0, 0, .017], { parent: analyzer });
  ring(.120, .137, .014, .003, baffle, [0, 0, .018], { parent: analyzer });
  const knurl = block(.0039, .0069, .020, .0015);
  for (let i = 0; i < 68; i++) {
    const theta = i * tau / 68;
    mount(knurl, grip, [-.161 * Math.sin(theta), .161 * Math.cos(theta), .003],
      { rotation: turn(theta), parent: analyzer });
  }
  const mainIndex = block(.0022, .0122, .0024, .0009);
  const minorIndex = block(.0013, .0074, .0022, .0005);
  for (let i = 0; i < 72; i++) {
    const theta = i * tau / 72;
    const radius = i % 6 === 0 ? .145 : .148;
    mount(i % 6 === 0 ? mainIndex : minorIndex, i % 6 === 0 ? ivory : ceramic,
      [-radius * Math.sin(theta), radius * Math.cos(theta), .022], { rotation: turn(theta), parent: analyzer });
  }
  for (const sign of [-1, 1]) box([.023, .016, .008], .003, bronze, [0, sign * .155, .023], { parent: analyzer });
  box([.009, .030, .0015], .0006, ivory, [0, .157, .0275], { parent: analyzer });
  box([.017, .032, .018], .004, ivory, [0, .177, .006], { parent: analyzer });
  box([.0025, .022, .002], .0008, baffle, [0, .179, .0155], { parent: analyzer });
  const analyzerLamp = finish([.05, .045, .04], .5);
  ring(.130, .136, .004, .0012, analyzerLamp, [0, 0, .0255], { parent: analyzer });

  // The circular diffuser shows transmission at the detector. Its etched reticle is stationary.
  const center = [0, aim[1], .119];
  ring(.106, .121, .016, .004, baffle, [0, aim[1], .113]);
  ring(.109, .123, .005, .002, steel, [0, aim[1], .123]);
  const pixels = [];
  function phosphor(shape, at, color, scale) {
    const material = finish(color, .68);
    mount(shape, material, at, { rotation: axial });
    pixels.push({ material, color, scale });
  }
  phosphor(solid(.108, .006), center, [.40, .81, .95], .61);
  for (const [r, width, gain] of [[.108,.003,.87],[.095,.0014,.74],[.073,.0019,1.08],[.031,.0015,.94]]) {
    phosphor(machinedRing(r - width, r, .001, .0004), [0, aim[1], .123], [.54, .88, 1], gain);
  }
  phosphor(solid(.019, .001), [0, aim[1], .124], [.74, .94, 1], 1.06);
  const hairline = finish([.13, .45, .52], .68);
  pixels.push({ material: hairline, color: [.13, .45, .52], scale: .76 });
  const reticle = block(.0022, .041, .0013, .0004);
  for (const theta of [0, tau / 4, tau / 2, tau * .75]) {
    const radius = .057;
    mount(reticle, hairline, [-Math.sin(theta) * radius, aim[1] + Math.cos(theta) * radius, .124],
      { rotation: turn(theta) });
  }

  // A front instrumentation pod and five actual illuminated windows report intensity.
  box([.245, .035, .119], .012, navy, [0, .054, .194], staticCaster);
  box([.201, .006, .072], .003, baffle, [0, .073, .196]);
  const readout = [];
  for (let i = 0; i < 5; i++) {
    const x = .0355 * (i - 2);
    const material = finish([1, .62, .36], .45);
    mount(block(.029, .003, .014, .0014), material, [x, .077, .188]);
    readout.push(material);
  }
  mount(torusGeometry(.014, .002, 8, 30), bronze, [-.091, .076, .228], { rotation: axial });
  mount(fastener, steel, [-.091, .079, .228]);
  mount(torusGeometry(.014, .002, 8, 30), bronze, [.091, .076, .228], { rotation: axial });
  mount(fastener, steel, [.091, .079, .228]);
  mount(cylinderGeometry(.0055, .0055, .004, 18, 1), finish([1, .55, .22], .48), [0, .078, .227]);

  return {
    count,
    update(angles, amplitude, turning) {
      analyzerLamp.set({ color: turning === 'analyzer' ? [1, .66, .30] : [.05, .045, .04] });
      polarizerLamp.set({ color: turning === 'polarizer' ? [1, .66, .30] : [.05, .045, .04] });
      analyzer.setQuaternion(turn(-angles.analyzer * tau / 360));
      polarizer.setQuaternion(turn(-angles.polarizer * tau / 360));
      for (const { material, color, scale } of pixels) {
        material.set({ color: color.map((channel) => .0105 + channel * amplitude * scale * .90) });
      }
      for (let i = 0; i < readout.length; i++) {
        const strength = Math.min(1, Math.max(0, amplitude * readout.length - i));
        readout[i].set({ color: [.033 + strength * .81, .054 + strength * .58, .064 + strength * .34] });
      }
    },
  };
}
