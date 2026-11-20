# @margoengine/ifc

Import `margoengine/ifc` from the `margoengine` package, or `@margoengine/ifc` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

IFC geometry and BIM identifiers using a caller-owned, initialized `web-ifc` runtime. The IFC Wasm parser stays outside the frozen core and stage facade.

```ts
import {IfcAPI} from 'web-ifc';
import {parseIFC} from 'margoengine/ifc';
import {Engine} from 'margoengine/core';
import {fetchBytes,createMeshes} from 'margoengine/loaders';

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

Install `web-ifc@0.0.78` with the matching core/loaders/IFC packages, or build the local workspaces. Geometry support follows [web-ifc](https://github.com/ThatOpen/engine_web-ifc); browser deployments must serve its Wasm assets separately. web-ifc is MPL-2.0 licensed; this adapter is Apache-2.0 licensed.

For files from users, use the worker entry: web-ifc 0.0.78 can loop forever inside its Wasm on schema-invalid models (a string where a list belongs, a missing attribute), which no check in front of it can rule out, and `parseIFC` on the page would hang the tab. `parseIFCInWorker` runs it in a fresh worker that loads your web-ifc build and is terminated after `timeoutMs` (default 60,000 ms) with `LoaderError` code `limit`:

```js
import {parseIFCInWorker} from 'margoengine/ifc/worker';
import {fetchBytes} from 'margoengine/loaders';

const bytes=await fetchBytes('/building.ifc'); // or the bytes of a File the user picked
const model=await parseIFCInWorker(bytes,{webIfc:'/ifc/web-ifc-api-iife.js',wasmPath:'/ifc/',timeoutMs:30_000});
```

## BIM data: properties, quantities, types, materials, spatial tree, units, georeference

`openIFC` checks and opens the bytes once; every reader takes the handle, and `close()` releases it. `readIFCData` returns plain, structured-cloneable data: every object definition (products, storeys, spaces, types, groups, the project) with its attributes, property sets (predefined ones such as IfcDoorPanelProperties included, their attributes as properties) and quantity sets, type, materials (layers, profiles and constituents included), classifications and relations, the spatial tree, the project units and the georeference; `materialProperties` holds the property sets of materials (IfcMaterialProperties, IFC2X3 IfcExtendedMaterialProperties) by the material's expressID, and a table property keeps its `defining` column beside its defined values. Every measure is converted to SI (m, m2, m3, kg, s, rad, K, ...) by the project's unit assignment, prefixed, conversion based (feet, square feet), with offset (degrees Fahrenheit) or derived; `raw` keeps the value as written.

```js
import {IfcAPI} from 'web-ifc';
import {openIFC,readIFCGeometry} from 'margoengine/ifc';
import {readIFCData,propertiesOf,materialsOf,modelToMap} from 'margoengine/ifc/data';
import {fetchBytes} from 'margoengine/loaders';

const api=new IfcAPI();
api.SetWasmPath('/ifc/');
await api.Init();
const model=openIFC(api,await fetchBytes('/building.ifc'));
const data=readIFCData(model);
const geometry=readIFCGeometry(model,{origin:'auto'}); // vertices relative to geometry.origin, in float64 before float32
model.close();

