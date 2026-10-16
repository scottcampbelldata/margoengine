import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {openBrowser} from './browser.js';
import {ensurePBRBoxAssets} from './support/pbr-box-assets.js';

/** Published entry points, the actual Khronos Box, native WebGPU, and real Rapier. */
export async function pbrBoxBrowserChecks(page) {
  return page.evaluate(async () => {
    const {EngineKernel} = await import('/packages/core/dist/index.js');
    const {engineRuntime} = await import('/packages/core/dist/extension.js');
    const {loadGLTF, parseGLTF} = await import('/packages/gltf-pro/dist/index.js');
    const {loadGLTF: loadBasicGLTF} = await import('/packages/gltf/dist/index.js');
    const {Physics} = await import('/packages/physics/dist/index.js');
    const {exportGLB} = await import('/packages/exporters/dist/index.js');
    const {deduplicateParts} = await import('/packages/machinery/dist/cad.js');
    const {AssemblyBVH} = await import('/packages/machinery/dist/spatial.js');
    const {BoxHelper} = await import('/packages/lines/dist/index.js');
    const {worldBounds} = await import('/packages/margoengine/dist/model.js');
    const {meshTriangles} = await import('/packages/shared/mesh-source.js');
    const {default: RAPIER} = await import('/node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs');
    await RAPIER.init();
    const check = (value, message) => {if (!value) throw new Error(message);};
    const close = (actual, expected, label, epsilon = 2e-6) => {
      check(actual.length === expected.length, `${label}: array length`);
      for (let i = 0; i < actual.length; i++) check(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) <= epsilon,
        `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
    };
    const rejects = (action, pattern, label) => {
      let error; try {action();} catch (value) {error = value;}
      check(error && pattern.test(error.message), `${label}: expected ${pattern}, received ${error?.message ?? 'success'}`);
    };
    const xyz = vector => [vector.x, vector.y, vector.z];
    const positions = primitive => Array.from({length: primitive.vertices.length / 20}, (_, vertex) => Array.from(primitive.vertices.subarray(vertex * 20, vertex * 20 + 3))).flat();
    const transformed = (values, matrix) => Array.from({length: values.length / 3}, (_, vertex) => [0, 1, 2].map(axis => matrix[axis] * values[vertex * 3] + matrix[axis + 4] * values[vertex * 3 + 1] + matrix[axis + 8] * values[vertex * 3 + 2] + matrix[axis + 12])).flat();
    const boundsOf = values => {
      const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < values.length; i += 3) for (let axis = 0; axis < 3; axis++) {bounds[axis] = Math.min(bounds[axis], values[i + axis]); bounds[axis + 3] = Math.max(bounds[axis + 3], values[i + axis]);}
      return bounds;
    };
    const unpack = bytes => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      check(view.getUint32(0, true) === 0x46546c67 && view.getUint32(4, true) === 2 && view.getUint32(8, true) === bytes.length, 'export did not produce GLB2');
      const length = view.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
      return {json, binary: bytes.subarray(28 + length)};
    };
    const accessor = (json, binary, index) => {
      const entry = json.accessors[index], buffer = json.bufferViews[entry.bufferView], widths = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}, sizes = {5121: 1, 5123: 2, 5125: 4, 5126: 4};
      const width = widths[entry.type], size = sizes[entry.componentType], stride = buffer.byteStride ?? width * size, offset = (buffer.byteOffset ?? 0) + (entry.byteOffset ?? 0), view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
      return Array.from({length: entry.count * width}, (_, i) => {
        const at = offset + Math.floor(i / width) * stride + i % width * size;
        return entry.componentType === 5126 ? view.getFloat32(at, true) : entry.componentType === 5125 ? view.getUint32(at, true) : entry.componentType === 5123 ? view.getUint16(at, true) : view.getUint8(at);
      });
    };
    const canvas = document.createElement('canvas'), W = 192;
    canvas.style.cssText = `width:${W}px;height:${W}px`; document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, {backend: 'webgpu', capacity: 64, camera: {position: [2, 1.5, 4], target: [0, 0, 0], near: 0.01, far: 100}});
    const engine = engineRuntime(instance), device = engine.gpu, resources = [], shaders = [], errors = [], captures = [], workers = [];
    const NativeWorker = window.Worker;
    let model, roundtrip, basic, avocado, physics, label = 'setup';
    window.Worker = class extends NativeWorker {
      constructor(url, options) {super(url, options); if (options?.name === 'margoengine-decoder') {this.record = {terminated: false}; workers.push(this.record);}}
      terminate() {if (this.record) this.record.terminated = true; return super.terminate();}
    };
    device.addEventListener('uncapturederror', event => errors.push(`${label}: ${event.error.message}`));
    for (const name of ['createBuffer', 'createTexture']) {
      const create = device[name].bind(device);
      device[name] = descriptor => {
        const resource = create(descriptor), destroy = resource.destroy.bind(resource), record = {resource, descriptor, destroyed: false}; resources.push(record);
        resource.destroy = () => {record.destroyed = true; destroy();}; return resource;
      };
    }
    const shader = device.createShaderModule.bind(device);
    device.createShaderModule = descriptor => {const module = shader(descriptor); shaders.push(module); return module;};
    const capture = async name => {
      label = name; captures.push(name); const context = canvas.getContext('webgpu'), format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
      const get = context.getCurrentTexture.bind(context); let texture;
      context.getCurrentTexture = () => texture = get();
      let staging;
      try {
        instance.render({culling: false});
        const row = Math.ceil(texture.width * 4 / 256) * 256;
        staging = device.createBuffer({size: row * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({texture}, {buffer: staging, bytesPerRow: row}, [texture.width, texture.height]); device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(staging.getMappedRange()), output = new Uint8Array(texture.width * texture.height * 4);
        for (let y = 0; y < texture.height; y++) output.set(mapped.subarray(y * row, y * row + texture.width * 4), y * texture.width * 4);
        staging.unmap(); await device.queue.onSubmittedWorkDone(); check(errors.length === 0, errors.join('\n')); return output;
      } finally {context.getCurrentTexture = get; staging?.destroy();}
    };
    const fit = source => {const bounds = source.bounds; engine.camera.fitToBoundingBox(bounds.subarray(0, 3), bounds.subarray(3), {aspect: 1}); return [...bounds];};
    try {
      label = 'Box.glb:load'; model = await loadGLTF(instance, '/packages/exporters/tests/fixtures/Box.glb');
      const primitive = model.primitives[0], mesh = model.nodes[1], parent = model.nodes[0];
      check(model.nodes.length === 2 && model.primitives.length === 1 && primitive.node === mesh, 'Box hierarchy or primitive ownership changed');
      check(model.root.geometry === null && parent.geometry === null && mesh.geometry === null, 'PBR load allocated core Geometry');
      check(meshTriangles(model.root) === null && meshTriangles(parent) === null, 'parent nodes gained synthetic triangle sources');
      const source = meshTriangles(mesh); check(source?.kind === 'pbr' && source.source.primitives.length === 1 && source.source.primitives[0] === primitive && source.source.stride === 80, 'canonical PBR source is missing');
      check(primitive.vertices.length === 24 * 20 && primitive.indices.length === 36, 'actual Box geometry is not 24 vertices / 36 indices');
      check(engine.store.parents[mesh.id] === parent.id && engine.store.parents[parent.id] === model.root.id && engine.store.parents[model.root.id] === -1, 'Box parent chain was detached');
      engine.store.tick(false);
      const local = positions(primitive), expectedWorld = Array.from({length: 24}, (_, vertex) => [local[vertex * 3], local[vertex * 3 + 2], -local[vertex * 3 + 1]]).flat();
      const world = transformed(local, mesh.matrix), bounds = boundsOf(expectedWorld), parentMatrix = [...parent.matrix], meshMatrix = [...mesh.matrix];
      close(world, expectedWorld, 'retained authored (x,z,-y) transform'); close(model.bounds, bounds, 'PBR bounds');
      check(model.bounds.every(Number.isFinite), 'PBR bounds contain nonfinite values');
      close(worldBounds(instance, model.nodes, new Float32Array(6)), bounds, 'facade PBR world bounds');
      check([...engine.meshes.values()].every(node => node.geometry === null), 'facade bounds added a duplicate core draw');
      fit(model); const beauty = await capture('Box.glb:before-physics');
      model.root.visible = false; const blank = await capture('Box.glb:hidden'); model.root.visible = true;
      const visiblePixels = beauty.reduce((count, value, index) => count + +(index % 4 < 3 && value !== blank[index]), 0);
      check(visiblePixels > 100, 'actual Box rendered no visible surface');
      const borrowed = source.source.draws[0], vertexRecord = resources.find(record => record.resource === borrowed.vertex), indexRecord = resources.find(record => record.resource === borrowed.index);
      check(vertexRecord && indexRecord, 'native PBR vertex/index uploads were not observed');
      physics = new Physics(instance, {rapier: RAPIER, gravity: [0, 0, 0], paused: true});
      const beforeFit = resources.length, body = physics.addBody(model.root), collider = body.colliders[0];
      check(body.colliders.length === 1 && physics.bodyCount === 1, 'attached PBR root did not receive exactly one default collider');
      const fitted = {halfExtents: xyz(collider.halfExtents()), center: xyz(collider.translationWrtParent())};
      close(fitted.halfExtents, [0, 1, 2].map(axis => (bounds[axis + 3] - bounds[axis]) / 2), 'transformed root collider half extents');
      close(fitted.center, [0, 1, 2].map(axis => (bounds[axis + 3] + bounds[axis]) / 2), 'transformed root collider center');
      check(resources.length === beforeFit, 'CPU collider fitting allocated a second GPU geometry');
      close(parent.matrix, parentMatrix, 'collider fitting parent matrix', 0); close(mesh.matrix, meshMatrix, 'collider fitting primitive matrix', 0);
      check(engine.store.parents[mesh.id] === parent.id && mesh.geometry === null, 'collider fitting detached or converted the primitive');
      const after = await capture('Box.glb:after-physics'); close(after, beauty, 'bit-for-bit raster parity after physics attachment', 0);
      const output = exportGLB(instance), {json, binary} = unpack(output), exported = json.meshes?.[0]?.primitives?.[0];
      check(json.nodes.length === 3 && json.meshes.length === 1 && json.meshes[0].primitives.length === 1, 'Box export must contain 3 nodes / 1 mesh / 1 primitive');
      close(accessor(json, binary, exported.attributes.POSITION), local, 'exported local positions', 0);
      close(accessor(json, binary, exported.indices), [...primitive.indices], 'exported original indices', 0);
      check(json.nodes.filter(node => node.mesh !== undefined).length === 1 && json.nodes.filter(node => node.children?.length).length === 2, 'export flattened the source hierarchy');
      const groups = deduplicateParts(model.nodes); check(groups.parts === 1 && groups.unique === 1, 'CAD grouping lost the Box primitive');
      rejects(() => deduplicateParts([model.root]), /CAD grouping contains no supported geometry/, 'root-only CAD grouping');
      const assembly = await AssemblyBVH.create(model.nodes);
      let hit;
      try {const center = [0, 1, 2].map(axis => (bounds[axis] + bounds[axis + 3]) / 2); hit = assembly.raycast([center[0], center[1], bounds[5] + 2], [0, 0, -1]); check(hit?.node === mesh, '12-triangle AssemblyBVH missed the transformed Box');}
      finally {assembly.dispose();}
      let rootBVHError; try {await AssemblyBVH.create([model.root]);} catch (error) {rootBVHError = error;}
      check(/BVH requires 1\.\.1000000 triangles/.test(rootBVHError?.message ?? ''), 'root-only BVH must reject absent geometry');
      const helper = new BoxHelper(mesh), rootHelper = new BoxHelper(model.root);
      try {
        check(helper.update(instance) && helper.segmentCount === 12 && helper.points.every(Number.isFinite), 'PBR primitive BoxHelper is empty');
        check(rootHelper.update(instance) === false, 'BoxHelper on triangle-free root changed contract');
        const corners = Array.from({length: helper.count}, (_, point) => [...helper.points.subarray(point * 4, point * 4 + 3)]).flat(); close(boundsOf(corners), bounds, 'BoxHelper transformed bounds');
      } finally {helper.dispose(); rootHelper.dispose();}
      body.remove(); check(physics.bodyCount === 0, 'body removal retained its fitted collider');
      const empty = instance.createMesh(); rejects(() => physics.addBody(empty), /^No geometry$/, 'empty-mesh root fitting'); check(physics.bodyCount === 0, 'empty fitting retained a body'); empty.dispose();
      physics.dispose(); physics = undefined;
      check(!vertexRecord.destroyed && !indexRecord.destroyed && meshTriangles(mesh)?.source.draws[0].vertex === borrowed.vertex, 'optional consumers destroyed or replaced borrowed PBR buffers');
      model.destroy(); model = undefined; check(vertexRecord.destroyed && indexRecord.destroyed && meshTriangles(mesh) === null && instance.meshes.size === 0, 'model disposal retained registry/GPU ownership');
      const disposedPhysics = physics = new Physics(instance, {rapier: RAPIER});
      rejects(() => disposedPhysics.addBody(mesh), /^Mesh disposed$/, 'disposed mesh handle'); check(disposedPhysics.bodyCount === 0, 'disposed handle retained a physics body'); disposedPhysics.dispose(); physics = undefined;
      roundtrip = parseGLTF(instance, output); engine.store.tick(false);
      check(roundtrip.primitives.length === 1 && roundtrip.primitives[0].vertices.length === 24 * 20 && roundtrip.primitives[0].indices.length === 36, 'Box reimport lost triangles');
      close(positions(roundtrip.primitives[0]), local, 'roundtrip local positions', 0); close(transformed(positions(roundtrip.primitives[0]), roundtrip.primitives[0].node.matrix), expectedWorld, 'roundtrip world positions'); close(roundtrip.bounds, bounds, 'roundtrip bounds');
      const reimportBeauty = await capture('Box.glb:export-reimport'); close(reimportBeauty, beauty, 'bit-for-bit raster parity after GLB export/reimport', 0); roundtrip.destroy(); roundtrip = undefined;
      basic = await loadBasicGLTF(instance, '/packages/exporters/tests/fixtures/Box.glb');
      const basicResult = unpack(exportGLB(instance)); check(basicResult.json.meshes.length === 1 && basicResult.json.meshes[0].primitives.length === 1, 'minimal glTF loader export regressed');
      check(basic.meshes.length === 1 && meshTriangles(basic.meshes[0])?.kind === 'core', 'minimal glTF loader no longer retains ordinary core geometry');
      basic.dispose(); basic = undefined; check(instance.meshes.size === 0, 'minimal-loader disposal leaked nodes');
      check(workers.length === 0, 'static Box paths started a decoder worker');
      label = 'Draco Avocado:load';
      const avocadoDoc = await (await fetch('/test-results/pbr-box-avocado/Avocado.gltf')).json(), avocadoBytes = await (await fetch('/test-results/pbr-box-avocado/Avocado.bin')).arrayBuffer();
      rejects(() => parseGLTF(instance, avocadoDoc, [avocadoBytes]), /^Draco geometry requires parseGLTFAsync or loadGLTF$/, 'synchronous Avocado diagnostic');
      avocado = await loadGLTF(instance, '/test-results/pbr-box-avocado/Avocado.gltf');
      const decoded = avocado.primitives[0]; check(avocado.primitives.length === 1 && decoded.vertices.length === 406 * 20 && decoded.indices.length === 2046, 'real async Avocado failed 406-vertex / 2046-index decode');
      check(decoded.vertices.every(Number.isFinite) && decoded.indices.every(index => index < 406), 'decoded Avocado geometry is invalid');
      check(decoded.vertices.some((value, i) => i % 20 === 12 && value !== 0) && decoded.vertices.some((value, i) => i % 20 === 11 && Math.abs(value) === 1), 'Avocado decoded UV/tangents were lost');
      check(meshTriangles(decoded.node)?.source.primitives[0] === decoded && decoded.node.geometry === null, 'Draco primitive skipped canonical registration');
      check(avocado.asset.doc.images.length === 3 && [0, 1, 2].every(index => avocado.image(index).width > 0) && avocado.asset.doc.materials.length === 1, 'complete Avocado path lost its original three textures/material');
      fit(avocado); const avocadoBeauty = await capture('Avocado:decoded-geometry'); avocado.root.visible = false; const avocadoBlank = await capture('Avocado:hidden');
      check(avocadoBeauty.some((value, i) => i % 4 < 3 && value !== avocadoBlank[i]), 'native GPU rendered no decoded Avocado surface');
      avocado.destroy(); avocado = undefined;
      check(workers.length === 1 && workers.every(worker => worker.terminated), 'loadGLTF did not cleanly dispose its actual Draco worker');
      instance.dispose();
      const compilation = (await Promise.all(shaders.map(module => module.getCompilationInfo()))).flatMap(info => info.messages.filter(message => message.type === 'error').map(message => message.message));
      check(compilation.length === 0 && errors.length === 0, [...compilation, ...errors].join('\n'));
      check(resources.every(record => record.destroyed), `GPU resources leaked: ${resources.filter(record => !record.destroyed).map(record => JSON.stringify(record.descriptor)).join(', ')}`);
      return {box: {source: '/packages/exporters/tests/fixtures/Box.glb', nodes: 2, exportedNodes: json.nodes.length, vertices: 24, indices: 36, triangles: 12, colliders: 1, bounds, ...fitted, visibleColorSamples: visiblePixels, physicsRasterBitExact: true, roundtripRasterBitExact: true, worldTransform: '(x,z,-y)', parentHierarchyPreserved: true, localExportExact: true, roundtripWorldGeometry: true, minimalLoaderControl: true, cad: groups, bvhHitTriangle: hit.triangle, coreGeometry: null}, avocado: {source: 'KhronosGroup/glTF-Sample-Assets/Models/Avocado/glTF-Draco', unmodifiedCompleteAsset: true, vertices: 406, indices: 2046, textures: 3, uvAndTangents: true, syncDiagnostic: 'Draco geometry requires parseGLTFAsync or loadGLTF', workers: workers.length, workersTerminated: true}, captures, shaders: shaders.length, resourcesDestroyed: resources.length, compilationErrors: compilation, validationErrors: errors};
    } catch (error) {throw new Error(`${label}: ${error.message}\n${errors.join('\n')}`);}
    finally {physics?.dispose(); avocado?.destroy(); roundtrip?.destroy(); basic?.dispose(); model?.destroy(); if (!instance.disposed) instance.dispose(); window.Worker = NativeWorker; canvas.remove();}
  });
}

export async function runPBRBoxTests() {
  await mkdir('test-results', {recursive: true});
  const assets = await ensurePBRBoxAssets();
  const browser = await openBrowser({startPath: '/tests/modern-extension.html', port: 5211}), errors = [];
  browser.page.on('pageerror', error => errors.push(error.message));
  browser.page.on('console', message => {if (message.type() === 'error' || /ValidationError|Invalid .*Pipeline/.test(message.text())) errors.push(message.text());});
  try {
    const checks = await pbrBoxBrowserChecks(browser.page); assert.deepEqual(errors, []);
    const result = {hardware: browser.hardware, assets, ...checks, errors}; await writeFile('test-results/pbr-box-webgpu.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally {await browser.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runPBRBoxTests();
