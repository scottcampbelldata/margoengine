import test from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../dist/index.js';

for (const kind of ['cube', 'wedge', 'cylinder']) {
  for (const operation of ['extrude', 'inset', 'extrude-inset', 'double-extrude']) {
    test(`test-page 44: ${kind} ${operation} bevel remains planar, closed and editable`, () => {
      let serial = 0;
      const options = { createId: () => `edit-${serial++}` };
      let source = K.createPrimitiveMesh(kind, kind);
      if (operation.includes('extrude'))
        source = K.extrudeMeshFace(source, source.faces.at(-1).id, 0.3, options).mesh;
      if (operation === 'double-extrude')
        source = K.extrudeMeshFace(source, source.faces.at(-1).id, 0.3, options).mesh;
      if (operation.includes('inset'))
        source = K.insetMeshFace(source, source.faces[0].id, 0.25, options).mesh;
      const before = structuredClone(source);
      const result = K.bevelPolygonMesh(source, 0.12, options);
      assert.deepEqual(source, before);
      const byId = new Map(result.mesh.faces.map(face => [face.id, face]));
      assert.equal(byId.size, result.mesh.faces.length);
      for (const face of result.mesh.faces) {
        assert.equal(K.polygonGeometryError(face.vertices.map(i => result.mesh.vertices[i])), null, face.id);
        assert.equal(face.uv.length, face.vertices.length);
        assert.ok(face.uv.every(p => p.length === 2 && p.every(v => v >= 0 && v <= 1)));
      }
      for (const edge of K.polygonMeshEdges(result.mesh)) {
        assert.equal(edge.incidences.length, 2, edge.id);
        assert.equal(edge.incidences[0].from, edge.incidences[1].to, edge.id);
        assert.equal(edge.incidences[0].to, edge.incidences[1].from, edge.id);
      }
      for (const old of source.faces) {
        assert.ok(result.faceMap[old.id].includes(old.id));
        assert.ok(result.faceMap[old.id].every(id => byId.has(id)));
        assert.deepEqual(byId.get(old.id).uv, old.uv);
      }
      for (const id of result.createdFaces)
        assert.ok(Object.values(result.faceMap).some(ids => ids.includes(id)), id);
      assert.ok(K.compilePolygonMesh(result.mesh).indices.length > 0);
      const extruded = K.extrudeMeshFace(result.mesh, result.mesh.faces[0].id, 0.03, options);
      assert.doesNotThrow(() => K.insetMeshFace(extruded.mesh, extruded.mesh.faces[0].id, 0.04, options));
    });
  }
}
