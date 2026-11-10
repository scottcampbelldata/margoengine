import { box, PbrMaterial } from '@margoengine/core';
import { parseSTL, toGeometry } from '@margoengine/loaders';
import { parseUSDZ } from '@margoengine/usdz';
import { parseFBX } from '@margoengine/fbx';
import { createPrimitiveMesh, extrudeMeshFace, compilePolygonMesh } from '@margoengine/mesh-edit';
import { Selection } from '@margoengine/selection';
import { CameraProjection } from '@margoengine/cameras';
import { cadControls, SOLIDWORKS } from '@margoengine/controls';
import { LODSystem } from '@margoengine/lod';
import { CulledInstances } from '@margoengine/culling';
import { exportSTL, exportGLB } from '@margoengine/exporters';
import { exportUSDZ } from '@margoengine/exporters/usdz';
import { check, expose } from './harness.ts';

expose('engineering', async (engine) => {
  const polygon = createPrimitiveMesh('cube', 'part');
  const edited = extrudeMeshFace(polygon, 'part-face-0', 0.25);
  const compiled = compilePolygonMesh(edited.mesh);
  const high = toGeometry({
    kind: 'mesh',
    positions: new Float32Array(compiled.positions),
    normals: new Float32Array(compiled.normals),
    indices: new Uint32Array(compiled.indices),
  });
  const part = engine
    .createMesh()
    .setGeometry(high)
    .setMaterial(new PbrMaterial({ color: '#84d6bd' }));
  const stl = exportSTL(engine);
  check(stl instanceof Uint8Array, 'binary STL export missing');
  const loaded = parseSTL(stl);
  const roundtrip = engine
    .createMesh()
    .setGeometry(toGeometry(loaded))
    .setPosition([-2, 0, 0])
    .setMaterial(new PbrMaterial({ color: '#d68484' }));
  const usd = await parseUSDZ(exportUSDZ(engine));
  const usdModel = await usd.create(engine);
  usdModel.root.setPosition([0, 0, -2]);
  const fbx = await parseFBX(
    engine,
    new TextEncoder().encode(`; FBX 7.4.0 Margo-authored triangle
FBXHeaderExtension: { FBXVersion: 7400 }
Objects: {
 Geometry: 1, "Geometry::Triangle", "Mesh" {
  Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
  PolygonVertexIndex: *3 { a: 0,1,-3 }
 }
 Model: 2, "Model::Triangle", "Mesh" { }
}
Connections: { C: "OO",1,2
 C: "OO",2,0
}
`),
    { signal: AbortSignal.timeout(30_000) },
  );
  fbx.root.setPosition([2, 0, 0]);
  const projection = CameraProjection.attach(engine, { height: 5 });
  const controls = cadControls(engine, { profile: SOLIDWORKS });
  const lods = LODSystem.attach(engine);
  const lod = lods.add(part, [{ object: high }, { object: box(), distance: 40 }]);
  const transforms = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, -1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2000, 0, 0, 1,
  ]);
  const culled = CulledInstances.attach(
    engine,
    [{ geometry: box(0.3, 0.3, 0.3), material: new PbrMaterial({ color: '#c9ccd1' }), transforms }],
    { culling: 'frustum' },
  );
  const selection = Selection.attach(engine, { width: 2, color: [1, 0.5, 0] });
  selection.set([part]);
  return {
    async assert() {
      const counts = await culled.readCounts();
      check(counts[0] === 1, 'frustum culling did not keep exactly the visible part');
      check(loaded.indices?.length === compiled.indices.length, 'STL round trip changed triangle count');
      check(usdModel.primitives.length === 2 && fbx.primitives.length === 1, 'public format models missing');
      const glb = exportGLB(engine),
        header = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
      check(header.getUint32(0, true) === 0x46546c67 && header.getUint32(4, true) === 2, 'GLB scene header invalid');
      const document = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + header.getUint32(12, true))));
      check(document.asset.version === '2.0' && document.meshes.length >= 5, 'GLB scene geometry missing');
      check(lod.level === 0, 'near LOD missing');
      check(projection.mode === 'orthographic', 'CAD projection missing');
      return {
        stlTriangles: loaded.indices.length / 3,
        usdPrimitives: usdModel.primitives.length,
        fbxPrimitives: fbx.primitives.length,
        culledCounts: [...counts],
        meshEdit: true,
        orthographic: true,
        navigationProfile: 'SOLIDWORKS',
      };
    },
    dispose() {
      selection.dispose();
      culled.dispose();
      lods.dispose();
      controls.dispose();
      projection.dispose();
      fbx.dispose();
      usdModel.dispose();
      roundtrip.dispose();
      part.dispose();
    },
  };
});
