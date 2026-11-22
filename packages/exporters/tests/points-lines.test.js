// exportModel keeps a loaded model's glTF points and lines (glTF 2.0 section 3.7.2.1 primitive modes) and writes strip,
// loop and fan sources as the lists gltf/pbr decodes them to, indexed: a re-import with gltf/pbr reads the same
// vertices, indices, topologies and materials. The scene writers with a point or line form (glTF, OBJ, PLY, COLLADA,
// USDZ, the animated USDZ) write them; the rest (STL, 3MF, Roblox) warn instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTFAsync } from '@margoengine/gltf/pbr';
import { exportModel } from '../dist/model.js';
import { exportDAE, exportGLB, exportGLTF, exportOBJ, exportPLY, exportSTL } from '../dist/index.js';
import { exportRobloxGLB } from '../dist/roblox.js';
import { exportAnimatedUSDZ } from '../dist/usdz-anim.js';
import { createGodotImportBundle } from '../dist/godot.js';
import { createUnityImportBundle } from '../dist/unity.js';
import { parseDAE, parseOBJ, parsePLY, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { exportUSDZ } from '../dist/usdz.js';
import { parseUSDZ } from '@margoengine/usdz';
import { curves } from '@margoengine/usdz/curves';
import { GLTFAsset } from '@margoengine/gltf/asset';
import { headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { materialEngine as headless, readGLB, validate } from './helpers.js';

/** A GLB from `json` with one buffer holding `arrays` back to back, one bufferView each (4-byte aligned). */
function glb(json, arrays) {
  const views = [];
  let length = 0;
  for (const a of arrays) {
    views.push({ buffer: 0, byteOffset: length, byteLength: a.byteLength });
    length += Math.ceil(a.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(length);
  arrays.forEach((a, i) => bin.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), views[i].byteOffset));
  const text = new TextEncoder().encode(
      JSON.stringify({ ...json, buffers: [{ byteLength: length }], bufferViews: views }),
    ),
    jsonLength = Math.ceil(text.length / 4) * 4,
    out = new Uint8Array(12 + 8 + jsonLength + 8 + length),
    dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  dv.setUint32(20 + jsonLength, length, true);
  dv.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

const vec3 = (count, view, values) => ({
  bufferView: view,
  componentType: 5126,
  count,
  type: 'VEC3',
  min: [0, 1, 2].map((k) => Math.min(...values.filter((_, i) => i % 3 === k))),
  max: [0, 1, 2].map((k) => Math.max(...values.filter((_, i) => i % 3 === k))),
});

/** One mesh of a triangle, a coloured point cloud and an indexed line strip; a second mesh: an unindexed triangle strip. */
function source() {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0],
    points = [2, 0, 0, 2, 1, 0, 2, 2, 0, 2, 3, 1],
    colors = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0.5],
    strip = [3, 0, 0, 4, 0, 0, 4, 1, 0, 3, 1, 0],
    stripIndices = [0, 1, 2, 3],
    triStrip = [5, 0, 0, 6, 0, 0, 5, 1, 0, 6, 1, 0, 5, 2, 0];
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'mixed', mesh: 0 },
      { name: 'strip', mesh: 1, translation: [0, 0, 1] },
    ],
    materials: [
      { name: 'surface', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1] } },
      { name: 'dots', pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0.25, 1], metallicFactor: 0 } },
      { name: 'wire', emissiveFactor: [0, 1, 0], pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1] } },
    ],
    accessors: [
      vec3(3, 0, tri),
      vec3(4, 1, points),
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC4' },
      vec3(4, 3, strip),
      { bufferView: 4, componentType: 5125, count: 4, type: 'SCALAR' },
      vec3(5, 5, triStrip),
    ],
    meshes: [
      {
        name: 'mixed',
        primitives: [
          { attributes: { POSITION: 0 }, material: 0 },
          { attributes: { POSITION: 1, COLOR_0: 2 }, material: 1, mode: 0 },
          { attributes: { POSITION: 3 }, indices: 4, material: 2, mode: 3 },
        ],
      },
      { name: 'strip', primitives: [{ attributes: { POSITION: 5 }, material: 0, mode: 5 }] },
    ],
  };
  return glb(json, [
    new Float32Array(tri),
    new Float32Array(points),
    new Float32Array(colors),
    new Float32Array(strip),
    new Uint32Array(stripIndices),
    new Float32Array(triStrip),
  ]);
}