for(const [id,element] of data.elements){
  if(element.type!=='IfcWall')continue;
  const props=propertiesOf(data,id); // type properties merged, occurrence values win
  console.log(element.name,props.Pset_WallCommon?.FireRating?.value,props.Qto_WallBaseQuantities?.NetSideArea?.value,'m2');
  console.log(materialsOf(data,id).map((m)=>`${m.name} ${m.thickness ?? ''}`));
}
const storeys=data.spatial?.children[0]?.children[0]?.children ?? []; // project > site > building > storeys
for(const storey of storeys)console.log(storey.name,storey.elevation,'m',storey.elements.length,'elements');
if(data.georeference)console.log(data.georeference.crs?.name,modelToMap(data.georeference,[0,0,0]));
```

| Function | Returns |
| --- | --- |
| `openIFC(api, bytes, {maxBytes, signal, settings})` | An `IFCModel` handle (`close()`, `using`). Same checks as `parseIFC`. |
| `readIFCGeometry(model, {maxVertices, maxTriangles, signal, origin})` | What `parseIFC` returns, from an open model. `origin: 'auto'` (or a point) is subtracted in float64 before float32 storage and returned as `origin`; default none. |
| `readIFCData(model, {signal, properties})` | `{schema, units, elements, byGlobalId, spatial, georeference}`; `properties: false` skips property sets. |
| `propertiesOf(data, id)` / `propertyOf(data, id, set, name)` | Property and quantity sets with the type's merged in; an occurrence property overrides the type's of the same set and name. |
| `materialsOf(data, id)` / `classificationsOf(data, id)` | The element's materials (the type's when it has none) and classifications (with the type's). |
| `modelToMap(geo, p)` / `mapToModel(geo, p)` | IFC model coordinates (meters, Z up) to map coordinates (map units) by IfcMapConversion, and back. |
| `ifcToEngine(p, origin)` / `engineToIFC(p, origin)` | IFC axes (Z up) to engine axes (Y up, as the geometry is written) and back, with a rebased origin. |

Each element's `storey` is the nearest IfcBuildingStorey up its containment, aggregation, nesting or opening chain; `container`, `aggregate`, `nest`, `references`, `voids`, `fills` and `groups` keep the relations themselves. The spatial tree starts at the IfcProject; aggregated children come first (spatial elements before element parts), and each spatial node lists the IDs it contains. `georeference.source` says where it came from: IfcMapConversion or IfcMapConversionScaled (IFC4 and later), the ePSet_MapConversion and ePSet_ProjectedCRS property sets (IFC2x3), or only IfcSite's RefLatitude, RefLongitude and RefElevation (decimal degrees and meters). `trueNorth` is the model context's TrueNorth as an anticlockwise angle from +Y. IfcMapConversion's Scale defaults to 1 as the schema defines it, so a file in millimetres with eastings in meters must state Scale 0.001.

Sources: buildingSMART IFC 4.3 ADD2 documentation (IfcMapConversion, IfcSIUnit, IfcConversionBasedUnit, IfcConversionBasedUnitWithOffset; https://github.com/buildingSMART/IFC4.3.x-development); BIPM, The International System of Units, 9th edition, 2019 (prefixes before powers).

## Find and classify elements

`findElements(data, query)` returns the expressIDs matching every given field: IFC class (with its subtypes, by the model's schema), effective predefined type, type object, storey, any ancestor (`within` a building, space or assembly), name, GlobalId, material (name, category or layer), classification (system and code) and property conditions. Conditions read type properties too, compare numbers in SI with the IDS 1.0 tolerance, and take `=`, `!=`, `<`, `<=`, `>`, `>=`, `contains` (no case), `matches` (a regular expression), `exists` or `missing`. `groupElements(data, by, ids)` is the classifier: by class, predefined type, type object, storey, material, classification or a property's value.

```js
import {IfcAPI} from 'web-ifc';
import {openIFC} from 'margoengine/ifc';
import {readIFCData} from 'margoengine/ifc/data';
import {findElements,groupElements,descendantsOf,subtypesOf} from 'margoengine/ifc/query';
import {fetchBytes} from 'margoengine/loaders';

const api=new IfcAPI();
api.SetWasmPath('/ifc/');
await api.Init();
const model=openIFC(api,await fetchBytes('/building.ifc'));
const data=readIFCData(model);
model.close();

