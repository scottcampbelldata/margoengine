// Build the authored structural and services model for Inside the Concert Hall.
import { libraryFile } from './library.mjs';
import { writeFile } from 'node:fs/promises';

const output = libraryFile('technical-films/cedar-hall.ifc');
const rows = [];
const line = (statement) => {
  const id = '#' + (rows.length + 1);
  rows.push(id + '=' + statement + ';');
  return id;
};
const scalar = (n) => (Number.isInteger(n) ? n + '.' : String(+n.toFixed(6)));
const vector = (v) => '(' + v.map(scalar).join(',') + ')';
const text = (value) => "'" + value.replaceAll("'", "''") + "'";
let serial = 0;
const guid = () => text('2CedarHallSection00' + (++serial).toString(36).padStart(3, '0'));
const origin = line('IFCCARTESIANPOINT((0.,0.,0.))');
const up = line('IFCDIRECTION((0.,0.,1.))');
const axis = line('IFCAXIS2PLACEMENT3D(' + origin + ',$,$)');
const profileOrigin = line('IFCCARTESIANPOINT((0.,0.))');
const profileX = line('IFCDIRECTION((1.,0.))');
const profileAxis = line('IFCAXIS2PLACEMENT2D(' + profileOrigin + ',' + profileX + ')');
const model = line("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001," + axis + ',$)');
const unit = line('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
const units = line('IFCUNITASSIGNMENT((' + unit + '))');
const project = line('IFCPROJECT(' + guid() + ",$,'Cedar Hall',$,$,$,$,(" + model + '),' + units + ')');
const buildingLocation = line('IFCLOCALPLACEMENT($,' + axis + ')');
const building = line('IFCBUILDING(' + guid() + ",$,'Cedar Hall',$,$," + buildingLocation + ',$,$,.ELEMENT.,$,$,$)');
const storey = line(
  'IFCBUILDINGSTOREY(' + guid() + ",$,'Upper service level',$,$," + buildingLocation + ',$,$,.ELEMENT.,9.1)',
);
line('IFCRELAGGREGATES(' + guid() + ',$,$,$,' + project + ',(' + building + '))');
line('IFCRELAGGREGATES(' + guid() + ',$,$,$,' + building + ',(' + storey + '))');

function surface(name, rgb) {
  const tint = line('IFCCOLOURRGB(' + text(name) + ',' + rgb.map(scalar).join(',') + ')');
  const shading = line('IFCSURFACESTYLESHADING(' + tint + ',0.)');
  return line('IFCSURFACESTYLE(' + text(name) + ',.BOTH.,(' + shading + '))');
}
const steel = surface('Graphite protected steel', [0.13, 0.21, 0.23]);
const brass = surface('Warm coated ductwork', [0.46, 0.31, 0.16]);
const grating = surface('Muted light steel catwalk', [0.29, 0.33, 0.3]);
const products = [];
function box(type, name, preset, [x, y, z], [width, height, depth], color) {
  const p = line('IFCCARTESIANPOINT(' + vector([x, -z, y - height / 2]) + ')');
  const bodyAxis = line('IFCAXIS2PLACEMENT3D(' + p + ',$,$)');
  const profile = line(
    'IFCRECTANGLEPROFILEDEF(.AREA.,$,' + profileAxis + ',' + scalar(width) + ',' + scalar(depth) + ')',
  );
  const solid = line('IFCEXTRUDEDAREASOLID(' + [profile, bodyAxis, up, scalar(height)].join(',') + ')');
  line('IFCSTYLEDITEM(' + solid + ',(' + color + '),$)');
  const representation = line('IFCSHAPEREPRESENTATION(' + model + ",'Body','SweptSolid',(" + solid + '))');
  const shape = line('IFCPRODUCTDEFINITIONSHAPE($,$,(' + representation + '))');
  products.push(
    line(type + '(' + guid() + ',$,' + text(name) + ',$,$,' + buildingLocation + ',' + shape + ',$,.' + preset + '.)'),
  );
}
for (let bay = 0; bay < 8; bay++) {
  const z = -14.35 + bay * 4.1;
  box('IFCBEAM', 'Roof transfer beam ' + (bay + 1), 'BEAM', [0, 10.72, z], [19, 0.55, 0.28], steel);
  for (const x of [-9.25, 9.25])
    box('IFCCOLUMN', 'Steel frame column ' + (bay + 1), 'COLUMN', [x, 5.45, z], [0.34, 10.55, 0.36], steel);
}
for (const side of [-1, 1]) {
  const name = side < 0 ? 'West' : 'East';
  const x = side * 6.7;
  box('IFCDUCTSEGMENT', name + ' main supply duct', 'RIGIDSEGMENT', [x, 10.04, 0.2], [0.89, 0.62, 29.4], brass);
  box('IFCSLAB', name + ' catwalk deck', 'LANDING', [side * 7.93, 8.34, 0.4], [1.05, 0.13, 29], grating);
  for (let bay = 0; bay < 8; bay++) {
    const z = -13.7 + bay * 3.85;
    box(
      'IFCDUCTSEGMENT',
      name + ' supply branch ' + (bay + 1),
      'RIGIDSEGMENT',
      [side * 4.6, 9.86, z],
      [4.1, 0.36, 0.38],
      brass,
    );
    box(
      'IFCDUCTSEGMENT',
      name + ' diffuser drop ' + (bay + 1),
      'RIGIDSEGMENT',
      [side * 2.72, 9.39, z],
      [0.38, 0.88, 0.38],
      brass,
    );
  }
}
line('IFCRELCONTAINEDINSPATIALSTRUCTURE(' + guid() + ',$,$,$,(' + products.join(',') + '),' + storey + ')');
await writeFile(
  output,
  [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');",
    "FILE_NAME('cedar-hall.ifc','2026-11-22T00:00:00',('Margo Engine Showcase'),(''),'', 'Margo Engine', '');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...rows,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n'),
);