const all = (model) => [...model.primitives, ...model.pointsAndLines];
const position = (p) =>
  Array.from({ length: p.vertices.length / 20 }, (_, i) => [...p.vertices.subarray(i * 20, i * 20 + 3)]);

test('exportModel writes loaded points and lines, and strips as indexed lists', () =>
  headlessModels(async () => {
    const input = source(),
      model = await parseGLTFAsync(await headless(), input.slice());
    assert.equal(model.pointsAndLines.length, 2);
    const out = await exportModel(model, { binary: true }),
      report = await validate(out);
    assert.equal(report.errors, 0, JSON.stringify(report.messages.slice(0, 5), null, 1));
    const { json } = readGLB(out);
    assert.deepEqual(
      json.meshes.map((m) => m.primitives.map((p) => p.mode ?? 4)),
      [[4, 0, 1], [4]],
      'glTF modes in source order: strips and loops become lists',
    );
    assert.deepEqual(
      json.meshes[0].primitives.map((p) => json.materials[p.material].name),
      ['surface', 'dots', 'wire'],
    );
    assert.deepEqual(json.materials[1].pbrMetallicRoughness.baseColorFactor, [1, 0.5, 0.25, 1]);
    assert.deepEqual(json.materials[2].emissiveFactor, [0, 1, 0]);
    assert.ok(json.meshes[0].primitives[1].attributes.COLOR_0 !== undefined, 'point colours kept');
    assert.ok(
      json.meshes[1].primitives[0].indices !== undefined,
      'an unindexed triangle strip is written as an indexed list',
    );

    const copy = await parseGLTFAsync(await headless(), out);
    assert.deepEqual(
      copy.pointsAndLines.map((p) => p.topology),
      model.pointsAndLines.map((p) => p.topology),
    );
    const a = all(model),
      b = all(copy);
    assert.equal(b.length, a.length);
    a.forEach((p, i) => {
      assert.equal(b[i].nodeIndex, p.nodeIndex, `primitive ${i} node`);
      assert.deepEqual(position(b[i]), position(p), `primitive ${i} positions`);
      assert.deepEqual(Array.from(b[i].indices), Array.from(p.indices), `primitive ${i} indices`);
      // Packed colour floats 16 to 19 carry COLOR_0.
      for (let v = 0; v < p.vertices.length; v += 20)
        assert.deepEqual([...b[i].vertices.subarray(v + 16, v + 20)], [...p.vertices.subarray(v + 16, v + 20)]);
    });
    assert.deepEqual(Array.from(model.pointsAndLines[1].indices), [0, 1, 1, 2, 2, 3]);
  }));

test('engine scene exporters warn for the points and lines they cannot write', () =>
  headlessModels(async () => {
    const engine = await headless(),
      model = await parseGLTFAsync(engine, source());
    const warnings = [];
    // Roblox meshes are triangles: its GLB keeps the warning, now passed through to the caller's onWarning.
    const roblox = exportRobloxGLB(engine, { onWarning: (w) => warnings.push(w) });
    assert.ok(roblox.glb.byteLength > 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'unsupported');
    assert.match(warnings[0].message, /2 point or line primitives/);
    assert.equal(warnings[0].node, model.nodes[0]);
    assert.deepEqual(
      readGLB(roblox.glb).json.meshes.flatMap((m) => m.primitives.map((p) => p.mode ?? 4)),
      [4, 4],
    );
    warnings.length = 0;
    exportSTL(engine, { onWarning: (w) => warnings.push(w) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /writes triangles only/);
  }));

/** The world-space points of each point or line primitive gltf/pbr reads, with its topology and colours. */
const readParts = (model) =>
  model.pointsAndLines.map((p) => ({
    topology: p.topology,
    positions: Array.from(p.indices, (i) => [...p.vertices.subarray(i * 20, i * 20 + 3)]),
    colors: Array.from(p.indices, (i) => [...p.vertices.subarray(i * 20 + 16, i * 20 + 20)]),
  }));

test("exportGLB and exportGLTF write a loaded model's points and lines as glTF POINTS and LINES; gltf/pbr reads them back", () =>
  headlessModels(async () => {
    const engine = await headless(),
      model = await parseGLTFAsync(engine, source()),
      before = readParts(model);
    for (const flatten of [false, true]) {
      const warnings = [],
        out = exportGLB(engine, { flatten, onWarning: (w) => warnings.push(w) }),
        report = await validate(out);
      assert.deepEqual(warnings, []);
      assert.equal(report.errors, 0, JSON.stringify(report.messages.slice(0, 5), null, 1));
      const { json } = readGLB(out),
        all = json.meshes.flatMap((m) => m.primitives);
      assert.deepEqual(
        all.map((p) => p.mode).filter((m) => m !== 4),
        [0, 1],
        `flatten ${flatten}: one point and one line primitive`,
      );
      const points = all.find((p) => p.mode === 0);
      assert.equal(points.attributes.NORMAL, undefined, 'no zero normals: a point without normals is drawn unlit');
      assert.ok(points.attributes.COLOR_0 !== undefined);
      assert.equal(json.materials[points.material].name, 'dots');
      const copy = await parseGLTFAsync(await headless(), out);
      assert.deepEqual(readParts(copy), before, `flatten ${flatten}: positions, segments and colours read back`);
    }
    const { json } = exportGLTF(engine);
    assert.deepEqual(
      json.meshes[0].primitives.map((p) => p.mode),
      [4, 0, 1],
      'mesh "mixed" keeps all three',
    );
  }));

// A data scene's primitives by glTF mode: names and numbers, strips and loops as lists, a fan as triangles.
const ring = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1],
};
const dataScene = () => {
  const node = {
    name: 'modes',
    primitives: [
      { geometry: ring, mode: 'POINTS', material: { name: 'dots', unlit: true, color: [1, 1, 1, 1] } },
      { geometry: ring, mode: 'LINE_STRIP' },
      { geometry: ring, mode: 2, indices: [0, 1, 2] },
      { geometry: { ...ring, normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] }, mode: 'TRIANGLE_FAN' },
      { geometry: ring, mode: 'LINES', indices: [0, 2, 1, 3], extras: { tag: 'cross' } },
    ],
  };
  return { node, scene: { nodes: [node] } };
};

