// Regenerates tests/fixtures/three-reference.json from a real Three.js install. Three.js is not a dependency:
// install it in a scratch folder and pass the path to its module build, for example
//   npm install --prefix /tmp/three-ref three@0.180.0
//   node scripts/three-fixture.js /tmp/three-ref/node_modules/three/build/three.module.js
import {writeFile, mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const T = await import(pathToFileURL(process.argv[2]).href);
const round = a => Array.from(a, x => Math.round(x * 1e5) / 1e5);
const dump = g => ({
  vertices: g.attributes.position.count,
  indices: g.index ? g.index.count : null,
  positions: round(g.attributes.position.array),
  normals: round(g.attributes.normal.array),
  uvs: round(g.attributes.uv.array),
  index: g.index ? Array.from(g.index.array) : null,
  groups: g.groups.map(x => [x.start, x.count, x.materialIndex]),
});

const holey = () => {
  const s = new T.Shape([new T.Vector2(-2, -1), new T.Vector2(2, -1), new T.Vector2(2, 1.5), new T.Vector2(-2, 1.5)]);
  const h = new T.Path(); h.absarc(-0.8, 0.2, 0.4, 0, Math.PI * 2, true);
  s.holes.push(h, new T.Path([new T.Vector2(0.5, -0.5), new T.Vector2(1.5, -0.5), new T.Vector2(1.5, 0.5), new T.Vector2(0.5, 0.5)]));
  return s;
};
const curvePoints = [[0, 0, 0], [1, 2, 0], [1.2, 2.1, 0.3], [3, 1, 1], [4, 4, 2]];
const catmull = (closed, type) => new T.CatmullRomCurve3(curvePoints.map(p => new T.Vector3(...p)), closed, type);
const pts = c => c.map(p => round(p.toArray()));

const fixture = {
  three: T.REVISION,
  primitives: {
    box: dump(new T.BoxGeometry(1, 2, 3, 2, 1, 3)),
    plane: dump(new T.PlaneGeometry(2, 3, 2, 3)),
    circle: dump(new T.CircleGeometry(1.5, 7, 0.3, 4)),
    ring: dump(new T.RingGeometry(0.3, 1.2, 7, 2, 0.2, 5)),
    cylinder: dump(new T.CylinderGeometry(0.5, 1, 2, 7, 2, false, 0.1, 5)),
    cone: dump(new T.ConeGeometry(1, 2, 6, 2)),
    sphere: dump(new T.SphereGeometry(1, 8, 6)),
    spherePartial: dump(new T.SphereGeometry(1.2, 7, 5, 0.1, 5, 0.2, 2.5)),
    capsule: dump(new T.CapsuleGeometry(0.5, 1, 3, 6, 2)),
    torus: dump(new T.TorusGeometry(1, 0.3, 5, 9, 5)),
    torusKnot: dump(new T.TorusKnotGeometry(1, 0.3, 12, 5, 2, 3)),
    tetrahedron: dump(new T.TetrahedronGeometry(1, 1)),
    octahedron: dump(new T.OctahedronGeometry(1.5, 0)),
    icosahedron: dump(new T.IcosahedronGeometry(1, 1)),
    dodecahedron: dump(new T.DodecahedronGeometry(1, 0)),
    lathe: dump(new T.LatheGeometry([[0.2, -1], [1, -0.5], [0.8, 0.5], [0.3, 1]].map(p => new T.Vector2(...p)), 7, 0.2, 5)),
    tube: dump(new T.TubeGeometry(catmull(false, 'centripetal'), 10, 0.2, 5, false)),
    shape: dump(new T.ShapeGeometry(holey(), 6)),
    extrude: dump(new T.ExtrudeGeometry(holey(), {curveSegments: 6, depth: 0.5, bevelSegments: 2, bevelThickness: 0.1, bevelSize: 0.05})),
    extrudeFlat: dump(new T.ExtrudeGeometry(holey(), {curveSegments: 6, depth: 0.7, steps: 2, bevelEnabled: false})),
  },
  curves: {
    centripetal: pts(catmull(false, 'centripetal').getPoints(12)),
    chordal: pts(catmull(false, 'chordal').getPoints(12)),
    catmullrom: pts(catmull(false, 'catmullrom').getPoints(12)),
    closed: pts(catmull(true, 'centripetal').getPoints(12)),
    spaced: pts(catmull(false, 'centripetal').getSpacedPoints(12)),
    ellipse: pts(new T.EllipseCurve(1, 2, 3, 1.5, 0.3, 4, true, 0.4).getPoints(10)),
    pathPoints: pts(new T.Path().moveTo(0, 0).lineTo(1, 0).quadraticCurveTo(2, 0, 2, 1).bezierCurveTo(2, 2, 1, 2, 0, 2).splineThru([new T.Vector2(-1, 1), new T.Vector2(0, 0)]).getPoints(5)),
    frames: (() => {const f = catmull(false, 'centripetal').computeFrenetFrames(8, false); return {tangents: pts(f.tangents), normals: pts(f.normals), binormals: pts(f.binormals)};})(),
    framesClosed: (() => {const f = catmull(true, 'centripetal').computeFrenetFrames(8, true); return {normals: pts(f.normals), binormals: pts(f.binormals)};})(),
  },
};
await mkdir(new URL('../tests/fixtures/', import.meta.url), {recursive: true});
await writeFile(new URL('../tests/fixtures/three-reference.json', import.meta.url), JSON.stringify(fixture));
console.log(`wrote Three.js r${T.REVISION} reference`);
