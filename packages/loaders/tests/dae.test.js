import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError, createMeshes, flattenDAE, parseDAE } from '../dist/index.js';

const close = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
};
const rejects = (fn, code, pattern) =>
  assert.throws(
    fn,
    (error) => error instanceof LoaderError && error.code === code && (!pattern || pattern.test(error.message)),
  );
const xyz = (id, values) =>
  `<source id="${id}"><float_array id="${id}-array" count="${values.length}">${values.join(' ')}</float_array>` +
  `<technique_common><accessor source="#${id}-array" count="${values.length / 3}" stride="3">` +
  '<param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor>' +
  '</technique_common></source>';

// COLLADA 1.4.1, Y-up: a polylist quad and a triangle with two materials bound through symbols, a textured phong
// effect (sampler2D -> surface -> image), nested nodes with TRS stacks and an instance_node, plus a line primitive,
// an empty animation and an instance_controller naming no controller (reported, with no mesh).
const YUP = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>
  <library_images>
    <image id="tile-image" name="tile"><init_from>./../textures/tile%20a.png</init_from></image>
  </library_images>
  <library_effects>
    <effect id="tiles-effect">
      <profile_COMMON>
        <newparam sid="tile-surface"><surface type="2D"><init_from>tile-image</init_from></surface></newparam>
        <newparam sid="tile-sampler"><sampler2D><source>tile-surface</source></sampler2D></newparam>
        <technique sid="common">
          <phong>
            <emission><color sid="emission">0 0 0 1</color></emission>
            <ambient><color>0.1 0.1 0.1 1</color></ambient>
            <diffuse><texture texture="tile-sampler" texcoord="UVMap"/></diffuse>
            <specular><color>0.5 0.5 0.5 1</color></specular>
            <shininess><float sid="shininess">50</float></shininess>
            <transparent opaque="A_ONE"><color>1 1 1 1</color></transparent>
            <transparency><float>0.8</float></transparency>
            <index_of_refraction><float>1.45</float></index_of_refraction>
          </phong>
        </technique>
      </profile_COMMON>
    </effect>
    <effect id="red-effect">
      <profile_COMMON><technique sid="common"><lambert><diffuse><color>1 0 0 1</color></diffuse></lambert></technique></profile_COMMON>
    </effect>
  </library_effects>
  <library_materials>
    <material id="tiles" name="Tiles"><instance_effect url="#tiles-effect"/></material>
    <material id="red" name="Red"><instance_effect url="#red-effect"/></material>
  </library_materials>
  <library_geometries>
    <geometry id="mesh" name="Mesh">
      <mesh>
        ${xyz('mesh-positions', [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0])}
        ${xyz('mesh-normals', [0, 0, 1])}
        <source id="mesh-uvs">
          <float_array id="mesh-uvs-array" count="10">0 0 1 0 1 1 0 1 0.5 0.5</float_array>
          <technique_common><accessor source="#mesh-uvs-array" count="5" stride="2">
            <param name="S" type="float"/><param name="T" type="float"/>
          </accessor></technique_common>
        </source>
        <vertices id="mesh-vertices"><input semantic="POSITION" source="#mesh-positions"/></vertices>
        <polylist material="tilesSymbol" count="1">
          <input semantic="VERTEX" source="#mesh-vertices" offset="0"/>
          <input semantic="NORMAL" source="#mesh-normals" offset="1"/>
          <input semantic="TEXCOORD" source="#mesh-uvs" offset="2" set="0"/>
          <vcount>4</vcount>
          <p>0 0 0 1 0 1 2 0 2 3 0 3</p>
        </polylist>
        <triangles material="redSymbol" count="1">
          <input semantic="VERTEX" source="#mesh-vertices" offset="0"/>
          <input semantic="NORMAL" source="#mesh-normals" offset="1"/>
          <input semantic="TEXCOORD" source="#mesh-uvs" offset="2" set="0"/>
          <p>1 0 4 4 0 4 2 0 2</p>
        </triangles>
        <lines count="1"><input semantic="VERTEX" source="#mesh-vertices" offset="0"/><p>0 1</p></lines>
      </mesh>
    </geometry>
  </library_geometries>
  <library_nodes>
    <node id="shared" name="Shared"><translate>0 0 5</translate><instance_geometry url="#mesh"/></node>
  </library_nodes>
  <library_animations><animation id="spin"/></library_animations>
  <library_visual_scenes>
    <visual_scene id="Scene">
      <node id="parent" name="Parent">
        <translate sid="location">1 2 3</translate>
        <rotate sid="rotationY">0 1 0 90</rotate>
        <scale sid="scale">2 2 2</scale>
        <node id="child" name="Child">
          <matrix>1 0 0 10  0 1 0 0  0 0 1 0  0 0 0 1</matrix>
          <instance_geometry url="#mesh">
            <bind_material><technique_common>
              <instance_material symbol="tilesSymbol" target="#tiles">
                <bind_vertex_input semantic="UVMap" input_semantic="TEXCOORD" input_set="0"/>
              </instance_material>
              <instance_material symbol="redSymbol" target="#red"/>
            </technique_common></bind_material>
          </instance_geometry>
        </node>
        <instance_node url="#shared"/>
      </node>
      <node id="rig"><instance_controller url="#skin"/></node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;

