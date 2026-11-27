import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const { model, parseSTEP, tessellateSTEP } = await import(pathToFileURL(resolve(checkout, 'packages/brep/dist/index.js')));
const copy = [
  ['examples/cad-viewer/plate.step', 'mounting-plate.step'],
  ['packages/brep/tests/fixtures/iges/plate.igs', 'trimmed-plate.igs'],
  ['packages/brep/tests/fixtures/iges/cylinder.igs', 'cylinder.igs'],
  ['packages/brep/tests/fixtures/iges/conics.igs', 'conics.igs'],
];
for (const [from, to] of copy) await copyFile(resolve(checkout, from), resolve(assets, to));

const testScript = await readFile(resolve(checkout, 'packages/brep/tests/step-structure.test.js'), 'utf8');
const fixtureBlock = (name) => {
  const marker = 'const ' + name + ' = String.raw' + String.fromCharCode(96);
  const start = testScript.indexOf(marker);
  assert.ok(start >= 0);
  return testScript.slice(start + marker.length, testScript.indexOf(String.fromCharCode(96), start + marker.length));
};
const fixture = ['header','part','assembly'].map(fixtureBlock).join('') + 'ENDSEC;\nEND-ISO-10303-21;\n';
const fixtureTree = parseSTEP(fixture);
assert.equal(fixtureTree.occurrences.length, 2);
await writeFile(resolve(assets,'assembly-fixture.step'), fixture);

const points = [[0,0,0],[.033,0,0],[.034,0,.009],[.023,0,.020],[.020,0,.053],[.016,0,.068],[.006,0,.074],[0,0,.067],[0,0,0]];
const pieces = [
  {
    tag: 'B-101', title: 'Milled mounting base',
    body: model.box('Milled mounting base', [.106,.072,.011]),
  },
  {
    tag: 'B-114', title: 'Tapered upright',
    body: model.extrude('Tapered upright', {
      name: 'Upright profile', start: points[0], normal: [0,-1,0],
      segments: points.slice(1).map((to)=>({kind:'line',to})),
    }, [0,.018,0]),
  },
  {
    tag: 'B-122', title: 'Retaining pin',
    body: model.cylinder('Retaining pin', .0058, .018),
  },
];
const occurrences = [
  [0,'Base datum',[0,0,0],[1,0,0]],
  [1,'Port upright',[.014,.015,.011],[1,0,0]],
  [1,'Starboard upright',[.092,.057,.011],[-1,0,0]],
  [2,'Port pin',[.023,.052,.011],[1,0,0]],
  [2,'Starboard pin',[.083,.020,.011],[1,0,0]],
];

const rows = [], headers = [];
let base = 0;
function add(record) {
  rows.push('#' + (++base) + '=' + record + ';');
  return base;
}

const sources = pieces.map(({ body, tag, title }) => {
  const source = model.bodiesToSTEP([body]);
  headers.push(source.slice(0, source.indexOf('DATA;')));
  const input = parseSTEP(source);
  const get = (type) => input.file.ids(type)[0];
  const conversion = base;
  const absolute = (ref) => ref.id + conversion;
  const product = get('PRODUCT'), context = absolute(input.file.args(product)[3][0]);
  const def = get('PRODUCT_DEFINITION');
  const rep = get('SHAPE_REPRESENTATION');
  const frame = absolute(input.file.args(rep)[1][0]);
  const repContext = absolute(input.file.args(rep)[2]);
  const appContext = absolute(input.file.args(context-conversion)[1]);
  const definitionContext = absolute(input.file.args(def)[3]);
  const data = source.match(/\bDATA;\s*([\s\S]*?)ENDSEC;/)[1].trim();
  let max = base;
  rows.push(data.split(/\r?\n/).map((row) => {
    if (row.startsWith('#' + product + '=')) row = '#' + product + "=PRODUCT('" + tag + "','" + title + "','',(#" + (context - conversion) + "));";
    return row.replace(/#(\d+)/g, (_, value) => {
      const number = Number(value) + conversion;
      max = Math.max(number, max);
      return '#' + number;
    });
  }).join('\n'));
  base = max;
  return { context, def: def+conversion, rep: rep+conversion, frame, repContext, appContext, definitionContext };
});

const first = sources[0];
const product = add("PRODUCT('SHELF-01','Upright bracket assembly','',(#" + first.context + '))');
const formation = add("PRODUCT_DEFINITION_FORMATION('','',#" + product + ')');
const definition = add("PRODUCT_DEFINITION('design','',#" + formation + ',#' + first.definitionContext + ')');
const productShape = add("PRODUCT_DEFINITION_SHAPE('','',#" + definition + ')');
const up = add("DIRECTION('',(0.,0.,1.))");
const locations = occurrences.map(([, , position, x]) => {
  const origin = add("CARTESIAN_POINT('',(" + position.map((v)=>v.toFixed(6)).join(',') + '))');
  const axis = add("DIRECTION('',(" + x.map((v)=>v.toFixed(6)).join(',') + '))');
  return add("AXIS2_PLACEMENT_3D('',#" + origin + ',#' + up + ',#' + axis + ')');
});
const parentRep = add("SHAPE_REPRESENTATION('',(" + locations.map((id)=>'#'+id).join(',') + '),#' + first.repContext + ')');
add('SHAPE_DEFINITION_REPRESENTATION(#' + productShape + ',#' + parentRep + ')');
for (const [i,[piece,label]] of occurrences.entries()) {
  const child = sources[piece];
  const occurrence = add("NEXT_ASSEMBLY_USAGE_OCCURRENCE('" + (i + 1) + "','" + label + "','',#" + definition + ',#' + child.def + ',$)');
  const usage = add("PRODUCT_DEFINITION_SHAPE('','',#" + occurrence + ')');
  const transform = add("ITEM_DEFINED_TRANSFORMATION('','',#" + child.frame + ',#' + locations[i] + ')');
  const placement = add("(REPRESENTATION_RELATIONSHIP('','',#" + child.rep + ',#' + parentRep +
    ')REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#' + transform + ')SHAPE_REPRESENTATION_RELATIONSHIP())');
  add('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#' + placement + ',#' + usage + ')');
}
const header = headers[0].replace(/FILE_NAME\('[^']*'/, "FILE_NAME('upright-bracket.step'");
const step = header + 'DATA;\n' + rows.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
const check = parseSTEP(step);
assert.deepEqual(check.warnings, []);
assert.equal(check.instances.length, occurrences.length);
assert.equal(check.roots.length, 1);
assert.equal(check.occurrences.length, 6);
assert.equal(check.products[check.roots[0]].name, 'Upright bracket assembly');
check.instances.forEach((instance, index) => {
  assert.deepEqual(Array.from(instance.matrix.slice(12,15)), occurrences[index][2]);
});
const meshes = tessellateSTEP(check, { relativeDeflection: .001, angle: .15 });
assert.ok(meshes.every((mesh)=>mesh.indices.length && !mesh.failures.length));
await writeFile(resolve(assets,'upright-bracket.step'), step);
console.log(check.products, meshes.map((mesh)=>mesh.indices.length / 3));
