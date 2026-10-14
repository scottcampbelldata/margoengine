// Proof for @margoengine/geometry: the per-vertex and per-triangle utilities (normals, tangents, transforms, welding,
// de-indexing, edges, PBR vertex packing), the polyhedron/extrude emitters and Bezier/line/Catmull-Rom evaluation no
// longer build temporary arrays, strings or closures per element. Every output must match the baseline bit for bit.
// Run: node examples/package-benchmarks/proofs/geometry.proof.js
import assert from 'node:assert/strict';
import {versions, time, record} from './compare.js';

const ref = 'f05414a', {baseline, candidate} = await versions('geometry', ref);
const outcome = run => {try {return run();} catch (error) {return `${error.constructor.name}: ${error.message}`;}};
/** Runs the same expression against both builds and requires identical results (typed arrays compare by bits). */
const same = (label, run) => assert.deepStrictEqual(outcome(() => run(candidate)), outcome(() => run(baseline)), label);

// A terrain-style heightfield, as @margoengine/terrain's heightfieldGeometry builds it: 192 x 192 cells, 37,249 vertices.
const heightfield = (g, cells = 192) => {
  const data = g.planeGeometry(400, 400, cells, cells);
  for (let i = 0; i < data.positions.length; i += 3) {const x = data.positions[i], z = -data.positions[i + 1]; data.positions[i + 1] = Math.sin(x * 0.05) * 12 + Math.cos(z * 0.07) * 9 + Math.sin((x + z) * 0.31) * 1.5; data.positions[i + 2] = z;}
  return data;
};
const gear = g => {
  const points = Array.from({length: 48}, (_, i) => {const a = i / 48 * Math.PI * 2, r = i % 4 < 2 ? 3 : 2.4; return [Math.cos(a) * r, Math.sin(a) * r];});
  const shape = new g.Shape(points); shape.holes.push(new g.Path().absarc(0, 0, 1, 0, Math.PI * 2, true)); return shape;
};
const matrix = [0.6, 0.2, -0.77, 0, -0.3, 1.4, 0.1, 0, 0.9, 0.05, 0.8, 0, 3, -2, 7, 1];
const mirror = [-1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.5, 0, 1, 2, 3, 1], projective = [1, 0, 0, 0.1, 0, 1, 0, 0.2, 0, 0, 1, -0.05, 0, 0, 0, 1];
// The meshes every utility is checked on: indexed and non-indexed, with groups, seams, poles, flat caps and holes.
const meshes = {
  heightfield: g => heightfield(g, 48), sphere: g => g.sphereGeometry(1, 48, 24), 'half sphere': g => g.sphereGeometry(2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  box: g => g.boxGeometry(1, 2, 3, 2, 3, 4), cylinder: g => g.cylinderGeometry(0.5, 1, 2, 24, 3), cone: g => g.coneGeometry(1, 2, 12, 2), capsule: g => g.capsuleGeometry(1, 1, 4, 10),
  'torus knot': g => g.torusKnotGeometry(1, 0.4, 64, 8), icosahedron: g => g.icosahedronGeometry(1, 2), 'flat dodecahedron': g => g.dodecahedronGeometry(2, 0), extrude: g => g.extrudeGeometry(gear(g), {depth: 0.5}),
  // Degenerate input: a zero-area triangle, repeated vertices, a non-finite vertex and an index past the end.
  degenerate: () => ({positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, NaN, 1, 1, 1e-5, 0, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0.5, 0.5, 0, 0]), indices: new Uint32Array([0, 1, 2, 0, 1, 3, 4, 3, 1, 5, 0, 3, 6, 1, 3, 0, 9, 1])}),
  empty: () => ({positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0)}),
};
for (const [name, make] of Object.entries(meshes)) {
  const tangents = g => g.computeTangents(make(g));
  same(`${name} computeVertexNormals`, g => g.computeVertexNormals(make(g)));
  same(`${name} computeTangents`, tangents);
  for (const m of [matrix, mirror, projective, new Float32Array(matrix)]) {same(`${name} applyMatrix4`, g => g.applyMatrix4(make(g), m)); same(`${name} applyMatrix4 with tangents`, g => g.applyMatrix4(tangents(g), m));}
  for (const options of [undefined, {positionOnly: true}, {removeDegenerate: true}, {tolerance: 0.05, positionOnly: true, removeDegenerate: true}, {tolerance: 0}, {tolerance: 1e-7}, {tolerance: 3}])
    {same(`${name} mergeVertices ${JSON.stringify(options)}`, g => g.mergeVertices(make(g), options)); same(`${name} mergeVertices with tangents`, g => g.mergeVertices(tangents(g), options));}
  same(`${name} toNonIndexed`, g => g.toNonIndexed(make(g))); same(`${name} toNonIndexed with tangents`, g => g.toNonIndexed(tangents(g)));
  for (const angle of [1, 30, 89, 180]) same(`${name} edgesGeometry ${angle}`, g => g.edgesGeometry(make(g), angle));
  same(`${name} bounds`, g => [g.computeBoundingBox(make(g)), g.computeBoundingSphere(make(g)), g.center(make(g))]);
  same(`${name} wireframe`, g => [g.wireframe(make(g)), g.wireframePositions(make(g), 0.01)]);
  same(`${name} pbrVertexStream`, g => [g.pbrVertexStream(tangents(g)), g.pbrVertexStream(tangents(g), (x, y, z) => Math.min(1, Math.abs(Math.sin(x + y * 2 + z * 3)))), outcome(() => g.pbrVertexStream(make(g))), outcome(() => g.pbrVertexStream(tangents(g), () => 2))]);
  same(`${name} loopSubdivide`, g => g.loopSubdivide(make(g), 1));
  same(`${name} mergeGeometries`, g => g.mergeGeometries([make(g), g.applyMatrix4(make(g), matrix)], true));
}
same('applyMatrix4 rejections', g => [outcome(() => g.applyMatrix4(meshes.box(g), [1, 2, 3])), outcome(() => g.applyMatrix4(meshes.box(g), new Array(16).fill(0))), outcome(() => g.applyMatrix4(meshes.box(g), new Array(16).fill(NaN)))]);
// Welding vertices far from the origin and with huge cell coordinates, where neighbouring cells stop being distinct.
same('mergeVertices far from origin', g => {const data = g.applyMatrix4(g.icosahedronGeometry(1, 2), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5e5, -3e6, 9e6, 1]); return [g.mergeVertices(data), g.mergeVertices(data, {tolerance: 1e-12, positionOnly: true})];});
for (const kind of ['tetrahedronGeometry', 'octahedronGeometry', 'icosahedronGeometry', 'dodecahedronGeometry']) for (let detail = 0; detail <= 4; detail++)
  same(`${kind} ${detail}`, g => [g[kind](1.5, detail), g[kind](1, detail, true), g[kind](2, detail, false), outcome(() => g[kind](1, detail, 1))]);