// COLLADA 1.5, Z-up centimeters: trifans with per-corner colors, tristrips, polygons with a hole, a constant
// effect whose emission texture comes from a 1.5 sampler (instance_image), a file:// image URI and a Z rotation.
const ZUP = `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2008/03/COLLADASchema" version="1.5.0">
  <asset><unit name="centimeter" meter="0.01"/><up_axis>Z_UP</up_axis></asset>
  <library_images><image id="img"><init_from><ref>file:///C:/assets/grass.png</ref></init_from></image></library_images>
  <library_effects>
    <effect id="e"><profile_COMMON>
      <newparam sid="s"><sampler2D><instance_image url="#img"/></sampler2D></newparam>
      <technique sid="t"><constant><emission><texture texture="s" texcoord="CHANNEL0"/></emission></constant></technique>
    </profile_COMMON></effect>
    <effect id="b"><profile_COMMON><technique sid="t"><blinn><diffuse><color>0 0.5 1</color></diffuse></blinn></technique></profile_COMMON></effect>
  </library_effects>
  <library_materials>
    <material id="m"><instance_effect url="#e"/></material>
    <material id="mb"><instance_effect url="#b"/></material>
  </library_materials>
  <library_geometries><geometry id="g"><mesh>
    ${xyz('p', [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100])}
    ${xyz('n', [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])}
    <source id="c"><float_array id="ca" count="8">1 0 0 1 0 1 0 1</float_array>
      <technique_common><accessor source="#ca" count="2" stride="4">
        <param name="R" type="float"/><param name="G" type="float"/><param name="B" type="float"/><param name="A" type="float"/>
      </accessor></technique_common></source>
    <vertices id="v"><input semantic="POSITION" source="#p"/><input semantic="NORMAL" source="#n"/></vertices>
    <trifans material="fan" count="1">
      <input semantic="VERTEX" source="#v" offset="0"/><input semantic="COLOR" source="#c" offset="1"/>
      <p>0 0 1 0 2 1</p>
    </trifans>
    <tristrips count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2 3</p></tristrips>
    <polygons count="2">
      <input semantic="VERTEX" source="#v" offset="0"/>
      <p>0 1 3</p>
      <ph><p>0 1 2 3</p><h>0 1 2</h></ph>
    </polygons>
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="vs">
    <node name="N">
      <translate>0 0 100</translate><rotate>0 0 1 90</rotate>
      <instance_geometry url="#g"><bind_material><technique_common>
        <instance_material symbol="fan" target="#m"/>
      </technique_common></bind_material></instance_geometry>
    </node>
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#vs"/></scene>
</COLLADA>`;