const external=findElements(data,{type:['IfcWall','IfcCurtainWall'],where:[{set:'Pset_WallCommon',name:'IsExternal',value:true}]});
const thick=findElements(data,{type:'IfcWall',where:[{name:'Width',op:'>=',value:0.25}]}); // meters, whatever the file's units
const level1=findElements(data,{storey:'Level 1'});
const glazed=findElements(data,{material:/glass/i});
const walls=findElements(data,{type:'IfcWall'}); // IfcWallStandardCase and IfcWallElementedCase too
const plainWalls=findElements(data,{type:'IfcWall',subtypes:false});
console.log(external.length,thick.length,level1.length,glazed.length,walls.length,plainWalls.length);
console.log(subtypesOf(data.schema,'IfcBuildingElement').length,'classes are building elements in',data.schema);
for(const [storey,ids] of groupElements(data,'storey'))console.log(storey||'(no storey)',ids.length);
const [building]=findElements(data,{type:'IfcBuilding'});
if(building!==undefined)console.log(descendantsOf(data,building).length,'elements below the first building');
```

`effectivePredefinedType(data, id)` resolves the predefined type as IDS 1.0 does (the type object's first; USERDEFINED takes the type's ElementType, ProcessType or ResourceType, or the occurrence's ObjectType). `ancestorsOf` and `descendantsOf` walk the containment, aggregation, nesting and opening relations.

A class filter follows the IFC inheritance of the model's schema: `IfcWall` finds `IfcWallStandardCase`, `IfcBuildingElement` (IFC2X3, IFC4) or `IfcBuiltElement` (IFC4X3) finds every wall, slab, door and window, and `IfcSpatialStructureElement` finds sites, buildings, storeys and spaces. IFC4 and IFC4X3 models use their own schema's tree. No IFC2X3 tree ships, because the IFC2X3 EXPRESS file reserves all rights and nothing is derived from it; instead `readIFCData` records an IFC2X3 model's inheritance from the open web-ifc runtime (`data.inheritance`, one inherited lookup per entity type of the schema), so an IFC2X3 model's class filters follow IFC2X3 itself: `IfcBuildingElementComponent` finds reinforcing bars and `IfcElement` finds an `IfcElectricalElement`. `isSubtypeOf(data, type, ancestor)` answers from the same record; given only the schema name `IFC2X3`, the three functions use the IFC4 tree, where an IFC2X3-only class matches only itself. `subtypes: false` matches the exact classes only, as an IDS 1.0 entity facet does. `isSubtypeOf(schema, type, ancestor)`, `supertypesOf(schema, type)` and `subtypesOf(schema, type)` answer the same questions directly; the tree covers every class below IfcObjectDefinition, read from buildingSMART's published IFC4 and IFC4X3 EXPRESS schemas (see NOTICE.md).

## BCF issues and viewpoints

`margoengine/ifc/bcf` reads and writes BCF, the BIM Collaboration Format, so issues travel between Margo and BIM tools. `readBCF(bytes)` reads a `.bcf` archive of BCF 3.0, 2.1, 2.0 or 1.0: project, extensions, documents, and every topic with its markup (type, status, priority, labels, dates, assignee, due date, stage, description, referenced IFC files, snippet, document references, related topics), comments, viewpoints (in Index order), snapshots and bitmaps. `writeBCF(archive, {version})` writes BCF 3.0 (default) or 2.1. `parseBCFViewpoint` and `writeBCFViewpoint` handle one `.bcfv`; `viewpointFromBCFJSON` and `viewpointToBCFJSON` speak the BCF-API 3.0 JSON of BCF servers, snapshots and bitmaps as base64.

`viewFromBCF(viewpoint, data, {origin})` turns a viewpoint into a Margo view: the camera in engine axes (`position`, `target`, `up`, `fov` in degrees for a core Camera, or `height` for an orthographic `CameraProjection`), the visible and hidden products applied in BCF's order (DefaultVisibility, then the space and opening hints, then the exceptions), the selection, colours (sRGB and alpha, 0 to 1), section planes ready for a material's `clippingPlanes`, and markup lines. A container listed in a viewpoint (a curtain wall, an assembly) applies to its parts; spatial structure does not (showing a storey does not show what it contains). Components match by IfcGuid, then by AuthoringToolId against the element's Tag; the rest are in `unresolved`. `bcfFromView(view, data)` goes the other way and follows BCF 3.0's encoding rules: the shorter of the hidden and visible lists becomes the exceptions, and spaces and openings that are all hidden go to the hints. BCF coordinates are the IFC world in meters, Z up; pass the same `origin` that `readIFCGeometry` rebased the geometry by.

```js
import {IfcAPI} from 'web-ifc';
import {openIFC} from 'margoengine/ifc';
import {readIFCData} from 'margoengine/ifc/data';
import {readBCF,writeBCF,viewFromBCF,bcfFromView,viewpointToBCFJSON,newBCFGuid} from 'margoengine/ifc/bcf';
import {fetchBytes} from 'margoengine/loaders';

const api=new IfcAPI();
api.SetWasmPath('/ifc/');
await api.Init();
const model=openIFC(api,await fetchBytes('/Architectural.ifc'));
const data=readIFCData(model);
model.close();

const archive=await readBCF(await fetchBytes('/v30-single-visible-space.bcf'));
const topic=archive.topics[0];
const view=viewFromBCF(topic.viewpoints[0],data); // pass {origin} when the geometry was rebased
console.log(topic.title,topic.status,view.visible.length,'shown',view.hidden.length,'hidden',view.camera?.fov);
// stage.camera.position=view.camera.position; stage.camera.target=view.camera.target; stage.camera.fov=view.camera.fov;

