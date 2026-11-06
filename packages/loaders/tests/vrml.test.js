// parseVRML and parseX3D: scene structure, DEF/USE, transforms, attributes, limits, and both encodings agreeing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVRML, parseX3D } from '../dist/vrml.js';
import { LoaderError } from '../dist/common.js';

const H = '#VRML V2.0 utf8\n';
const TRI = 'IndexedFaceSet { coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0, 1, 2, -1] }';
const near = (actual, expected, label = 'value') => {
  assert.equal(actual.length, expected.length, label);
  [...actual].forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) < 1e-5, `${label}: ${[...actual]} against ${expected}`),
  );
};
const code = (fn, expected, pattern) =>
  assert.throws(fn, (e) => e instanceof LoaderError && e.code === expected && pattern.test(e.message));

test('a shape: fan triangles, a named group, material colour, comments and commas as white space', () => {
  const scene = parseVRML(`${H}# a comment with { braces }
DEF Quad Shape {
  appearance Appearance { material Material { diffuseColor 1 0.5 0 transparency 0.25 } }
  geometry IndexedFaceSet { # inline comment
    coord Coordinate { point [ 0 0 0, 1,0,0, 1 1 0, 0 1 0 ] }
    coordIndex [ 0 1 2 3 -1 ]
  }
}`);
  assert.equal(scene.kind, 'mesh');
  assert.equal(scene.positions.length, 12);
  assert.deepEqual([...scene.indices], [0, 1, 2, 0, 2, 3]);
  assert.deepEqual(scene.groups, [{ start: 0, count: 6, name: 'Quad', color: [1, 0.5, 0, 0.75] }]);
  assert.equal(scene.normals, undefined);
  assert.deepEqual(scene.warnings, []);
});

test('nested transforms follow T * C * R * SR * S * -SR * -C', () => {
  const scene = parseVRML(`${H}
Transform { translation 10 0 0 children [
  Transform { rotation 0 0 1 1.5707963267949 scale 2 2 2 children Shape { geometry ${TRI} } }
] }`);
  near(scene.positions, [10, 0, 0, 10, 2, 0, 8, 0, 0], 'translate then rotate then scale');
  // A rotation about a centre keeps the centre fixed.
  const pivot = parseVRML(`${H}
Transform { center 1 0 0 rotation 0 0 1 3.14159265358979 children Shape { geometry ${TRI} } }`);
  near(pivot.positions, [2, 0, 0, 1, 0, 0, 2, -1, 0], 'about centre');
});

test('DEF and USE share a node, and USE before DEF is an error', () => {
  const scene = parseVRML(`${H}
Group { children [
  DEF Tri Shape { geometry ${TRI} }
  Transform { translation 0 0 5 children USE Tri }
] }`);
  assert.equal(scene.groups.length, 2);
  assert.equal(scene.positions[3 * 3 + 2], 5);
  code(() => parseVRML(`${H}Group { children USE Nope }`), 'syntax', /no DEF/);
  // A node cannot USE itself: the DEF only counts once the node is closed.
  code(() => parseVRML(`${H}DEF A Group { children USE A }`), 'syntax', /no DEF/);
});

test('normals, colours and UVs, per vertex and per face, and v turned for Margo', () => {
  const perVertex = parseVRML(`${H}Shape { geometry IndexedFaceSet {
    coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0 1 2 -1]
    normal Normal { vector [0 0 1, 0 1 0] } normalIndex [1 0 1 -1]
    color Color { color [1 0 0, 0 1 0] } colorIndex [1 1 0 -1]
    texCoord TextureCoordinate { point [0 0, 1 0.25] } texCoordIndex [1 0 1 -1]
  } }`);
  assert.deepEqual([...perVertex.normals], [0, 1, 0, 0, 0, 1, 0, 1, 0]);
  assert.deepEqual([...perVertex.colors], [0, 1, 0, 0, 1, 0, 1, 0, 0]);
  assert.deepEqual([...perVertex.uvs], [1, 0.75, 0, 1, 1, 0.75]);
  const perFace = parseVRML(`${H}Shape { geometry IndexedFaceSet {
    coord Coordinate { point [0 0 0, 1 0 0, 0 1 0, 1 1 0] } coordIndex [0 1 2 -1 1 3 2]
    colorPerVertex FALSE color Color { color [1 0 0, 0 0 1] }
    normalPerVertex FALSE normal Normal { vector [0 0 1, 0 0 -1] } normalIndex [1 0]
  } }`);
  assert.deepEqual([...perFace.colors.subarray(0, 3)], [1, 0, 0]);
  assert.deepEqual([...perFace.colors.subarray(9, 12)], [0, 0, 1]);
  assert.deepEqual([...perFace.normals.subarray(0, 3)], [0, 0, -1]);
  assert.deepEqual([...perFace.normals.subarray(9, 12)], [0, 0, 1]);
});