test('DAE: Y-up polylist quads, triangles, two materials bound through symbols, textured phong, warnings', () => {
  const dae = parseDAE(new TextEncoder().encode(YUP));
  assert.equal(dae.upAxis, 'Y_UP');
  assert.equal(dae.meter, 1);
  assert.equal(dae.geometries.length, 1);
  const [mesh] = dae.geometries;
  assert.equal(mesh.id, 'mesh');
  assert.equal(mesh.name, 'Mesh');
  assert.deepEqual([...mesh.faceSizes], [4, 3]);
  assert.deepEqual([...mesh.positionIndices], [0, 1, 2, 3, 1, 4, 2]);
  assert.deepEqual([...mesh.indices], [0, 1, 2, 0, 2, 3, 4, 5, 6]);
  assert.deepEqual(mesh.groups, [
    { start: 0, count: 6, symbol: 'tilesSymbol' },
    { start: 6, count: 3, symbol: 'redSymbol' },
  ]);
  close(mesh.uvs, [0, 1, 1, 1, 1, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 1, 0], 'uvs');
  close(mesh.normals.subarray(0, 3), [0, 0, 1], 'normal');
  assert.equal(mesh.colors, undefined);
  assert.deepEqual(dae.materials, [
    {
      id: 'tiles',
      name: 'Tiles',
      shading: 'phong',
      emission: { color: [0, 0, 0, 1] },
      ambient: { color: [0.1, 0.1, 0.1, 1] },
      diffuse: { texture: { path: '../textures/tile a.png', texcoord: 'UVMap' } },
      specular: { color: [0.5, 0.5, 0.5, 1] },
      transparent: { color: [1, 1, 1, 1] },
      opaque: 'A_ONE',
      shininess: 50,
      transparency: 0.8,
      indexOfRefraction: 1.45,
    },
    { id: 'red', name: 'Red', shading: 'lambert', diffuse: { color: [1, 0, 0, 1] } },
  ]);
  assert.deepEqual(dae.images, ['../textures/tile a.png']);
  assert.deepEqual(dae.warnings, [
    'geometry "mesh": <lines> are not imported (only polygons)',
    'instance_controller "#skin" names no imported <controller>, so its node has no mesh',
  ]);
  // Hierarchy: translate * rotate * scale, a row-major <matrix>, and the instance_node copy.
  const [parent, rig] = dae.nodes;
  assert.equal(rig.id, 'rig');
  assert.deepEqual(rig.instances, []);
  assert.equal(parent.name, 'Parent');
  close(parent.matrix, [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 1, 2, 3, 1], 'parent');
  const [child, shared] = parent.children;
  close(child.matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1], 'child');
  assert.equal(child.instances.length, 1);
  assert.equal(child.instances[0].geometry, 0);
  assert.deepEqual({ ...child.instances[0].materials }, { tilesSymbol: 0, redSymbol: 1 });
  assert.equal(Object.getPrototypeOf(child.instances[0].materials), null);
  assert.equal(shared.id, 'shared');
  close(shared.matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1], 'shared');
  assert.deepEqual({ ...shared.instances[0].materials }, {});
});

test('DAE: Z-up centimeters convert to Y-up meters; 1.5 images; trifans, tristrips and polygons with holes', () => {
  const dae = parseDAE(ZUP);
  assert.equal(dae.upAxis, 'Z_UP');
  assert.equal(dae.meter, 0.01);
  const [mesh] = dae.geometries;
  // (x, y, z) cm Z-up -> (x, z, -y) m Y-up.
  close(mesh.positions.subarray(0, 9), [0, 0, 0, 1, 0, 0, 0, 0, -1], 'positions');
  close(mesh.normals.subarray(0, 3), [0, 1, 0], 'normal');
  assert.deepEqual([...mesh.faceSizes], [3, 3, 3, 3, 4]);
  assert.deepEqual(
    mesh.groups.map((g) => [g.start, g.count, g.symbol]),
    [
      [0, 3, 'fan'],
      [3, 6, undefined],
      [9, 9, undefined],
    ],
  );
  // Strip triangles alternate winding: (0 1 2), (2 1 3).
  assert.deepEqual(
    [...mesh.indices.subarray(3, 9)].map((v) => mesh.positionIndices[v]),
    [0, 1, 2, 2, 1, 3],
  );
  // Colors only on the fan; other corners are white.
  close(mesh.colors.subarray(0, 9), [1, 0, 0, 1, 0, 0, 0, 1, 0], 'fan colors');
  close(mesh.colors.subarray(9, 12), [1, 1, 1], 'white');
  assert.deepEqual(dae.materials, [
    { id: 'm', shading: 'constant', emission: { texture: { path: 'C:/assets/grass.png', texcoord: 'CHANNEL0' } } },
    { id: 'mb', shading: 'blinn', diffuse: { color: [0, 0.5, 1, 1] } },
  ]);
  assert.deepEqual(dae.images, ['C:/assets/grass.png']);
  assert.deepEqual(dae.warnings, ['geometry "g": polygon holes (<ph><h>) are not imported; the outer polygon is kept']);
  // translate 0 0 100 cm becomes 1 m up; a rotation about Z (up) becomes the same rotation about Y.
  close(dae.nodes[0].matrix, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1], 'node');
});

