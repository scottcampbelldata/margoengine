import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { extrudeGeometry, shapeGeometry } from '@margoengine/geometry/extrude';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { Shape, Path } from '@margoengine/geometry/shapes';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { axisHeight, projectPoint, relativeExposure } from './optics.js';
import { harbor, markers } from './harbor.js';

const face = axisAngleToQuaternion([0, 1, 0], Math.PI / 2);
const opticalCylinder = axisAngleToQuaternion([0, 0, 1], -Math.PI / 2);
const pinhole = [0, axisHeight, 0];
const plateSurface = .009;

function apertureBoard() {
  const outline = new Shape([[-.212,-.193],[.212,-.193],[.212,.188],[-.212,.188]]);
  const hole = new Path();
  hole.absarc(0, 0, .016, 0, Math.PI * 2, true);
  outline.holes.push(hole);
  return extrudeGeometry(outline, { depth: .019, bevelEnabled: true, bevelSize: .004, bevelThickness: .004,
    bevelSegments: 2, curveSegments: 40 });
}

function plateRing(inner, outer, depth) {
  const bevel = .0018, edge = depth / 2;
  return latheGeometry([
    [inner + bevel, -edge], [outer - bevel, -edge], [outer, -edge + bevel], [outer, edge - bevel],
    [outer - bevel, edge], [inner + bevel, edge], [inner, edge - bevel], [inner, -edge + bevel], [inner + bevel, -edge],
  ], 64);
}

