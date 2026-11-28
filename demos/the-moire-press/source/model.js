import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry, torusGeometry } from '@margoengine/geometry/primitives';
import { mergeGeometries, toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { pitch, radians } from './grating.js';

const radius = .243;
const profile = (inside, outside, depth, bevel) => latheGeometry([
  [inside + bevel, -depth / 2], [outside - bevel, -depth / 2],
  [outside, -depth / 2 + bevel], [outside, depth / 2 - bevel],
  [outside - bevel, depth / 2], [inside + bevel, depth / 2],
  [inside, depth / 2 - bevel], [inside, -depth / 2 + bevel], [inside + bevel, -depth / 2],
], 112);

function grating() {
  const foil = [];
  const width = .0061;
  const count = Math.floor((radius - width / 2) / pitch);
  for (let i = -count; i <= count; i++) {
    const center = pitch * i;
    const farEdge = Math.abs(center) + width / 2;
    const length = 2 * Math.sqrt(radius * radius - farEdge * farEdge);
    const rib = roundedBoxGeometry(width, .0011, length, 1, .00012);
    for (let j = 0; j < rib.positions.length; j += 3) rib.positions[j] += center;
    foil.push(rib);
  }
  return mergeGeometries(foil);
}

export function createPress(engine, shadows) {
  let meshes = 0;
  const cached = new WeakMap();
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const desk = finish('#9a8582', .90);
  const enamel = finish('#553c43', .38);
  const black = finish('#333232', .70);
  const foil = finish('#252b2a', .84);
  const trimmedFoil = finish('#33393b', .69);
  const ink = finish('#51525a', .5);
  const metal = finish('#c99659', .34, 1);
  const polished = finish('#ceb08a', .23, 1);
  const paper = finish('#a7e0d7', .77);
  const mark = finish('#ded2b1', .65);
  const rouge = finish('#94504b', .41);
  const blackRubber = finish('#373439', .72);
  const horizontal = { rotation: axisAngleToQuaternion([1, 0, 0], Math.PI / 2) };
  const hingeRotation = axisAngleToQuaternion([0, 0, 1], Math.PI / 2);
  const staticCaster = { cast: true };

  function mount(data, material, position, { parent, rotation, cast } = {}) {
    if (!cached.has(data)) cached.set(data, toGeometry(data));
    const mesh = engine.createMesh(parent).setGeometry(cached.get(data)).setMaterial(material).setPosition(position);
    if (rotation) mesh.setQuaternion(rotation);
    if (cast) shadows.add(mesh, { static: true });
    meshes++;
    return mesh;
  }
  const block = (width, height, depth, bevel) => roundedBoxGeometry(width, height, depth, 3, bevel);
  const box = (dims, bevel, material, at, options) => mount(block(...dims, bevel), material, at, options);
  const disc = (r, depth, material, at, options) => mount(cylinderGeometry(r, r, depth, 56, 1), material, at, options);
  const ring = (inside, outside, depth, bevel, material, at, options) =>
    mount(profile(inside, outside, depth, bevel), material, at, options);

  box([54, .12, 54], .018, desk, [0, -.111, 0]);
  box([.744, .074, .694], .033, enamel, [0, -.002, .010], staticCaster);
  box([.710, .009, .667], .004, polished, [0, .036, .010]);
  box([.690, .014, .651], .006, enamel, [0, .046, .010]);
  for (const x of [-.282, .282]) for (const z of [-.240, .259]) disc(.033, .028, blackRubber, [x, -.038, z], staticCaster);

  // Carrier, opal diffuser and two photo-etched foil stencils.
  const centerDepth = -.018;
  disc(.306, .030, black, [0, .064, centerDepth], staticCaster);
  ring(.242, .300, .030, .007, metal, [0, .090, centerDepth], staticCaster);
  ring(.244, .287, .018, .004, ink, [0, .104, centerDepth], staticCaster);
  ring(.240, .248, .009, .0018, polished, [0, .108, centerDepth]);
  disc(.243, .012, paper, [0, .101, centerDepth]);
  const bladeGeometry = grating();
  mount(bladeGeometry, foil, [0, .1120, centerDepth]);

  // A real hinge raises the entire upper platen, including its angular adjustment.
  const hingeDepth = -.294;
  const lidHeight = .1148;
  for (const x of [-.183, .183]) {
    box([.085, .046, .066], .010, enamel, [x, .076, hingeDepth], staticCaster);
    disc(.027, .067, metal, [x, lidHeight, hingeDepth], { rotation: hingeRotation, cast: true });
    disc(.017, .071, polished, [x, lidHeight, hingeDepth], { rotation: hingeRotation });
  }
  const lid = engine.createMesh().setPosition([0, lidHeight, hingeDepth]);
  const center = [0, 0, centerDepth - hingeDepth];
  for (const x of [-.183, .183]) {
    box([.047, .024, .104], .008, rouge, [x, .011, .057], { parent: lid });
  }
  const collar = ring(.249, .285, .021, .0065, rouge, [0, .006, center[2]], { parent: lid });
  shadows.add(collar);
  ring(.254, .283, .006, .002, polished, [0, .018, center[2]], { parent: lid });
  const rotor = engine.createMesh(lid).setPosition(center);
  ring(.240, .266, .011, .0025, metal, [0, .006, 0], { parent: rotor });
  ring(.241, .259, .005, .0011, black, [0, .012, 0], { parent: rotor });
  mount(bladeGeometry, trimmedFoil, [0, 0, 0], { parent: rotor });
  const pull = box([.056, .023, .057], .007, rouge, [0, .021, .277], { parent: rotor });
  shadows.add(pull);
  box([.008, .0032, .023], .0012, mark, [0, .033, .263], { parent: rotor });
  const large = block(.0028, .0017, .0118, .0004);
  const small = block(.0015, .0017, .0072, .0004);
  for (let index = -8; index <= 8; index++) {
    const angle = radians * index * 2.5;
    mount(index % 2 ? small : large, index % 2 ? black : mark,
      [.276 * Math.sin(angle), .022, center[2] + .276 * Math.cos(angle)],
      { rotation: axisAngleToQuaternion([0, 1, 0], angle), parent: lid });
  }

  // The surrounding controls attach to the base, leaving both mask planes unobstructed.
  const fastener = cylinderGeometry(.0088, .0088, .005, 24, 1);
  const slot = block(.013, .0010, .0021, .00035);
  for (const x of [-.297, .297]) for (const z of [-.252, .253]) {
    box([.071, .009, .056], .004, ink, [x, .054, z]);
    mount(fastener, polished, [x, .062, z]);
    mount(slot, black, [x, .0648, z], { rotation: axisAngleToQuaternion([0, 1, 0], x * 4 - z * 2) });
  }
  box([.167, .003, .039], .0012, metal, [-.162, .055, .321]);
  box([.113, .0015, .002], .0006, mark, [-.161, .057, .315]);
  box([.082, .0015, .0016], .0004, black, [-.176, .057, .325]);
  for (const x of [-.233, -.090]) mount(fastener, black, [x, .056, .321]);
  const knob = [ .217, .073, .316 ];
  disc(.042, .014, black, [.217, .060, .316], staticCaster);
  const dial = engine.createMesh().setPosition(knob);
  disc(.036, .019, metal, [0, 0, 0], { parent: dial });
  disc(.027, .006, rouge, [0, .012, 0], { parent: dial });
  mount(torusGeometry(.026, .0015, 8, 43), polished, [0, .016, 0], { parent: dial, ...horizontal });
  box([.004, .0017, .020], .0006, mark, [0, .017, .016], { parent: dial });

  return {
    meshes,
    update(angle, opening) {
      rotor.setQuaternion(axisAngleToQuaternion([0, 1, 0], angle * radians));
      dial.setQuaternion(axisAngleToQuaternion([0, 1, 0], angle * 8 * radians));
      lid.setQuaternion(axisAngleToQuaternion([1, 0, 0], -.96 * opening));
    },
  };
}