test('flattenDAE bakes the hierarchy for createMeshes; mirrored nodes keep outward winding', () => {
  const flat = flattenDAE(parseDAE(YUP));
  assert.equal(flat.positions.length / 3, 14);
  // Child vertex 0 (0 0 0): child x+10, then parent scale 2, rotate 90 about Y, translate (1 2 3).
  close(flat.positions.subarray(0, 3), [1, 2, -17], 'child v0');
  close(flat.positions.subarray(21, 24), [11, 2, 3], 'shared v0');
  close(flat.normals.subarray(0, 3), [1, 0, 0], 'normal');
  assert.deepEqual([...flat.faceSizes], [4, 3, 4, 3]);
  assert.deepEqual(
    flat.groups.map((g) => [g.start, g.count, g.name, g.color]),
    [
      [0, 6, 'Child', undefined],
      [6, 3, 'Child', [1, 0, 0, 1]],
      [9, 6, 'Shared', undefined],
      [15, 3, 'Shared', undefined],
    ],
  );
  const meshes = [];
  const engine = {
    createMesh: () => {
      const mesh = { setGeometry: () => mesh, setMaterial: () => mesh, dispose() {} };
      meshes.push(mesh);
      return mesh;
    },
  };
  assert.equal(createMeshes(engine, flat).meshes.length, 4);
  const mirrored = flattenDAE(parseDAE(YUP.replace('<scale sid="scale">2 2 2</scale>', '<scale>-1 1 1</scale>')));
  const normalOf = (g, t) => {
    const p = (k) => [...g.positions.subarray(g.indices[t * 3 + k] * 3, g.indices[t * 3 + k] * 3 + 3)];
    const [a, b, c] = [p(0), p(1), p(2)],
      u = b.map((v, i) => v - a[i]),
      w = c.map((v, i) => v - a[i]);
    return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  };
  const face = normalOf(mirrored, 0),
    n = [...mirrored.normals.subarray(mirrored.indices[0] * 3, mirrored.indices[0] * 3 + 3)];
  assert.ok(face[0] * n[0] + face[1] * n[1] + face[2] * n[2] > 0, 'winding agrees with the transformed normal');
});

