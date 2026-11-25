// Owner/lifetime fixture for @margoengine/fbx. Every import function returns a gltf/pbrModel registered in the scene
// the call started in; `model.dispose()` releases it. The ASCII and binary files are inline (one quad, `grid(1)` from
// ./fixtures.js), so the browser leaves read no files; the binary one has deflated arrays, which runs the stream reader
// that subscribes to the app's signal. The optional entries are hooks on the import (no lifetime of their own), passed
// together in one load. `exportFBX` is a pure writer and holds nothing. In a browser `parseFBXInWorker` runs the real
// worker; in Node it runs on this thread.
const ascii = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXVersion: 7400
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis","int","","A",1
		P: "UnitScaleFactor","double","","A",1
	}
}
Objects:  {
	Geometry: 100,"Geometry::Grid","Mesh" {
		Vertices: *12 {
			a: -2,0,-2,2,0.03,-2,-2,0,2,2,0.03,2
		}
		PolygonVertexIndex: *4 {
			a: 0,2,3,-2
		}
		LayerElementNormal: 0 {
			MappingInformationType: "ByVertice"
			ReferenceInformationType: "Direct"
			Normals: *12 {
				a: 0,1,0,0,1,0,0,1,0,0,1,0
			}
		}
		LayerElementUV: 0 {
			MappingInformationType: "ByVertice"
			ReferenceInformationType: "Direct"
			UV: *8 {
				a: 0,0,1,0,0,1,1,1
			}
		}
	}
	Model: 200,"Model::Grid","Mesh" {
		Version: 232
		Properties70:
	}
	Material: 300,"Material::Grey","" {
		ShadingModel: "phong"
		Properties70:  {
			P: "Diffuse","Vector3D","","A",0.7,0.7,0.7
		}
	}
}
Connections:  {
	C: "OO",200,0
	C: "OO",100,200
	C: "OO",300,200
}
`;
// binary(grid(1), { compress: true }) from ./fixtures.js, 1538 bytes.
const binary64 =
  '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';
const binary = () => Uint8Array.from(atob(binary64), (c) => c.charCodeAt(0));
const text = () => new TextEncoder().encode(ascii);

// The app's own signal outlives the load: whatever the importer subscribes on it must go when the load settles.
const signal = () => new AbortController().signal;
const files = (bytes) => async (input, init) => {
  init?.signal?.throwIfAborted();
  return new URL(String(input)).pathname.endsWith('.fbx')
    ? new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
    : new Response('missing', { status: 404 });
};

export async function fixtures(load = (entry) => import(entry)) {
  const { parseFBX, loadFBX } = await load('../dist/index.js');
  const { parseFBXInWorker } = await load('../dist/worker.js');
  const extensions = await Promise.all([
    load('../dist/scene-extras.js').then((m) => m.sceneExtras),
    load('../dist/layers.js').then((m) => m.animationLayers),
    load('../dist/deformers.js').then((m) => m.deformers),
    load('../dist/curves.js').then((m) => m.nurbsCurves),
    load('../dist/pbr.js').then((m) => m.pbrMaterials),
    load('../dist/textures.js').then((m) => m.textures),
    load('../dist/large.js').then((m) => m.largeFBX()),
    load('../dist/legacy.js').then((m) => m.legacyFBX),
    load('../dist/surfaces.js').then((m) => m.surfaces),
  ]);
  const entries = [];
  // The CPU model draws no geometry, so it would not see a mesh left behind: after disposal every mesh must be gone.
  const model = (name, make) =>
    entries.push({
      name,
      async create({ engine }) {
        const plugin = await make(engine);
        const meshes = [plugin.root, ...plugin.nodes].filter(Boolean);
        if (!meshes.length) throw new Error('OWNER_FIXTURE: the model has no mesh');
        return {
          plugin,
          dispose: () => plugin.dispose(),
          check({ phase }) {
            if (phase === 'disposed' && meshes.some((m) => m.engine.meshes.get(m.id) === m))
              throw new Error('OWNER_LIFETIME: a disposed FBX model leaves meshes in the scene');
          },
        };
      },
    });
  model('parseFBX.ascii', (engine) => parseFBX(engine, text(), { signal: signal() }));
  model('parseFBX.binary', (engine) => parseFBX(engine, binary(), { signal: signal() }));
  model('parseFBX.extensions', (engine) => parseFBX(engine, text(), { signal: signal(), extensions }));
  model('loadFBX', (engine) =>
    loadFBX(engine, 'https://assets.example/grid.fbx', { fetch: files(binary()), signal: signal() }),
  );
  model('parseFBXInWorker', (engine) => parseFBXInWorker(engine, binary(), { signal: signal() }));
  return entries;
}
