// STEP stage 1: the file reader and the product structure, on small hand-written AP214 files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSTEP, STEPFile, Ref, Enum, Typed, DERIVED, stepText } from '../dist/index.js';

const header = String.raw`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test part'),'2;1');
FILE_NAME('part.stp','2026-10-17T12:00:00',('Margo'),('Margo'),'hand','margo tests','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
`;
// One part, millimetres: a one-face solid (a triangle on z = 0 bounded by three lines), coloured by a styled item.
const part = String.raw`#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT('P-100','Bracket \X2\00E9\X0\ ''A''','',(#2));
#4=PRODUCT_DEFINITION_FORMATION('','',#3);
#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#6=PRODUCT_DEFINITION('design','',#4,#5);
#7=PRODUCT_DEFINITION_SHAPE('','',#6);
#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#9=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#10=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9))REPRESENTATION_CONTEXT('',''));
#11=CARTESIAN_POINT('',(0.,0.,0.));
#12=AXIS2_PLACEMENT_3D('',#11,$,$);
#13=SHAPE_REPRESENTATION('',(#12),#10);
#14=SHAPE_DEFINITION_REPRESENTATION(#7,#13);
/* a triangle face on z = 0 */
#20=CARTESIAN_POINT('',(0.,0.,0.));
#21=CARTESIAN_POINT('',(10.,0.,0.));
#22=CARTESIAN_POINT('',(0.,10.,0.));
#23=VERTEX_POINT('',#20);
#24=VERTEX_POINT('',#21);
#25=VERTEX_POINT('',#22);
#26=DIRECTION('',(1.,0.,0.));
#27=VECTOR('',#26,1.);
#28=LINE('',#20,#27);
#29=EDGE_CURVE('',#23,#24,#28,.T.);
#30=DIRECTION('',(-0.7071067811865476,0.7071067811865476,0.));
#31=VECTOR('',#30,1.E0);
#32=LINE('',#21,#31);
#33=EDGE_CURVE('',#24,#25,#32,.T.);
#34=DIRECTION('',(0.,-1.,0.));
#35=VECTOR('',#34,1.);
#36=LINE('',#22,#35);
#37=EDGE_CURVE('',#25,#23,#36,.T.);
#38=ORIENTED_EDGE('',*,*,#29,.T.);
#39=ORIENTED_EDGE('',*,*,#33,.T.);
#40=ORIENTED_EDGE('',*,*,#37,.T.);
#41=EDGE_LOOP('',(#38,#39,#40));
#42=FACE_OUTER_BOUND('',#41,.T.);
#43=PLANE('',#12);
#44=ADVANCED_FACE('',(#42),#43,.T.);
#45=CLOSED_SHELL('',(#44));
#46=MANIFOLD_SOLID_BREP('Body 1',#45);
#47=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#46,#12),#10);
#48=SHAPE_REPRESENTATION_RELATIONSHIP('','',#13,#47);
#50=COLOUR_RGB('',0.8,0.2,0.1);
#51=FILL_AREA_STYLE_COLOUR('',#50);
#52=FILL_AREA_STYLE('',(#51));
#53=SURFACE_STYLE_FILL_AREA(#52);
#54=SURFACE_SIDE_STYLE('',(#53));
#55=SURFACE_STYLE_USAGE(.BOTH.,#54);
#56=PRESENTATION_STYLE_ASSIGNMENT((#55));
#57=STYLED_ITEM('color',(#56),#46);
`;
// An assembly placing the part 100 mm along x, turned 90 degrees about z (its x axis along the assembly's y).
const assembly = String.raw`#60=PRODUCT('ASM-1','Assembly','',(#2));
#61=PRODUCT_DEFINITION_FORMATION('','',#60);
#62=PRODUCT_DEFINITION('design','',#61,#5);
#63=PRODUCT_DEFINITION_SHAPE('','',#62);
#64=CARTESIAN_POINT('',(100.,0.,0.));
#65=DIRECTION('',(0.,0.,1.));
#66=DIRECTION('',(0.,1.,0.));
#67=AXIS2_PLACEMENT_3D('',#64,#65,#66);
#68=SHAPE_REPRESENTATION('',(#12,#67),#10);
#69=SHAPE_DEFINITION_REPRESENTATION(#63,#68);
#70=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','Bracket','',#62,#6,$);
#71=PRODUCT_DEFINITION_SHAPE('','',#70);
#72=ITEM_DEFINED_TRANSFORMATION('','',#12,#67);
#73=(REPRESENTATION_RELATIONSHIP('','',#13,#68)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#72)SHAPE_REPRESENTATION_RELATIONSHIP());
#74=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#73,#71);
`;
const footer = 'ENDSEC;\nEND-ISO-10303-21;\n';
const close = (actual, expected, label) =>
  assert.ok(
    actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) < 1e-12),
    `${label}: ${[...actual]} != ${expected}`,
  );