const viewpoint=bcfFromView({camera:{position:[10,8,10],target:[0,0,0],fov:60,aspect:16/9},hidden:view.hidden,selected:view.visible},data);
topic.viewpoints.push(viewpoint);
topic.comments.push({guid:newBCFGuid(),date:new Date().toISOString(),author:'me@example.com',comment:'Checked on site',viewpoint:viewpoint.guid});
const bcf=writeBCF(archive); // BCF 3.0; writeBCF(archive,{version:'2.1'}) for older tools
console.log(bcf.length,'bytes;',JSON.stringify(viewpointToBCFJSON(viewpoint)).length,'bytes of BCF-API JSON');
```

Errors are `LoaderError` with format `BCF`: `syntax` for a malformed file, `range` for a value BCF does not allow (a GUID that is not a lower-case UUID, a 3.0 viewpoint without a camera), `aborted` when the `signal` fires; the zip limits of `margoengine/loaders` apply to the archive. Unknown files and elements are ignored, as BCF asks.

## IDS checking

`margoengine/ifc/ids` reads, writes and checks IDS 1.0, buildingSMART's Information Delivery Specification: which entities must carry which classes, predefined types, attributes, classifications, properties, materials and part-of relations. `parseIDS(text or bytes)` reads an `.ids` file into plain objects (`info`, `specifications`, each with its `applicability` facets and `requirements` with their cardinality); `writeIDS(ids)` writes it back in the order ids.xsd requires, so documents can be authored or edited in code. `checkIDS(model, ids, {data, signal})` checks an open model and returns a report: per specification its status, the applicable expressIDs, those that passed, and one failure per unmet requirement with the element's class, GlobalId, name and the reason in words. `bcfTopicsFromIDS(report, {author, camera})` turns the failed specifications into BCF topics (the failing elements selected, one comment per failure) for `writeBCF`.

It agrees with every one of the 334 official IDS 1.0 test cases (pass, fail and invalid; `tests/fixtures/ids`). The checker follows the IDS rules: entities match their exact class, with IFC2X3's generic occurrences (an IfcFlowTerminal typed by an IfcAirTerminalType is an IFCAIRTERMINAL) as the IFC2X3 mapping table says; predefined types come from the type object first, and USERDEFINED answers to its custom name too; any entity can be checked, so attribute and property facets reach materials (IfcMaterialProperties, IfcExtendedMaterialProperties), predefined property sets (IfcDoorPanelProperties and the like) and the project; occurrence properties, classifications (per system) and materials override their type's; values compare case sensitively, numbers by type casting in SI with the IDS tolerance; list, enumerated, bounded and table properties pass on any matching value; and part-of relations are followed recursively.

```js
import {IfcAPI} from 'web-ifc';
import {openIFC} from 'margoengine/ifc';
import {parseIDS,writeIDS,checkIDS,bcfTopicsFromIDS} from 'margoengine/ifc/ids';
import {writeBCF} from 'margoengine/ifc/bcf';
import {fetchBytes} from 'margoengine/loaders';

const api=new IfcAPI();
api.SetWasmPath('/ifc/');
await api.Init();
const model=openIFC(api,await fetchBytes('/building.ifc'));
const ids=parseIDS(`<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Fire safety</title></info>
  <specifications>
    <specification name="Walls have a fire rating" ifcVersion="IFC2X3 IFC4">
      <applicability minOccurs="1" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <property dataType="IFCLABEL">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
          <value><xs:restriction base="xs:string"><xs:pattern value="[0-9]HR"/></xs:restriction></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`); // or parseIDS(await fetchBytes('/requirements.ids'))