test("a data scene primitive's mode is written by glTF; strips and loops as lines, a fan as triangles", () =>
  headlessModels(async () => {
    const { scene } = dataScene(),
      out = exportGLB(scene),
      report = await validate(out);
    assert.equal(report.errors, 0, JSON.stringify(report.messages.slice(0, 5), null, 1));
    const { json } = readGLB(out),
      primitives = json.meshes[0].primitives;
    assert.deepEqual(
      primitives.map((p) => p.mode),
      [4, 0, 1, 1, 1],
      'the fan first, as triangles; then the list primitives',
    );
    assert.deepEqual(primitives[4].extras, { tag: 'cross' });
    assert.deepEqual(json.materials[primitives[1].material].extensions, { KHR_materials_unlit: {} });
    const copy = await parseGLTFAsync(await headless(), out);
    assert.deepEqual(Array.from(copy.primitives[0].indices), [1, 2, 0, 2, 3, 0], 'the fan (glTF 2.0 3.7.2.1)');
    assert.deepEqual(
      copy.pointsAndLines.map((p) => [p.topology, Array.from(p.indices)]),
      [
        ['point-list', [0, 1, 2, 3]],
        ['line-list', [0, 1, 1, 2, 2, 3]],
        ['line-list', [0, 1, 1, 2, 2, 0]],
        ['line-list', [0, 2, 1, 3]],
      ],
    );
    assert.throws(
      () => exportGLB({ nodes: [{ primitives: [{ geometry: ring, mode: 'QUADS' }] }] }),
      /Unknown primitive mode QUADS/,
    );
    assert.throws(
      () => exportGLB({ nodes: [{ primitives: [{ geometry: ring, mode: 'LINES', indices: [0, 1, 2] }] }] }),
      /complete segments/,
    );
  }));

test("the other writers take a data scene's points and lines where they have a form, and warn where not", () =>
  headlessModels(async () => {
    const { node, scene } = dataScene(),
      warnings = [];
    const { obj } = exportOBJ(scene, { onWarning: (w) => warnings.push(w) }),
      back = await parseOBJ(obj);
    assert.deepEqual(warnings, []);
    assert.equal(back.pointIndices.length, 4);
    assert.equal(back.lineIndices.length, (3 + 3 + 2) * 2);
    exportSTL(scene, { onWarning: (w) => warnings.push(w) });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].node, node, 'a data node is named by its ExportNode');
    assert.match(warnings[0].message, /Node "modes": 4 point or line primitives left out/);
  }));