test('winding: ccw FALSE and a mirror each flip it, both together do not; normals stay outward through a mirror', () => {
  const faces = (prefix, ccw) => [
    ...parseVRML(`${H}Transform { ${prefix} children Shape { geometry IndexedFaceSet { ccw ${ccw}
        coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0 1 2 -1]
        normal Normal { vector [0 0 1] } normalIndex [0 0 0 -1] } } }`).indices,
  ];
  assert.deepEqual(faces('', 'TRUE'), [0, 1, 2]);
  assert.deepEqual(faces('', 'FALSE'), [0, 2, 1]);
  assert.deepEqual(faces('scale -1 1 1', 'TRUE'), [0, 2, 1]);
  assert.deepEqual(faces('scale -1 1 1', 'FALSE'), [0, 1, 2]);
  // Non-uniform scale: normals use the inverse transpose, then unit length.
  const scaled = parseVRML(`${H}Transform { scale 2 1 1 children Shape { geometry IndexedFaceSet {
    coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0 1 2 -1]
    normal Normal { vector [0.6 0.8 0] } normalIndex [0 0 0 -1] } } }`);
  const len = Math.hypot(0.3, 0.8);
  near(scaled.normals.subarray(0, 3), [0.3 / len, 0.8 / len, 0], 'inverse transpose');
});

test('what is left out is listed, and a mesh missing an attribute drops or fills it', () => {
  const scene = parseVRML(`${H}
PROTO Thing [ field SFFloat a 1 ] { Group { } }
EXTERNPROTO Other [ field SFFloat a ] "other.wrl"
WorldInfo { title "a \\"quoted\\" title" info ["x", "y"] }
NavigationInfo { type "EXAMINE" }
Shape { geometry Box { size 1 1 1 } }
Shape { appearance Appearance { texture ImageTexture { url "a.png" } } geometry ${TRI} }
Shape { appearance Appearance { material Material { diffuseColor 0 1 0 } } geometry IndexedFaceSet {
  coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0 1 2 -1]
  color Color { color [1 1 1] } colorIndex [0 0 0 -1]
  normal Normal { vector [0 0 1] } normalIndex [0 0 0 -1]
} }
ROUTE a.b TO c.d
Inline { url "more.wrl" }
Shape { }
Shape { geometry IndexedFaceSet { } }`);
  assert.deepEqual(scene.warnings.sort(), ['Box', 'ImageTexture', 'Inline', 'NavigationInfo', 'WorldInfo'].sort());
  assert.equal(scene.groups.length, 2);
  assert.equal(scene.normals, undefined, 'one shape had none');
  assert.deepEqual([...scene.colors.subarray(0, 3)], [1, 1, 1], 'a shape without colours takes white');
  assert.deepEqual([...scene.colors.subarray(9, 12)], [1, 1, 1]);
});