const report=checkIDS(model,ids);
model.close();
for(const spec of report.specifications){
  console.log(spec.specification.name,spec.status,spec.passed.length,'of',spec.applicable.length,'pass');
  for(const failure of spec.failures)console.log(' ',failure.type,failure.globalId,failure.reason);
}
const bcf=writeBCF({topics:bcfTopicsFromIDS(report,{author:'checker@example.com'})},{version:'2.1'});
console.log(report.pass?'all specifications pass':`${bcf.length} bytes of BCF issues`,writeIDS(ids).length,'bytes of IDS');
```

Errors are `LoaderError` with format `IDS`: `syntax` for malformed XML or a document that misses what ids.xsd requires (a title, a specification's name or ifcVersion, a facet's name), `range` for a wrong argument, and `aborted` when the `signal` fires. A specification written for another schema than the model's is still checked, with a note in its `warnings`. BCF 3.0 viewpoints need a camera: pass `camera` (a `bcfFromView` camera) or write BCF 2.1.

## Editing and saving: /write

`margoengine/ifc/write` writes changes back into an open model through the same web-ifc runtime and saves it as IFC bytes, so a viewer can fix properties, names and quantities and hand the file on. `editIFC(model, options)` returns an editor whose every change goes into the model at once (so `readIFCData` reads it back before saving), and `saveIFC(model, {signal})` returns the `.ifc` bytes.

- `setProperty(id, set, name, value)` sets one property of an element's or a type object's set and creates the set when the element has none of that name. A string is an IfcLabel (IfcText past 255 characters), a boolean an IfcBoolean, a number an IfcReal, an array an IfcPropertyListValue, and `{type, value, unit}` any IFC measure or defined type: `value` is in SI like `readIFCData`'s `value` and is written in the project's unit, or in `unit` (an SI symbol with a prefix: `mm`, `m2`, `kPa`, `degC`), which becomes the property's own IfcSIUnit; `{type, raw}` writes the number as is. A plain value keeps the type and unit the property has now (`0.25` into a millimetre IfcPositiveLengthMeasure is written as 250), and an IfcPropertyEnumeratedValue stays one, checked against its IfcPropertyEnumeration. `setPropertySet(id, set, values, {replace})` sets several at once (null removes one; `replace` removes the rest), `removeProperty` and `removePropertySet` take them away.
- `setQuantity(id, set, name, value)` writes IfcQuantityLength, Area, Volume, Count, Weight, Time and (IFC4X3) Number into an IfcElementQuantity: a number in SI for an existing quantity, `{kind, value, unit, formula}` for a new one. `removeQuantity` removes one.
- `rename(id, name)` and `setAttribute(id, name, value)` set direct attributes (Name, Description, ObjectType, Tag, LongName, PredefinedType and any other attribute holding a value) in the file's units, as `IFCElement.attributes` reads them.

Edits follow IFC's relationship rules. An element's set overrides its type's, so setting a type's property on an occurrence adds an occurrence set; edit the type object's ID to change every occurrence. A set, relationship or property shared with other elements is copied first, so changing one window's shared Pset_WindowCommon leaves the other windows as they were, and anything left unused is deleted. Every new IfcRoot entity gets a new GlobalId (`newIFCGuid()`, the 22-character IFC encoding of a random UUID; `ifcGuidFromUUID` and `uuidFromIFCGuid` convert both ways) and existing GlobalIds and expressIDs never change. Owner histories are kept as IFC defines them: new entities get an IfcOwnerHistory with ChangeAction ADDED, changed ones a MODIFIED history that keeps the owning user, application and creation date and records `options.application` and `options.user` (default: the model's own) as the last modifier, both with `options.now` (default: now). An IFC4 or IFC4X3 file that has no owner histories gets none; IFC2X3, where they are required, always does.

```js
import {IfcAPI} from 'web-ifc';
import {openIFC} from 'margoengine/ifc';
import {readIFCData,propertyOf} from 'margoengine/ifc/data';
import {editIFC,saveIFC} from 'margoengine/ifc/write';
import {fetchBytes} from 'margoengine/loaders';