export function createCamera(engine, shadows) {
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const plinth = finish('#453d34', .48);
  const lean = finish('#6f5845', .52);
  const walnut = finish('#533731', .45);
  const endGrain = finish('#6b4840', .56);
  const gray = finish('#454848', .58);
  const paper = finish('#3c4543', .69);
  const felt = finish('#31342f', .82);
  const copper = finish('#a8784f', .28, 1);
  const bronze = finish('#bc935e', .38, 1);
  const steel = finish('#c0c2ac', .30, 1);
  const ivory = finish('#dbcca7', .54);
  const ground = finish('#595461', .82);
  const geometries = new WeakMap();
  let meshes = 0;

  function mount(spec, material, at, { parent, rotation, cast } = {}) {
    if (!geometries.has(spec)) geometries.set(spec, toGeometry(spec));
    const mesh = engine.createMesh(parent).setGeometry(geometries.get(spec)).setMaterial(material).setPosition(at);
    if (rotation) mesh.setQuaternion(rotation);
    if (cast) shadows.add(mesh, { static: true });
    meshes++;
    return mesh;
  }
  const block = (x, y, z, bevel) => roundedBoxGeometry(x, y, z, 3, bevel);
  const box = (dims, bevel, material, at, options) => mount(block(...dims, bevel), material, at, options);
  const disk = (r, length, material, at, options) =>
    mount(cylinderGeometry(r, r, length, 48, 1), material, at, options);
  const fixed = { cast: true };

  box([40, .12, 40], .019, ground, [0, -.117, 0]);
  box([1.468, .071, .672], .031, plinth, [-.122, -.004, .002], fixed);
  box([1.425, .010, .633], .005, steel, [-.122, .032, .002]);
  box([1.404, .015, .615], .007, walnut, [-.122, .042, .002]);
  for (const x of [-.728, .463]) for (const z of [-.240, .243]) disk(.039, .031, felt, [x, -.043, z], fixed);

  // The raised lightbox carries the actual layers of glass and a separate sculpted frame.
  const sceneX = -.675;
  box([.107, .355, .402], .022, plinth, [sceneX - .042, axisHeight, 0], fixed);
  box([.080, .343, .383], .016, endGrain, [sceneX - .019, axisHeight, 0], fixed);
  for (const z of [-.179,.179]) {
    box([.058,.319,.025], .007, bronze, [sceneX + .065, axisHeight, z], fixed);
    box([.053,.048,.063], .012, walnut, [sceneX + .011, .072, z], fixed);
  }
  for (const y of [-.151,.153]) {
    box([.059,.022,.370], .007, bronze, [sceneX + .064, axisHeight + y, 0], fixed);
    box([.032,.008,.352], .0038, steel, [sceneX + .084, axisHeight + y - .003, 0]);
  }
  const footer = [-.632,.093,.216];
  box([.161,.022,.096], .008, endGrain, footer, fixed);
  box([.116,.006,.069], .0025, bronze, [footer[0],.108,footer[2]]);

  // The pinhole is cut out of the aperture board and holds an actual bored brass insert.
  mount(apertureBoard(), walnut, [-.019, axisHeight, 0], { rotation: face, cast: true });
  const hole = plateRing(.006, .038, .016);
  mount(hole, bronze, [0, axisHeight, 0], { rotation: opticalCylinder, cast: true });
  mount(plateRing(.013,.052,.0042), copper, [.008,axisHeight,0], { rotation: opticalCylinder });
  mount(plateRing(.038,.049,.0045), bronze, [.012,axisHeight,0], { rotation: opticalCylinder });
  mount(plateRing(.012,.048,.0052), steel, [-.027,axisHeight,0], { rotation: opticalCylinder });
  box([.028,.028,.453], .010, endGrain, [-.009,.460,0], fixed);
  box([.041,.028,.449], .009, endGrain, [-.003,.074,0], fixed);
  box([.013,.312,.017], .004, copper, [.005,.268,.204]);
  box([.013,.312,.017], .004, copper, [.005,.268,-.201]);

  // The left side and top are cut away to reveal the brass guides and sliding plate.
  box([.565,.032,.466], .013, walnut, [.263,.082,0], fixed);
  box([.550,.015,.432], .007, felt, [.260,.100,0]);
  box([.550,.179,.037], .016, walnut, [.268,.184,-.214], fixed);
  box([.550,.017,.056], .007, endGrain, [.267,.271,-.214], fixed);
  box([.548,.061,.046], .016, endGrain, [.266,.131,.218], fixed);
  box([.533,.005,.041], .0024, bronze, [.265,.163,.218]);
  for (const z of [-.154,.154]) {
    box([.510,.012,.023], .003, gray, [.248,.112,z]);
    box([.510,.008,.010], .0033, steel, [.247,.120,z], fixed);
  }
  const screw = cylinderGeometry(.0081,.0081,.006,22,1);
  const slot = block(.010,.001,.0021,.0004);
  for (const y of [.110,.427]) for (const z of [-.178,.178]) {
    mount(screw, bronze, [.005,y,z], { rotation: opticalCylinder });
    box([.0014,.010,.0019], .0006, felt, [.0084,y,z]);
  }
  for (const x of [.046,.494]) for (const z of [-.183,.184]) {
    mount(screw, copper, [x,.111,z]);
    mount(slot, felt, [x,.1141,z], { rotation: axisAngleToQuaternion([0,1,0], x * 3 + z * 4) });
  }
  for (let index = 0; index < 29; index++) {
    const tick = index % 4 === 0;
    box([.0025,.0018,tick ? .018 : .010], .0006, tick ? ivory : gray, [.16 + index * .010,.166,.220]);
  }
  box([.072,.006,.072], .003, gray, [.485,.054,.246]);
  disk(.026,.028,bronze,[.484,.074,.246],fixed);
  disk(.018,.005,copper,[.484,.090,.246]);
  const handwheel = engine.createMesh().setPosition([.484,.094,.246]);
  box([.0035,.0017,.025], .00065, ivory, [0,0,.008], { parent: handwheel });

  const plate = engine.createMesh().setPosition([.300, axisHeight, 0]);
  box([.025,.056,.393], .009, gray, [0,-.154,0], { parent: plate });
  box([.014,.022,.409], .006, walnut, [0,+.159,0], { parent: plate });
  const screen = box([.012,.299,.368], .004, paper, [0,0,0], { parent: plate });
  shadows.add(screen);
  for (const z of [-.198,.198]) {
    box([.022,.333,.019], .005, bronze, [0,0,z], { parent: plate });
    box([.067,.018,.025], .006, gray, [0,-.151,z * .78], { parent: plate });
  }
  box([.032,.020,.013], .004, ivory, [0,-.112,.222], { parent: plate });
  box([.026,.008,.035], .003, copper, [0,.173,0], { parent: plate });
  const print = engine.createMesh(plate);
  const pigments = [];
  const sorted = harbor.slice().sort((a, b) => b.d - a.d);
  for (const [i, { d, shape, color }] of sorted.entries()) {
    const solid = extrudeGeometry(new Shape(shape), { depth: .00075, bevelEnabled: false });
    mount(solid, finish(color,.68), [-d,axisHeight,0], { rotation: face });
    const footprint = shape.map(([u,v]) => projectPoint(u,v,d,1));
    const material = finish(color, .83);
    mount(shapeGeometry(new Shape(footprint)), material, [plateSurface + i * .00018,0,0],
      { parent: print, rotation: face });
    const average = shape.reduce(([x,y],[u,v]) => [x + u / shape.length, y + v / shape.length], [0,0]);
    pigments.push({ material, color, slope: Math.hypot(...average) / d });
  }

  // Thin, optional geometry guides run exactly through the aperture center.
  const rayGeometry = cylinderGeometry(.00165, .00165, 1, 12, 1);
  const rayColors = [finish('#dcbf78',.52), finish('#f28260',.56), finish('#a7dbc9',.55)];
  const rays = Object.values(markers).map(([u,v,d], index) => ({
    u,v,d, source: [-d,axisHeight + v,-u],
    inlet: mount(rayGeometry, rayColors[index], pinhole),
    outlet: mount(rayGeometry, rayColors[index], pinhole),
  }));

  function segment(mesh, from, to) {
    const offset = to.map((value, i) => value - from[i]);
    const length = Math.hypot(...offset);
    const cross = [offset[2],0,-offset[0]];
    const norm = Math.hypot(...cross);
    const quaternion = norm ? axisAngleToQuaternion(cross.map((value) => value / norm),
      Math.acos(offset[1] / length)) : axisAngleToQuaternion([0,0,1], offset[1] < 0 ? Math.PI : 0);
    mesh.setPosition(from.map((value, i) => (value + to[i]) / 2)).setQuaternion(quaternion).setScale([1,length,1]);
  }
  for (const ray of rays) segment(ray.inlet, ray.source, pinhole);

  return {
    meshes,
    update(distance, showRays) {
      plate.setPosition([distance, axisHeight, 0]);
      print.setScale([1,distance,distance]);
      handwheel.setQuaternion(axisAngleToQuaternion([0,1,0], (distance - .16) * 20));
      for (const { material, color, slope } of pigments) {
        const exposure = relativeExposure(distance, slope);
        material.set({ color: color.map((value) => .036 + .93 * value * exposure) });
      }
      for (const ray of rays) {
        ray.inlet.visible = ray.outlet.visible = showRays;
        if (showRays) {
          const [u,v] = projectPoint(ray.u, ray.v, ray.d, distance);
          segment(ray.outlet, pinhole, [distance,axisHeight + v,-u]);
        }
      }
    },
  };
}