test('the reader indexes every instance, parses parameters on demand and decodes text escapes', () => {
  const file = new STEPFile(header + part + footer);
  assert.equal(file.size, 51);
  assert.equal(file.header.name, 'part.stp');
  assert.deepEqual(file.header.schema, ['AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }']);
  assert.equal(file.header.system, 'margo tests');
  assert.deepEqual(file.ids('LINE'), [28, 32, 36]);
  assert.deepEqual(file.ids('SI_UNIT'), [8, 9], 'complex instances are indexed by their partial types');
  const product = file.get(3);
  assert.equal(product.type, 'PRODUCT');
  assert.equal(product.args[1], "Bracket é 'A'");
  assert.ok(product.args[3][0] instanceof Ref && product.args[3][0].id === 2);
  const edge = file.get(38).args;
  assert.equal(edge[1], DERIVED);
  assert.ok(edge[4] instanceof Enum && edge[4].name === 'T');
  assert.equal(file.get(31).args[2], 1, "'1.E0' reads as 1");
  assert.deepEqual(
    file.args(8, 'SI_UNIT').map((v) => v?.name ?? v),
    ['MILLI', 'METRE'],
  );
  assert.equal(
    file.typeName(10),
    'GEOMETRIC_REPRESENTATION_CONTEXT+GLOBAL_UNIT_ASSIGNED_CONTEXT+REPRESENTATION_CONTEXT',
  );
  assert.equal(file.census().get('ORIENTED_EDGE'), 3);
  assert.throws(() => file.get(999), /^TypeError: Invalid STEP file: #999 is referenced but never defined$/);
});

test('a part: one solid in millimetres, its faces, edges, surface and curve census and colour', () => {
  const model = parseSTEP(new TextEncoder().encode(header + part + footer));
  assert.deepEqual(
    model.products.map((p) => [p.id, p.name, p.partNumber]),
    [[6, "Bracket é 'A'", 'P-100']],
  );
  assert.deepEqual(model.roots, [0]);
  assert.equal(model.bodies.length, 1);
  const [body] = model.bodies;
  assert.deepEqual(
    [body.id, body.kind, body.name, body.faces, body.edges, body.unit],
    [46, 'solid', 'Body 1', [44], 3, 0.001],
  );
  assert.deepEqual(body.color, [0.8, 0.2, 0.1, 1]);
  assert.deepEqual(model.census, { surfaces: { PLANE: 1 }, curves: { LINE: 3 } });
  assert.equal(model.instances.length, 1);
  assert.deepEqual([model.instances[0].body, model.instances[0].product, model.instances[0].path], [0, 0, [0]]);
  close(model.instances[0].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'root part at the origin');
  assert.deepEqual(model.warnings, []);
});

test('an assembly places its component with the item-defined transformation, in metres', () => {
  const model = parseSTEP(header + part + assembly + footer);
  assert.deepEqual(
    model.products.map((p) => p.name),
    ["Bracket é 'A'", 'Assembly'],
  );
  assert.deepEqual(model.roots, [1], 'the assembly is the only root');
  assert.equal(model.instances.length, 1, 'the part is placed once, by the assembly');
  const [instance] = model.instances;
  assert.deepEqual(instance.path, [1, 0]);
  // x -> +y, y -> -x, z -> z; 100 mm along x.
  close(instance.matrix, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0.1, 0, 0, 1], 'component placement');
});

test('inch models report 0.0254 metres per unit through the conversion-based unit', () => {
  const inch = part.replace(
    '#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));',
    String.raw`#80=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#81=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#80);
#82=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);
#8=(CONVERSION_BASED_UNIT('INCH',#81)LENGTH_UNIT()NAMED_UNIT(#82));`,
  );
  const model = parseSTEP(header + inch + footer);
  assert.ok(Math.abs(model.bodies[0].unit - 0.0254) < 1e-15);
  assert.ok(model.file.get(81).args[0] instanceof Typed);
});

test('malformed files throw a TypeError that names the line', () => {
  assert.throws(() => parseSTEP('HEADER;ENDSEC;'), /^TypeError: Invalid STEP file: missing 'ISO-10303-21;'/);
  assert.throws(
    () => parseSTEP(header + "#1=PRODUCT('a','b','',(#2)\nENDSEC;\n"),
    /^TypeError: Invalid STEP file: unterminated entity instance at line \d+; export it again from the CAD tool$/,
  );
  assert.throws(
    () => parseSTEP(header + "#1=PRODUCT_DEFINITION('a','',$,$) X;\n" + footer),
    /#1: text after the parameters at line 8/,
  );
  assert.throws(() => parseSTEP(header + '#1=A(1);\n#1=B(2);\n' + footer), /#1 is defined twice at line 9/);
  assert.throws(() => parseSTEP(header + 'oops;\n' + footer), /expected '#' or ENDSEC/);
  assert.throws(
    () => parseSTEP(header + footer, { maxInstances: 0 }),
    /^RangeError: maxInstances must be a positive integer$/,
  );
  assert.equal(stepText(new Uint8Array([0x49, 0xe9])), 'Ié', 'bytes read as ISO 8859-1');
});