const api=new IfcAPI();
api.SetWasmPath('/ifc/');
await api.Init();
const model=openIFC(api,await fetchBytes('/building.ifc'));
const wall=[...readIFCData(model).elements.values()].find((element)=>element.type==='IfcWall');
if(!wall)throw new Error('the model has no IfcWall');
const edit=editIFC(model,{application:{name:'My Viewer',version:'1.0',identifier:'my-viewer',developer:'My Company'}});
edit.setProperty(wall.id,'Pset_WallCommon','FireRating','REI90'); // IfcLabel
edit.setProperty(wall.id,'Pset_WallCommon','IsExternal',true); // IfcBoolean
edit.setProperty(wall.id,'Pset_WallCommon','ThermalTransmittance',{type:'IfcThermalTransmittanceMeasure',value:0.24});
edit.setProperty(wall.id,'MyCompany_Loads','DesignWindPressure',{type:'IfcPressureMeasure',value:1500,unit:'kPa'});
edit.setQuantity(wall.id,'Qto_WallBaseQuantities','Height',{kind:'length',value:3}); // 3 m, written in project units
edit.removeProperty(wall.id,'Pset_WallCommon','LoadBearing');
edit.rename(wall.id,'Wall W-01');
edit.setAttribute(wall.id,'Description','Checked on site');
const bytes=saveIFC(model,{signal:AbortSignal.timeout(10_000)});
model.close();
const saved=openIFC(api,bytes); // expressIDs are kept, so wall.id still names the wall
console.log(propertyOf(readIFCData(saved),wall.id,'Pset_WallCommon','FireRating')?.value,bytes.length,'bytes');
saved.close();
// To download: URL.createObjectURL(new Blob([bytes],{type:'application/x-step'}))
```

Errors are `LoaderError` with format `IFC`: `range` for a wrong argument (an ID that is not an object or type object, a value that does not fit its type, such as a negative IfcPositiveLengthMeasure or a 256-character IfcLabel, a unit of the wrong kind, an enumeration value its IfcPropertyEnumeration does not list), `unsupported` for something the model's schema does not have (IfcQuantityNumber or a quantity Formula in IFC2X3), and `aborted` when the `signal` fires. web-ifc 0.0.78 writes reals such as `1E-07` without the decimal point ISO 10303-21 requires; `saveIFC` adds it (`1.E-07`), so strict STEP readers accept the file. The file header (FILE_NAME, FILE_DESCRIPTION) is kept as it was read: web-ifc 0.0.78 has no call to write it.

## GPU scene: /scene

`readIFCMeshes(model)` reads every product's placed geometries from an open model, each distinct geometry once (web-ifc names a representation that `IfcMappedItem` repeats by one `geometryExpressID`), with float64 placements rebased by `origin` as `readIFCGeometry` does. The result is plain, structured-cloneable data, so a worker can read it. `createIFCScene(engine, meshes, options)` (or `IFCScene.attach(engine, meshes, options)`) draws it with `@margoengine/materials`: a geometry placed `instancing` times or more (default 2) is one instanced mesh, everything else goes into `BatchedMesh` draws of up to `batchVertices` (default 1,000,000) vertices, and translucent surfaces get their own batch, so a whole model costs a handful of draw calls per pass. `scene.meshes` lists them for `shadows.add`, `clustered.add` or `ssao.add`.

Every element keeps its parts, so the scene answers per element, as the BIM viewers' hiders, highlighters and x-ray modes do:

- `hide(ids)`, `show(ids)`, `setVisible(ids, visible)`, `isolate(ids)` (every other element hidden) or `isolate(ids, {ghost: true})` (every other element ghosted), `showAll()`;
- `setGhosted(ids, true)`: a translucent copy in `ghostColor` (default `[0.62, 0.72, 0.86]`) at `ghostOpacity` (default 0.15);
- `setColor(ids, [r, g, b])` and `setOpacity(ids, alpha)` override the file's colour and opacity (sRGB, 0..1; `null` restores), `select(ids)` draws in `selectionColor` (default `[0.1, 0.55, 1]`);
- `stateOf(id)`, `hidden`, `selected`, `elements` and `bounds(ids)` report it.

Picking: `scene.elementAt(hit)` turns a pick hit into an expressID, by the instance index for instanced meshes and by the element slot the batches write into UV0 for batches; pick with `@margoengine/selection/hit-details`, whose hits carry `uv`. Clipping: `scene.clippingPlanes = [[a, b, c, d]]` (what has `a x + b y + c z + d < 0` is cut away, at most 16 planes) applies to every material, `sectionBox(min, max)` sets the six planes of a box, and `storeyPlan(storeyId, {cutHeight})` (default 1.2 m, needs the `data` option) isolates the storey, cuts above it and returns a top-down orthographic camera. BCF: `applyBCFView(viewFromBCF(viewpoint, data, {origin: meshes.origin}))` applies a viewpoint's visibility, colours, selection and section planes and returns its camera; `bcfFromView({...scene.bcfView(), camera}, data)` writes the scene back. Materials default to rough, non-metallic and double-sided (`doubleSided: false` culls back faces); `scene.materials.opaque` and `.translucent` take any other material option. WebGPU and the WebGL2 compatibility layer.

```js
import {IfcAPI} from 'web-ifc';
import {Engine} from 'margoengine/core';
import {openIFC} from 'margoengine/ifc';
import {readIFCData} from 'margoengine/ifc/data';
import {findElements} from 'margoengine/ifc/query';
import {readIFCMeshes,createIFCScene} from 'margoengine/ifc/scene';
import {HitDetails} from 'margoengine/selection/hit-details';
import {fetchBytes} from 'margoengine/loaders';