test('USDZ from GLB bytes and the animated USDZ write points and lines as Points and BasisCurves', () =>
  headlessModels(async () => {
    const kinds = async (usdz) => {
      const asset = await parseUSDZ(usdz, { extensions: [curves()] });
      return asset.document.meshes.flatMap((m) => m.extras?.usdCurves ?? []).map((p) => p.kind);
    };
    // sceneOfGLB keeps each primitive's mode, so a GLB goes through exportUSDZ with its points and lines. The reader
    // lists each curve: the strip, the loop and the two separate segments of the cross.
    assert.deepEqual(await kinds(exportUSDZ(exportGLB(dataScene().scene))), [
      'points',
      'curve',
      'curve',
      'curve',
      'curve',
    ]);
    const { node } = dataScene(),
      animated = {
        nodes: [node],
        animations: [
          { name: 'Lift', channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 0, 2, 0] }] },
        ],
      },
      result = await exportAnimatedUSDZ(animated, { fps: 2, lineWidth: 0.05 }),
      entry = readZipDirectory(result.usdz).find((e) => e.name === 'scene.usda'),
      text = new TextDecoder().decode(await readZipEntry(result.usdz, entry));
    assert.match(text, /def Points "Points_\d+"/);
    assert.match(text, /int\[\] curveVertexCounts = \[4\]/, 'the strip is one curve of four vertices');
    assert.match(text, /float\[\] widths = \[0\.05\]/);
    // @margoengine/usdz reads no time samples, so the animated file is read as text: the prims and their points.
    assert.deepEqual(
      [...text.matchAll(/def (Points|BasisCurves) "/g)].map((m) => m[1]),
      ['Points', 'BasisCurves', 'BasisCurves', 'BasisCurves'],
    );
    assert.match(
      text,
      /def Points "Points_\d+"[^]*?point3f\[\] points = \[\(0, 0, 0\), \(1, 0, 0\), \(1, 1, 0\), \(0, 1, 0\)\]/,
    );
    assert.match(text, /int\[\] curveVertexCounts = \[2, 2\]/, 'the cross is two curves');
    assert.equal(result.frames, 3);
  }));

test("the Godot bundle keeps a GLB's points and lines; the Unity profile refuses them by code", async () => {
  const { scene } = dataScene();
  scene.nodes[0].extras = { id: 'modes' };
  const glb = exportGLB(scene),
    bundle = await createGodotImportBundle(glb, { folder: 'margo_exports/modes' }),
    model = bundle.entries.find((entry) => entry.name.endsWith('/model.glb'));
  assert.deepEqual(model.data, glb, 'Godot imports glTF POINTS and LINES itself; the bytes go in as written');
  await assert.rejects(
    createUnityImportBundle(glb, { folder: 'Assets/Margo/modes' }),
    (error) => error.code === 'unsupported',
  );
});

/** The xyz of each listed vertex of a loaded file. */
const xyz = (positions, list) => Array.from(list, (i) => [...positions.subarray(i * 3, i * 3 + 3)]);
// The source's point cloud and line strip, as segments, in world space (node 'mixed' sits at the origin).
const POINTS = [
  [2, 0, 0],
  [2, 1, 0],
  [2, 2, 0],
  [2, 3, 1],
];
const SEGMENTS = [
  [3, 0, 0],
  [4, 0, 0],
  [4, 0, 0],
  [4, 1, 0],
  [4, 1, 0],
  [3, 1, 0],
];

test('OBJ writes loaded points as p and lines as l polylines; parseOBJ reads them back', () =>
  headlessModels(async () => {
    const engine = await headless();
    await parseGLTFAsync(engine, source());
    const warnings = [],
      { obj } = exportOBJ(engine, { colors: true, colorSpace: 'linear', onWarning: (w) => warnings.push(w) });
    assert.deepEqual(warnings, []);
    assert.match(obj, /^p \d+ \d+ \d+ \d+$/m);
    assert.match(obj, /^l \d+ \d+ \d+ \d+$/m, 'the strip is one polyline');
    const back = await parseOBJ(obj);
    assert.equal(back.indices.length, 4 * 3, 'one triangle and the strip of three');
    assert.deepEqual(xyz(back.positions, back.pointIndices), POINTS);
    assert.deepEqual(xyz(back.positions, back.lineIndices), SEGMENTS);
    assert.deepEqual(
      Array.from(back.pointIndices, (i) => [...back.colors.subarray(i * 3, i * 3 + 3)]),
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 1, 1],
      ],
    );
  }));

