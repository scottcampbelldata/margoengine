# @margoengine/ifc

IFC geometry and BIM identifiers using a caller-owned, initialized `web-ifc` runtime. The IFC Wasm parser stays outside the frozen core and stage facade.

```ts
import {IfcAPI} from 'web-ifc';
import {parseIFC} from '@margoengine/ifc';
import {Engine} from '@margoengine/core';
import {fetchBytes,createMeshes} from '@margoengine/loaders';

const api=new IfcAPI();
api.SetWasmPath('/ifc/'); // browser: serve web-ifc.wasm here; Node can use Init() directly
await api.Init();
const model=parseIFC(api,await fetchBytes('/building.ifc'),{maxTriangles:2_000_000});
const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas);
const loaded=createMeshes(engine,model);
console.log(model.schema,model.products); // expressID, IFC type, GlobalId and name
engine.start();
// loaded.dispose() removes meshes; dispose the engine on application teardown.
```

Install `web-ifc@0.0.78` with the matching core/loaders/IFC packages, or build the local workspaces. Geometry support follows [web-ifc](https://github.com/ThatOpen/engine_web-ifc); browser deployments must serve its Wasm assets separately. web-ifc is MPL-2.0 licensed; this adapter is MIT licensed.

`parseIFC(api, Uint8Array, options)` returns `LoadedGeometry` plus `schema` and `products`. Each placed geometry becomes a named/color group, with the source element's `expressID` in `objectId`. Positions are transformed to world space in meters, reflected winding is corrected and normals are computed. Core `Geometry` limits still apply to `createMeshes`; split oversized groups before rendering.

Opened models are closed in `finally`, including geometry/limit failures. Arrays are copied from the Wasm heap and remain usable after closure. The caller retains its initialized API. Options include `maxVertices`, `maxTriangles`, `maxBytes` (256 MiB default), `signal` and native `settings`. Schema aliases are rejected unless explicitly enabled in settings.

Tessellation is synchronous; aborts are checked before opening and between callbacks, and cannot interrupt native tessellation. Use a worker for large files. Property sets, relationships, editable native models and BIM navigation UI are not retained. Colors follow web-ifc geometry styles; core does not render transparent IFC surfaces.

`npm test` passes a real IFC4 millimeter wall through Wasm and checks units, placement, triangles, names/IDs, mesh disposal, limits and model closure after failures. Build with root `npm run build:packages` or local `npm run build`. The package is local and has not been published.