const api=new IfcAPI();
api.SetWasmPath('/ifc/');
await api.Init();
const model=openIFC(api,await fetchBytes('/building.ifc'));
const data=readIFCData(model);
const meshes=readIFCMeshes(model,{origin:'auto'});
model.close();

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{camera:{position:[20,15,20],target:[0,0,0]}});
const scene=createIFCScene(engine,meshes,{data});
scene.isolate(findElements(data,{type:'IfcWall'}),{ghost:true}); // walls drawn, the rest as x-ray ghosts
scene.setColor(findElements(data,{type:'IfcWindow'}),[0.2,0.6,1]);
scene.sectionBox([-50,-1,-50],[50,2.5,50]);
const picker=HitDetails.attach(engine);
canvas.addEventListener('click',async (e)=>console.log(scene.elementAt(await picker.pick(e.offsetX,e.offsetY))));
engine.start();
```

### Streaming load

Large models appear while they load, as the web BIM viewers stream theirs. `streamIFCMeshes(model, options)` is an async iterator over chunks of `chunk` elements (default 256): each chunk is `readIFCMeshes`' shape (`schema`, `origin`, `geometries`, `placements`) holding the placements of the elements read since the last chunk and only the geometries first used by them, plus `loaded` and `total` (elements read so far and in all) for a progress bar; `loaded` grows every chunk and the last one has `loaded === total`. Between chunks it yields to the event loop, so the page keeps drawing. Create the scene from the first chunk and `scene.add` each later one: chunks join the scene's existing instance groups and batches (a geometry a later chunk places again moves into one instance group, batches grow before new ones open), so the streamed scene draws, picks and reports exactly what `createIFCScene(engine, readIFCMeshes(model))` does. Growing replaces meshes, so read `scene.meshes` again after the last chunk before handing them to shadows or SSAO.

- `order` (default `'envelope'`): walls, slabs, roofs and curtain walls first, then the other building elements (columns, beams, members, plates, windows, doors, stairs, railings, coverings), then the rest (furniture, services, proxies), each in file order, so the first frame already shows the building's shell; `'file'` streams in expressID order. `readIFCMeshes` reads in the same order.
- `elements`: stream only these expressIDs (for example one storey's elements from `readIFCData`, then the next); other ids are skipped.
- `spaces: true` streams `IfcSpace` volumes too (default off; `IfcOpeningElement` voids are never drawn), as `StreamAllMeshes` leaves them out.
- `signal`: aborting rejects the next step with `LoaderError` code `aborted`; the model stays open (it is yours), and a scene built from the chunks so far is disposed as usual.

`streamIFCInWorker(bytes, {webIfc, wasmPath, timeoutMs, ...options})` from `/worker` yields the same chunks from a fresh worker: the file is opened and tessellated off the page's thread and each chunk's buffers move, not copy. Leaving the loop (`break`), aborting `signal`, or a worker that sends nothing for `timeoutMs` (default 60,000 ms, `LoaderError` code `limit`) terminates the worker. web-ifc indexes the whole STEP file before its first mesh, so streaming starts after that index (the fast part); the tessellation, which is most of a load, is what streams.

```js
import {Engine} from 'margoengine/core';
import {createIFCScene} from 'margoengine/ifc/scene';
import {streamIFCInWorker} from 'margoengine/ifc/worker';
import {fetchBytes} from 'margoengine/loaders';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{camera:{position:[20,15,20],target:[0,0,0]}});
engine.start();
const progress=document.createElement('progress');document.body.append(progress);
const stop=new AbortController();
let scene;
for await (const chunk of streamIFCInWorker(await fetchBytes('/building.ifc'),{webIfc:'/ifc/web-ifc-api-iife.js',wasmPath:'/ifc/',origin:'auto',signal:stop.signal})) {
  scene=scene?scene.add(chunk):createIFCScene(engine,chunk); // the shell shows after the first chunk
  progress.max=chunk.total;progress.value=chunk.loaded;
}
console.log(scene?.elements.length,'elements,',scene?.meshes.length,'draws');
```

On the page's thread with your own web-ifc, the same loop reads `streamIFCMeshes(model, {origin: 'auto'})`.

## Section caps and cut edges: /section

`new IFCSectionView(engine, scene, options)` (or `IFCSectionView.attach(engine, scene, options)`) closes every cut the scene's `clippingPlanes` make: a cap on each plane in
each element's colour, trimmed by the other planes, and the cut edges as screen-space lines when you pass a
`@margoengine/lines` plugin. Call `view.update()` after changing the planes or which elements are shown; it does
nothing when neither changed, so it can run every frame. Options: `caps` (default true), `capColor` (`'element'`,
default: the element's override, else its file colour; or sRGB `[r, g, b]`), `edges` (`{lines, Line}`, default no
edges), `edgeWidth` (CSS pixels, default 2), `edgeColor` (sRGB, default black), `tolerance` (meters, default 1e-5).
`view.meshes` lists the cap mesh for shadows or picking filters; `view.capColorOf(id)` gives a cap's linear colour;
`view.material` is the cap material. Hidden and ghosted elements get no caps.

`sectionIFC(sources, planes, {tolerance, signal})` is the same cut without drawing, for plan drawings and exports:
`sources` are `{element, geometry, matrix}` (from `scene.placementsOf(id)` or readIFCMeshes' placements) and each
result names its `element` and `plane` and holds the cap triangles (`positions`, `indices`), the cut `edges` (six
numbers a segment) and the section `loops` (closed ones first, `closed` of them), all trimmed by the other planes.

How it works: each triangle is cut by each plane (a vertex on the plane counts as in front, so two triangles sharing
an edge make the same point); the segments are joined into loops through a hash of their end points (Minetto et al.
2017); loops nest by even-odd containment, so the caps do not depend on the triangles' winding; each outer loop with
its holes is ear clipped (`@margoengine/geometry/triangulate`); and caps and edges are trimmed by the other planes
(Sutherland and Hodgman 1974). A surface that is not closed keeps its cut edges but gets no cap. Caps are geometry,
so they work for any number of planes, on WebGPU and the WebGL2 compatibility layer alike, with no stencil pass.

```js
import {Engine} from 'margoengine/core';
import {createIFCScene} from 'margoengine/ifc/scene';
import {IFCSectionView} from 'margoengine/ifc/section';
import {Lines,Line} from 'margoengine/lines';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{camera:{position:[3,3,6],target:[0,0.5,0]}});
// A 1 m box, as readIFCMeshes returns geometry: positions, normals and indices, flat shaded.
const positions=[],normals=[],indices=[];
for(let axis=0;axis<3;axis++)for(const side of [0,1]){
  const u=(axis+1)%3,v=(axis+2)%3,base=positions.length/3;
  for(const [a,b] of [[0,0],[1,0],[1,1],[0,1]]){const p=[0,0,0],n=[0,0,0];p[axis]=side;p[u]=a;p[v]=b;n[axis]=side?1:-1;positions.push(...p);normals.push(...n);}
  indices.push(...(side?[base,base+1,base+2,base,base+2,base+3]:[base,base+2,base+1,base,base+3,base+2]));
}
const scene=createIFCScene(engine,{schema:'IFC4',origin:[0,0,0],
  geometries:new Map([[1,{positions:new Float32Array(positions),normals:new Float32Array(normals),indices:new Uint32Array(indices)}]]),
  placements:[{element:1,geometry:1,matrix:Float64Array.of(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),color:[0.8,0.3,0.2,1]}]});
