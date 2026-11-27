import { parseSTEP, parseIGES, readIGES, tessellateSTEP } from '@margoengine/brep';
import fixture from './assets/assembly-fixture.step?raw';
import conics from './assets/conics.igs?raw';
import cylinder from './assets/cylinder.igs?raw';
import mounting from './assets/mounting-plate.step?raw';
import trimmed from './assets/trimmed-plate.igs?raw';
import upright from './assets/upright-bracket.step?raw';
import { jobs } from './samples.js';

const sources = {
  upright: [upright, 'step'], cylinder: [cylinder, 'iges'], mounting: [mounting, 'step'],
  trimmed: [trimmed, 'iges'], conics: [conics, 'iges'], fixture: [fixture, 'step'],
};

const entityNames = {
  100: 'Circular arc', 102: 'Composite curve', 104: 'Conic arc', 106: 'Copious data',
  110: 'Line', 116: 'Point', 123: 'Direction', 124: 'Transformation',
  128: 'Rational B-spline surface', 142: 'Curve on surface', 144: 'Trimmed surface',
  186: 'Manifold solid', 190: 'Plane surface', 192: 'Cylindrical surface',
  502: 'Vertex list', 504: 'Edge list', 508: 'Loop', 510: 'Face', 514: 'Shell',
};

function pack(text, format) {
  const model = (format === 'step' ? parseSTEP : parseIGES)(text);
  const bodies = tessellateSTEP(model, { relativeDeflection: .0008, angle: .12 });
  const warnings = [...model.warnings];
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  const meshes = model.instances.map(({ body, matrix, occurrence }) => {
    const source = bodies[body], { unit, indices } = source;
    const xyz = new Float32Array(source.positions.length), normals = new Float32Array(xyz.length);
    for (let i = 0; i < xyz.length; i += 3) {
      const x = source.positions[i] * unit, y = source.positions[i + 1] * unit, z = source.positions[i + 2] * unit;
      xyz[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      xyz[i + 1] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      xyz[i + 2] = -(matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]);
      const nx = source.normals[i], ny = source.normals[i + 1], nz = source.normals[i + 2];
      normals[i] = matrix[0] * nx + matrix[4] * ny + matrix[8] * nz;
      normals[i + 1] = matrix[2] * nx + matrix[6] * ny + matrix[10] * nz;
      normals[i + 2] = -(matrix[1] * nx + matrix[5] * ny + matrix[9] * nz);
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis], xyz[i + axis]);
        high[axis] = Math.max(high[axis], xyz[i + axis]);
      }
    }
    warnings.push(...source.failures.map(({ id, reason }) => 'Face #' + id + ' ' + reason));
    return { xyz, normals, indices: indices.slice(), occurrence, body, bodyId: source.id };
  });

  const tree = model.occurrences.map(({ product, parent }, index) => ({
    parent, index, ...model.products[product],
  }));
  const iges = format === 'iges' ? readIGES(text) : null;
  const directory = iges ? [...iges.entities.values()].map(({ de, type, form }) => ({
    de, type, form, label: entityNames[type] ?? 'IGES entity',
  })) : [];
  return {
    meshes, tree, directory, low, high, warnings, surfaces: model.census.surfaces,
    bodyCount: bodies.length, sourceCount: iges ? directory.length : model.file.size,
    triangles: meshes.reduce((total, mesh) => total + mesh.indices.length / 3, 0),
    schema: iges ? 'IGES 5.3' : model.header.schema[0]?.startsWith('AUTOMOTIVE_DESIGN') ? 'STEP AP214' : 'STEP Part 21',
    units: iges ? iges.global.unitsName : bodies.every(body => body.unit === .001) ? 'mm' : 'm',
  };
}

for (const id of jobs) {
  const [text, format] = sources[id];
  try {
    const sample = pack(text, format);
    const transferred = sample.meshes.flatMap(({ xyz, normals, indices }) => [xyz.buffer, normals.buffer, indices.buffer]);
    self.postMessage({ id, sample }, transferred);
  } catch (reason) {
    self.postMessage({ id, error: reason.message });
  }
}