const sweep = g => new g.CatmullRomCurve3([[0, 0, 0], [2, 3, 1], [5, 3, -2], [8, 0, 0]]);
for (const options of [undefined, {depth: 2, bevelEnabled: false, steps: 4}, {bevelThickness: 0.3, bevelSize: 0.2, bevelOffset: 0.05, bevelSegments: 5, curveSegments: 24}, {steps: 0.5, depth: 0}])
  same(`extrudeGeometry ${JSON.stringify(options)}`, g => [g.extrudeGeometry(gear(g), options), g.extrudeGeometry([gear(g), new g.Shape([[5, 0], [6, 0], [6, 1], [5, 1]])], options), g.shapeGeometry([gear(g)])]);
same('extrudeGeometry along a path', g => g.extrudeGeometry(gear(g), {steps: 40, extrudePath: sweep(g)}));

// Curves: every kind in 2D and 3D, open and closed, plus typed-array control points (which keep the generic path).
const knots = Array.from({length: 20}, (_, i) => [Math.cos(i * 0.9) * (4 + i % 3), i * 0.6, Math.sin(i * 0.9) * (4 + i % 5)]);
const glyph = g => {
  const shape = new g.Shape().moveTo(0, 0);
  for (let i = 0; i < 12; i++) {const a = i / 12 * Math.PI * 2, b = (i + 1) / 12 * Math.PI * 2, m = (a + b) / 2; if (i % 3 === 0) shape.lineTo(Math.cos(b) * 5, Math.sin(b) * 5); else if (i % 3 === 1) shape.quadraticCurveTo(Math.cos(m) * 7, Math.sin(m) * 7, Math.cos(b) * 5, Math.sin(b) * 5); else shape.bezierCurveTo(Math.cos(a) * 7, Math.sin(a) * 7, Math.cos(m) * 3, Math.sin(m) * 3, Math.cos(b) * 5, Math.sin(b) * 5);}
  shape.holes.push(new g.Path().moveTo(1, 0).quadraticCurveTo(1, 1, 0, 1).quadraticCurveTo(-1, 1, -1, 0).quadraticCurveTo(-1, -1, 0, -1).quadraticCurveTo(1, -1, 1, 0)); return shape;
};
const curves = {
  line: g => new g.LineCurve([0, 1], [4, -2]), line3: g => new g.LineCurve3([0, 1, 2], [4, -2, 9]), quadratic: g => new g.QuadraticBezierCurve([0, 0], [2, 5], [6, 1]), quadratic3: g => new g.QuadraticBezierCurve3([0, 0, 0], [2, 5, -3], [6, 1, 2]),
  cubic: g => new g.CubicBezierCurve([0, 0], [1, 4], [5, -4], [6, 1]), cubic3: g => new g.CubicBezierCurve3([0, 0, 0], [1, 4, 2], [5, -4, -1], [6, 1, 3]), 'cubic3 typed': g => new g.CubicBezierCurve3(new Float32Array([0, 0, 0]), new Float32Array([1, 4, 2]), new Float32Array([5, -4, -1]), new Float32Array([6, 1, 3])),
  'quadratic typed': g => new g.QuadraticBezierCurve(new Float64Array([0, 0]), new Float64Array([2, 5]), new Float64Array([6, 1])), spline: g => new g.SplineCurve(knots.map(p => [p[0], p[2]])), ellipse: g => new g.EllipseCurve(1, 2, 3, 2, 0.3, 4, true, 0.5), arc: g => new g.ArcCurve(0, 0, 2),
  centripetal: g => new g.CatmullRomCurve3(knots), 'centripetal closed': g => new g.CatmullRomCurve3(knots, true), chordal: g => new g.CatmullRomCurve3(knots, false, 'chordal'), uniform: g => new g.CatmullRomCurve3(knots, true, 'catmullrom', 0.3), 'two knots': g => new g.CatmullRomCurve3(knots.slice(0, 2)), glyph,
};
for (const [name, make] of Object.entries(curves)) {
  same(`${name} sampling`, g => {const c = make(g); return [c.getPoints(37), c.getSpacedPoints(29), c.getLengths(), c.getLength(), [0, 0.123, 0.5, 0.999, 1].map(u => [c.getPoint(u), c.getPointAt(u), c.getTangent(u), c.getTangentAt(u), c.getUtoTmapping(u)])];});
  same(`${name} frames`, g => [make(g).computeFrenetFrames(33, false), make(g).computeFrenetFrames(16, true)]);
  same(`${name} tube`, g => [g.tubeGeometry(make(g), 40, 0.3, 7, false), g.tubeGeometry(make(g), 12, 1, 3, true)]);
}
same('shape extraction', g => [glyph(g).extractPoints(12), glyph(g).extractPoints(3), g.shapeGeometry(glyph(g), 12), g.extrudeGeometry(glyph(g), {steps: 30, extrudePath: curves.centripetal(g)}), g.latheGeometry(curves.spline(g).getPoints(20), 24)]);