test('PLY writes loaded points as vertices and lines as edge elements; parsePLY reads them back', () =>
  headlessModels(async () => {
    const engine = await headless();
    await parseGLTFAsync(engine, source());
    for (const binary of [false, true]) {
      const warnings = [],
        out = exportPLY(engine, { binary, colors: true, upAxis: 'z', onWarning: (w) => warnings.push(w) }),
        back = await parsePLY(typeof out === 'string' ? new TextEncoder().encode(out) : out);
      assert.deepEqual(warnings, []);
      assert.equal(back.indices.length, 4 * 3);
      assert.deepEqual(xyz(back.positions, back.lineIndices), SEGMENTS);
      // The points are the vertices no face or edge names.
      const used = new Set([...back.indices, ...back.lineIndices]),
        free = Array.from({ length: back.positions.length / 3 }, (_, i) => i).filter((i) => !used.has(i));
      assert.deepEqual(xyz(back.positions, free), POINTS);
      assert.deepEqual([...back.colors.subarray(free[0] * 3, free[0] * 3 + 3)], [1, 0, 0]);
    }
  }));

test('COLLADA writes loaded lines as a <lines> group and warns for points; parseDAE reads the lines back', () =>
  headlessModels(async () => {
    const engine = await headless();
    await parseGLTFAsync(engine, source());
    const warnings = [],
      { dae } = exportDAE(engine, { colorSpace: 'linear', onWarning: (w) => warnings.push(w) });
    assert.equal(warnings.length, 1, 'COLLADA has no point primitive');
    assert.match(
      warnings[0].message,
      /1 point or line primitives left out; this format writes lines and triangles only/,
    );
    assert.match(dae, /<lines material="[^"]+" count="3">/);
    const back = parseDAE(new TextEncoder().encode(dae)),
      mixed = back.geometries.find((g) => g.lines);
    assert.ok(mixed, 'a geometry holds the lines');
    assert.deepEqual(xyz(mixed.lines.positions, mixed.lines.indices), SEGMENTS);
    assert.equal(mixed.lines.groups.length, 1);
    // The line group binds the 'wire' material through its symbol.
    const every = (nodes) => nodes.flatMap((n) => [n, ...every(n.children)]),
      instance = every(back.nodes)
        .flatMap((n) => n.instances)
        .find((i) => back.geometries[i.geometry] === mixed);
    assert.equal(back.materials[instance.materials[mixed.lines.groups[0].symbol]].name, 'wire');
    assert.equal(mixed.indices.length, 3, 'the triangle stays as it was');
  }));

test('USDZ writes loaded points as UsdGeomPoints and lines as linear BasisCurves; @margoengine/usdz reads them back', () =>
  headlessModels(async () => {
    const engine = await headless();
    await parseGLTFAsync(engine, source());
    const warnings = [],
      usdz = exportUSDZ(engine, { lineWidth: 0.02, onWarning: (w) => warnings.push(w) });
    assert.deepEqual(warnings, []);
    const entry = readZipDirectory(usdz).find((e) => e.name === 'scene.usda'),
      text = new TextDecoder().decode(await readZipEntry(usdz, entry));
    assert.match(text, /def Points "Points_\d+"/);
    assert.match(
      text,
      /def BasisCurves "BasisCurves_\d+"[^]*?uniform token type = "linear"[^]*?int\[\] curveVertexCounts = \[4\]/,
    );
    const asset = await parseUSDZ(usdz, { extensions: [curves()] }),
      gltf = new GLTFAsset(asset.document, asset.buffers),
      parts = asset.document.meshes.flatMap((m) => m.extras?.usdCurves ?? []),
      read = (part, key, size) => {
        const values = Array.from(gltf.accessor(part[key]));
        return Array.from({ length: values.length / size }, (_, i) => values.slice(i * size, i * size + size));
      };
    assert.deepEqual(
      parts.map((p) => p.kind),
      ['points', 'curve'],
    );
    assert.deepEqual(read(parts[0], 'points', 3), POINTS);
    assert.deepEqual(read(parts[1], 'points', 3), [SEGMENTS[0], SEGMENTS[1], SEGMENTS[3], SEGMENTS[5]]);
    for (const part of parts) for (const [w] of read(part, 'widths', 1)) assert.ok(Math.abs(w - 0.02) < 1e-7);
    // Point colours: COLOR_0 times the 'dots' base colour (1, 0.5, 0.25).
    assert.deepEqual(
      read(parts[0], 'colors', 4)[1].map((v) => Math.round(v * 1e6) / 1e6),
      [0, 0.5, 0, 1],
    );
    assert.ok(
      asset.document.meshes.some((m) => m.primitives.some((p) => (p.mode ?? 4) === 4)),
      'the triangles are read as a mesh',
    );
  }));