scene.clippingPlanes=[[0,-1,0,0.6],[-1,0,0,0.7]]; // cut above 0.6 m and right of 0.7 m
const lines=Lines.attach(engine);
const section=new IFCSectionView(engine,scene,{capColor:[0.95,0.9,0.75],edges:{lines,Line},edgeWidth:2});
console.log(section.cuts.length); // 2: one cap per plane, each trimmed by the other
engine.start();
```

## Geometry

`parseIFC(api, Uint8Array, options)` returns `LoadedGeometry` plus `schema` and `products`. Each placed geometry becomes a named/color group, with the source element's `expressID` in `objectId`. Positions are transformed to world space in meters, reflected winding is corrected and normals are computed. Core `Geometry` limits still apply to `createMeshes`; split oversized groups before rendering.

Opened models are closed in `finally`, including geometry/limit failures. Arrays are copied from the Wasm heap and remain usable after closure. The caller retains its initialized API. Options include `maxVertices`, `maxTriangles`, `maxBytes` (256 MiB default), `signal` and native `settings`. Schema aliases are rejected unless explicitly enabled in settings.

The bytes must be well-formed ISO 10303-21 before web-ifc sees them (web-ifc 0.0.78 loops forever on some malformed parameter lists), so a syntax error is `LoaderError` code `syntax`; web-ifc's own failures, Wasm traps included, are `LoaderError` code `unsupported`. Tessellation is synchronous; aborts are checked before opening and between callbacks, and cannot interrupt native tessellation. Use a worker for large files. Colors follow web-ifc geometry styles; core does not render transparent IFC surfaces.

`npm test` passes a real IFC4 millimeter wall through Wasm and checks units, placement, triangles, names/IDs, mesh disposal, limits and model closure after failures. Build with root `npm run build:packages` or local `npm run build`.