const cases = [], bench = (name, runs, prepare, run) => {
  const a = prepare(baseline), b = prepare(candidate);
  cases.push({case: `${name} x ${runs}`, ...time(() => {for (let i = 0; i < runs; i++) run(baseline, a);}, () => {for (let i = 0; i < runs; i++) run(candidate, b);})});
};
const field = g => heightfield(g), ball = g => g.computeTangents(g.sphereGeometry(1, 128, 64));
bench('computeVertexNormals, 192x192 heightfield (73,728 triangles)', 4, field, (g, data) => g.computeVertexNormals(data));
bench('computeTangents, 192x192 heightfield', 4, field, (g, data) => g.computeTangents(data));
bench('computeTangents, 128x64 sphere (8,385 vertices)', 20, ball, (g, data) => g.computeTangents(data));
// Procedural props place dozens of parts each through applyMatrix4: 100 placements of an 8,385-vertex part with tangents.
bench('applyMatrix4 with tangents, 128x64 sphere', 100, ball, (g, data) => g.applyMatrix4(data, matrix));
// Welding a non-indexed polyhedron for smooth normals (generateRockMesh does this): 15,360 corners down to 2,562 points.
bench('mergeVertices positionOnly, icosahedron detail 4', 5, g => g.icosahedronGeometry(1, 4), (g, data) => g.mergeVertices(data, {positionOnly: true}));
bench('mergeVertices all attributes, 192x192 heightfield', 2, field, (g, data) => g.mergeVertices(data));
bench('toNonIndexed with tangents, 128x64 sphere', 20, ball, (g, data) => g.toNonIndexed(data));
bench('edgesGeometry, 128x64 sphere', 5, ball, (g, data) => g.edgesGeometry(data, 1));
bench('pbrVertexStream with occlusion, 128x64 sphere', 50, ball, (g, data) => g.pbrVertexStream(data, (x, y) => 0.5 + y * 0.25));
// A broadleaf tree is 15 icosahedron lobes at detail 3; detail 5 is a smooth planet-sized sphere.
bench('icosahedronGeometry detail 3', 15, () => 0, g => g.icosahedronGeometry(1, 3));
bench('icosahedronGeometry detail 5', 2, () => 0, g => g.icosahedronGeometry(1, 5));
// A beveled gear with a round hole at 24 points per curve segment, the shape of extruded logo/text geometry.
bench('extrudeGeometry, beveled gear with hole', 20, gear, (g, shape) => g.extrudeGeometry(shape, {depth: 0.5, curveSegments: 24, bevelSegments: 5}));
// A cable or rail along a 20-knot path: its arc-length frames and evenly spaced samples (tubeGeometry and path followers use both).
bench('computeFrenetFrames(256), 20-knot Catmull-Rom', 20, () => 0, g => new g.CatmullRomCurve3(knots).computeFrenetFrames(256));
bench('getSpacedPoints(2000), 20-knot Catmull-Rom', 20, () => 0, g => new g.CatmullRomCurve3(knots).getSpacedPoints(2000));
// Outline extraction for a line of text: 60 glyph-like contours of lines, quadratic and cubic Beziers with a counter.
bench('Shape.extractPoints, 60 glyph outlines', 10, g => Array.from({length: 60}, () => glyph(g)), (g, shapes) => {for (const shape of shapes) shape.extractPoints(12);});
bench('CubicBezierCurve3.getSpacedPoints(64), fresh curve', 50, () => 0, g => new g.CubicBezierCurve3([0, 0, 0], [1, 4, 2], [5, -4, -1], [6, 1, 3]).getSpacedPoints(64));
await record('geometry', ref, cases, 'All outputs are bit-identical, including degenerate triangles, non-finite vertices and out-of-range indices. Measured and reverted for missing the 1.10x bar: scalar computeBoundingBox (1.03-1.07x on computeBoundingSphere) and a loopSubdivide edge-point rewrite (about 1.08x). tubeGeometry as a whole is unchanged within noise; only its frame and curve sampling got faster.');