test('DAE: world-space corners match the document transforms worked out by hand', () => {
  {
    const plain = (xml) => xml.replace('<node id="rig"><instance_controller url="#skin"/></node>', '');
    // A quad splits into two triangles on either diagonal, so compare the triangle count and the set of corners.
    const corners = (triangles) =>
      [
        ...new Set(
          triangles.flatMap((t) =>
            [0, 3, 6].map((k) =>
              t
                .slice(k, k + 3)
                .map((v) => v.toFixed(4))
                .join(' '),
            ),
          ),
        ),
      ].sort();
    // The mesh's five points; the polylist quad uses 0-3 and the triangle 1, 4, 2 (the line adds no triangles).
    const points = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [2, 0, 0],
    ];
    // Node "parent": translate (1, 2, 3), rotate 90 degrees about +Y ((x, y, z) -> (z, y, -x)), scale 2. Its child
    // node's matrix translates +10 in x; the instanced node "shared" translates (0, 0, 5).
    const parent = ([x, y, z]) => [2 * z + 1, 2 * y + 2, -2 * x + 3];
    const file = [
      ...points.map(([x, y, z]) => parent([x + 10, y, z])),
      ...points.map(([x, y, z]) => parent([x, y, z + 5])),
    ];
    const documents = [
      // Y_UP, meter 1: file coordinates are world coordinates.
      [plain(YUP), file, 'yup'],
      // Z_UP, meter 0.5: COLLADA's up_axis rule maps file (x, y, z) to Y-up (x, z, -y), then lengths scale by 0.5.
      [
        plain(YUP.replace('Y_UP', 'Z_UP').replace('meter="1"', 'meter="0.5"')),
        file.map(([x, y, z]) => [0.5 * x, 0.5 * z, -0.5 * y]),
        'zupHalfMeter',
      ],
    ];
    // The same corner sets, written out (spec vectors oracles.daeWorldCorners).
    const written = {
      yup: [
        '1.0000 2.0000 -17.0000',
        '1.0000 2.0000 -19.0000',
        '1.0000 2.0000 -21.0000',
        '1.0000 4.0000 -17.0000',
        '1.0000 4.0000 -19.0000',
        '11.0000 2.0000 -1.0000',
        '11.0000 2.0000 1.0000',
        '11.0000 2.0000 3.0000',
        '11.0000 4.0000 1.0000',
        '11.0000 4.0000 3.0000',
      ],
      zupHalfMeter: [
        '0.5000 -10.5000 -1.0000',
        '0.5000 -8.5000 -1.0000',
        '0.5000 -8.5000 -2.0000',
        '0.5000 -9.5000 -1.0000',
        '0.5000 -9.5000 -2.0000',
        '5.5000 -0.5000 -1.0000',
        '5.5000 0.5000 -1.0000',
        '5.5000 0.5000 -2.0000',
        '5.5000 1.5000 -1.0000',
        '5.5000 1.5000 -2.0000',
      ],
    };
    for (const [xml, expected, name] of documents) {
      const ours = flattenDAE(parseDAE(xml)),
        mine = [];
      for (let t = 0; t < ours.indices.length; t += 3)
        mine.push(
          [0, 1, 2].flatMap((k) => [...ours.positions.subarray(ours.indices[t + k] * 3, ours.indices[t + k] * 3 + 3)]),
        );
      assert.equal(mine.length, 6, `${name}: two instances of a quad and a triangle`);
      assert.deepEqual(
        corners(mine),
        [...new Set(expected.map((p) => p.map((v) => v.toFixed(4)).join(' ')))].sort(),
        name,
      );
      assert.deepEqual(corners(mine), written[name], name);
    }
  }
});

test('DAE: malformed documents are rejected with clear errors; limits', () => {
  const swap = (from, to) => YUP.replace(from, to);
  rejects(() => parseDAE('<scene/>'), 'header', /not <COLLADA>/);
  rejects(() => parseDAE('<COLLADA><asset>'), 'truncated');
  rejects(() => parseDAE(swap('<up_axis>Y_UP</up_axis>', '<up_axis>W_UP</up_axis>')), 'syntax', /up_axis/);
  rejects(() => parseDAE(swap('meter="1"', 'meter="-1"')), 'syntax', /unit meter/);
  rejects(() => parseDAE(swap('<vcount>4</vcount>', '<vcount>3</vcount>')), 'syntax', /vcount does not match/);
  rejects(() => parseDAE(swap('<p>1 0 4 4 0 4 2 0 2</p>', '<p>1 0 4 9 0 4 2 0 2</p>')), 'range', /vertex index 9/);
  rejects(() => parseDAE(swap('<p>1 0 4 4 0 4 2 0 2</p>', '<p>1 0 4 4 0 4 2 0</p>')), 'syntax', /multiple of 3/);
  rejects(() => parseDAE(swap('0 1 0 2 0 0', '0 1 0 2 x 0')), 'syntax', /invalid number "x"/);
  rejects(() => parseDAE(swap('count="5" stride="3"', 'count="6" stride="3"')), 'truncated', /mesh-positions/);
  rejects(
    () =>
      parseDAE(
        swap('<vertices id="mesh-vertices">', '<verticez id="mesh-vertices">').replace('</vertices>', '</verticez>'),
      ),
    'syntax',
    /no <vertices>/,
  );
  rejects(
    () => parseDAE(swap('<rotate sid="rotationY">0 1 0 90</rotate>', '<rotate>0 1 90</rotate>')),
    'syntax',
    /needs 4/,
  );
  rejects(() => parseDAE(YUP, { maxVertices: 6 }), 'limit');
  rejects(() => parseDAE(YUP, { maxTriangles: 2 }), 'limit');
  const cycle = swap('<translate>0 0 5</translate>', '<instance_node url="#shared"/>');
  rejects(() => parseDAE(cycle), 'limit', /deeper than 64/);
});