test('bad files and limits throw coded errors', () => {
  code(() => parseVRML('Shape { }'), 'header', /#VRML/);
  code(() => parseVRML('#VRML V1.0 ascii\nSeparator { }'), 'unsupported', /VRML97/);
  code(() => parseVRML(`${H}Shape {`), 'syntax', /file ends/);
  code(() => parseVRML(`${H}Shape x`), 'syntax', /expected \{/);
  code(
    () =>
      parseVRML(`${H}Shape { geometry IndexedFaceSet { coordIndex [0 1 9 -1] coord Coordinate { point [0 0 0] } } }`),
    'range',
    /coord index/,
  );
  code(() => parseVRML(`${H}Group { a 1e999 }`), 'syntax', /invalid number/);
  code(() => parseVRML(`${H}Shape { geometry ${TRI} }`, { maxVertices: 2 }), 'limit', /vertex count/);
  code(() => parseVRML(`${H}Shape { geometry ${TRI} }`, { maxTriangles: 0 }), 'limit', /triangle count/);
  code(() => parseVRML(`${H}Group { }`, { maxNodes: 0 }), 'limit', /node count/);
  code(() => parseVRML(`${H}Group { }`, { maxNodes: -1 }), 'range', /maxNodes/);
  code(() => parseVRML(`${H}${'Group { children '.repeat(300)}`), 'limit', /deeper/);
  code(() => parseVRML(`${H}WorldInfo { title "never closed }`), 'syntax', /never closed/);
  code(() => parseX3D('<a/>'), 'header', /<X3D>/);
});

test('regression: USE chains that double at each level hit the node limit, not the memory', () => {
  let text = `${H}DEF L0 Group { }\n`;
  for (let i = 1; i < 40; i++) text += `DEF L${i} Group { children [USE L${i - 1} USE L${i - 1}] }\n`;
  code(() => parseVRML(text), 'limit', /node count/);
});

test('X3D XML: same scene as VRML, containerField, DEF and USE attributes, booleans', () => {
  const x3d = parseX3D(`<?xml version="1.0"?>
<X3D profile="Interchange"><head><meta name="a"/></head><Scene>
  <Transform translation="1 0 0" rotation="0 0 1 1.5707963267949">
    <Shape DEF="S">
      <Appearance><Material diffuseColor="0 0 1" transparency="0.5"/></Appearance>
      <IndexedFaceSet coordIndex="0 1 2 -1" ccw="FALSE" colorPerVertex="false" solid="true">
        <Coordinate point="0 0 0, 1 0 0, 0 1 0"/>
        <Color color="1 0 0"/>
      </IndexedFaceSet>
    </Shape>
  </Transform>
  <Group><Shape USE="S"/></Group>
</Scene></X3D>`);
  const vrml = parseVRML(`${H}
Transform { translation 1 0 0 rotation 0 0 1 1.5707963267949 children
  DEF S Shape {
    appearance Appearance { material Material { diffuseColor 0 0 1 transparency 0.5 } }
    geometry IndexedFaceSet { coordIndex [0 1 2 -1] ccw FALSE colorPerVertex FALSE
      coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } color Color { color [1 0 0] } }
  } }
Group { children USE S }`);
  near(x3d.positions, vrml.positions, 'positions');
  assert.deepEqual([...x3d.indices], [...vrml.indices]);
  assert.deepEqual(x3d.groups, vrml.groups);
  assert.deepEqual([...x3d.colors], [...vrml.colors]);
  assert.deepEqual([...x3d.indices.subarray(0, 3)], [0, 2, 1], 'ccw false flips');
  assert.equal(x3d.groups[0].name, 'S');
  code(() => parseX3D('<X3D><Scene><Group USE="Q"/></Scene></X3D>'), 'syntax', /no DEF/);
  code(() => parseX3D('<X3D><Scene><Transform translation="1e999 0 0"/></Scene></X3D>'), 'syntax', /invalid number/);
  const custom = parseX3D(`<X3D><Scene><Shape><IndexedFaceSet coordIndex="0 1 2">
    <Coordinate containerField="coord" point="0 0 0 1 0 0 0 1 0"/></IndexedFaceSet></Shape></Scene></X3D>`);
  assert.equal(custom.indices.length, 3);
});

test('bytes work like text', () => {
  const bytes = new TextEncoder().encode(`${H}Shape { geometry ${TRI} }`);
  assert.equal(parseVRML(bytes).positions.length, 9);
});

test('regression: the X3D CAD nodes hold geometry; CATIA exports read as empty before', () => {
  const shape = (x) =>
    `<Shape containerField='shape'><IndexedFaceSet coordIndex='0 1 2 -1'><Coordinate point='${x} 0 0 ${x + 1} 0 0 ${x} 1 0'/></IndexedFaceSet></Shape>`;
  const scene = parseX3D(`<X3D><Scene><CADLayer><CADAssembly>
    <CADPart translation='0 0 5'><CADFace>${shape(0)}</CADFace></CADPart>
    <CADFace>${shape(2)}</CADFace>
  </CADAssembly></CADLayer></Scene></X3D>`);
  near(scene.positions, [0, 0, 5, 1, 0, 5, 0, 1, 5, 2, 0, 0, 3, 0, 0, 2, 1, 0], 'positions');
  assert.deepEqual(scene.warnings, []);
  const vrml = parseVRML(`${H}CADAssembly { children [ CADPart { translation 0 2 0 children [ CADFace { shape Shape { geometry ${TRI} } } ] } ] }`);
  near(vrml.positions, [0, 2, 0, 1, 2, 0, 0, 3, 0], 'VRML form');
});
