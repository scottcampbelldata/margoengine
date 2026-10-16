import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';

/** Real loader output and borrowed native GPU resources across mixed scenes. */
export async function sceneHelperBrowserChecks(page) {
  return page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { webglRenderer } = await import('/packages/webgl/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { loadGLTF: loadBasicGLTF } = await import('/packages/gltf/dist/index.js');
    const { loadFBX } = await import('/packages/fbx/dist/index.js');
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { getSceneBounds, fitScene, gatherSceneBuffers } = await import('/packages/gltf-pro/dist/scene.js');
    const { Stage } = await import('/packages/margoengine/dist/index.js');
    const { loadedModel, worldBounds } = await import('/packages/margoengine/dist/model.js');
    const check = (value, message) => {
      if (!value) throw new Error(message);
    };
    const close = (actual, expected, message, epsilon = 2e-5) => {
      check(actual.length === expected.length, `${message}: length ${actual.length} != ${expected.length}`);
      for (let i = 0; i < actual.length; i++)
        check(
          Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) <= epsilon,
          `${message}[${i}]: ${actual[i]} != ${expected[i]}`,
        );
    };
    const same = (actual, expected, message) =>
      check(
        JSON.stringify(actual) === JSON.stringify(expected),
        `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      );
    const resources = [],
      modules = [],
      errors = [],
      captures = [],
      facadeChecks = [],
      tracked = new WeakSet();
    const activity = { buffers: 0, textures: 0, writes: 0, copies: 0, encoders: 0, submissions: 0, destroyed: 0 };
    let label = 'setup';
    const track = (device) => {
      if (tracked.has(device)) return;
      tracked.add(device);
      device.addEventListener('uncapturederror', (event) => errors.push(`${label}: ${event.error.message}`));
      for (const name of ['createBuffer', 'createTexture']) {
        const create = device[name].bind(device);
        device[name] = (descriptor) => {
          activity[name === 'createBuffer' ? 'buffers' : 'textures']++;
          const resource = create(descriptor),
            destroy = resource.destroy.bind(resource),
            record = { device, resource, descriptor, destroyed: false };
          resources.push(record);
          resource.destroy = () => {
            activity.destroyed++;
            record.destroyed = true;
            destroy();
          };
          return resource;
        };
      }
      for (const name of ['writeBuffer', 'writeTexture', 'copyExternalImageToTexture']) {
        const write = device.queue[name].bind(device.queue);
        device.queue[name] = (...args) => {
          activity[name === 'copyExternalImageToTexture' ? 'copies' : 'writes']++;
          return write(...args);
        };
      }
      const encode = device.createCommandEncoder.bind(device),
        submit = device.queue.submit.bind(device.queue),
        shader = device.createShaderModule.bind(device);
      device.createCommandEncoder = (...args) => {
        activity.encoders++;
        return encode(...args);
      };
      device.queue.submit = (...args) => {
        activity.submissions++;
        return submit(...args);
      };
      device.createShaderModule = (descriptor) => {
        const module = shader(descriptor);
        modules.push(module);
        return module;
      };
    };
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await requestDevice.apply(this, args);
      track(device);
      return device;
    };
    const canvas = document.createElement('canvas'),
      W = 224;
    canvas.style.cssText = `width:${W}px;height:${W}px`;
    document.body.append(canvas);
    let instance, engine, box, fbx, basic, animation, shared, group, webgl, webglBasic, webglCanvas;
    const noGPU = (action, message) => {
      const before = { ...activity },
        value = action();
      same(activity, before, message);
      return value;
    };
    const reference = (entries, runtime = engine) => {
      runtime.store.tick(false);
      const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const { node, vertices, stride } of entries) {
        const matrix = node.matrix;
        for (let i = 0; i < vertices.length; i += stride)
          for (let axis = 0; axis < 3; axis++) {
            const value =
              matrix[axis] * vertices[i] +
              matrix[axis + 4] * vertices[i + 1] +
              matrix[axis + 8] * vertices[i + 2] +
              matrix[axis + 12];
            bounds[axis] = Math.min(bounds[axis], value);
            bounds[axis + 3] = Math.max(bounds[axis + 3], value);
          }
      }
      return bounds;
    };
    const cpuEntries = (models) =>
      models.flatMap((model) =>
        model.primitives.map((primitive) => ({ node: primitive.node, vertices: primitive.vertices, stride: 20 })),
      );
    const coreEntries = (meshes) => meshes.map((node) => ({ node, vertices: node.geometry.vertices, stride: 6 }));
    const capture = async (name, culling = false) => {
      label = name;
      captures.push(name);
      const device = engine.gpu,
        context = canvas.getContext('webgpu'),
        format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const get = context.getCurrentTexture.bind(context);
      let texture, staging;
      context.getCurrentTexture = () => (texture = get());
      try {
        instance.render({ culling });
        const row = Math.ceil((texture.width * 4) / 256) * 256;
        staging = device.createBuffer({
          size: row * texture.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: row }, [
          texture.width,
          texture.height,
        ]);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(staging.getMappedRange()),
          output = new Uint8Array(texture.width * texture.height * 4);
        for (let y = 0; y < texture.height; y++)
          output.set(mapped.subarray(y * row, y * row + texture.width * 4), y * texture.width * 4);
        staging.unmap();
        await device.queue.onSubmittedWorkDone();
        check(errors.length === 0, errors.join('\n'));
        return output;
      } finally {
        context.getCurrentTexture = get;
        staging?.destroy();
      }
    };
    const assertRaw = (records) => {
      check(
        records.length === 4 && new Set(records.map((record) => record.node)).size === 4,
        'mixed gather omitted or duplicated a drawable node',
      );
      const core = records.filter((record) => record.kind === 'core'),
        pbr = records.filter((record) => record.kind === 'pbr');
      check(core.length === 2 && pbr.length === 2, 'mixed gather did not retain both source types');
      for (const record of records) {
        check(
          record.matrix === record.node.matrix &&
            record.indexFormat === 'uint32' &&
            record.vertex instanceof GPUBuffer &&
            record.index instanceof GPUBuffer &&
            record.count > 0,
          'raw record lacks live matrix, uint32 indices or native buffers',
        );
        if (record.kind === 'core') {
          const borrowed = engine.geometryBuffers(record.node.geometry);
          check(
            record.stride === 24 &&
              record.geometry === record.node.geometry &&
              record.vertex === borrowed.vertex &&
              record.index === borrowed.index &&
              record.instance === borrowed.instance &&
              record.count === record.geometry.indices.length,
            'core gather copied or misidentified batch resources',
          );
        } else {
          const owner = box.primitives.some((primitive) => primitive === record.primitive) ? box : fbx;
          const borrowed = owner.pickingPrimitives.find(
            (primitive) => primitive.node === record.node && primitive.primitive === record.primitive,
          );
          check(
            record.stride === 80 &&
              record.vertex === borrowed.vertex &&
              record.index === borrowed.index &&
              record.count === borrowed.count,
            'PBR gather copied or replaced current draw buffers',
          );
          for (const key of ['alphaTexture', 'alphaSampler', 'alpha', 'cutoff', 'doubleSided', 'texCoord'])
            check(record[key] === borrowed[key], `PBR gather lost ${key} metadata`);
          check(record.node.geometry === null, 'PBR gather attached core Geometry');
        }
      }
      check(
        core[0].instance === core[1].instance && core[0].vertex === core[1].vertex && core[0].index === core[1].index,
        'same core Geometry did not retain its shared batch buffers',
      );
      return records;
    };
    const assertFacadeRaw = (records) => {
      check(
        records.length === 3,
        'facade raw must deduplicate shared core geometry while retaining both PBR primitives',
      );
      check(
        records[0] === engine.geometryBuffers(basic.meshes[0].geometry) && records[0].instance instanceof GPUBuffer,
        'facade raw copied or dropped the native core batch',
      );
      for (const model of [box, fbx]) {
        const expected = model.raw[0],
          record = records.find((value) => value.primitive === model.primitives[0]);
        check(
          record?.vertex instanceof GPUBuffer &&
            record.index instanceof GPUBuffer &&
            record.vertex === expected.vertex &&
            record.index === expected.index,
          'facade raw does not borrow native loader buffers',
        );
        check(
          record.instance === undefined && record.stride === 80 && record.node.geometry === null,
          'facade raw converted a PBR primitive to core geometry',
        );
      }
      return records;
    };
    try {
      instance = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 128,
        camera: { position: [8, 6, 22], target: [5, 0, 0], fov: 50, near: 0.1, far: 150 },
      });
      engine = engineRuntime(instance);
      const stage = new Stage(instance);
      box = await loadGLTF(instance, '/packages/exporters/tests/fixtures/Box.glb');
      fbx = await loadFBX(instance, '/packages/fbx/test/fixtures/blender-rig.fbx');
      basic = await loadBasicGLTF(instance, '/packages/exporters/tests/fixtures/Box.glb');
      check(
        box.primitives.length === 1 && fbx.primitives.length === 1 && basic.meshes.length === 1,
        'real loader fixture topology changed',
      );
      group = instance.createMesh().setPosition([1.25, 0, -0.5]);
      box.root.setParent(group);
      fbx.root.setPosition([-5, 0, 0]);
      basic.root.setPosition([12, 0, 0]);
      shared = instance
        .createMesh()
        .setGeometry(basic.meshes[0].geometry)
        .setMaterial(basic.meshes[0].material)
        .setPosition([15, 0, 0]);
      const roots = [box.root, fbx.root, basic.root, shared],
        overlap = [
          box.root,
          ...box.nodes,
          group,
          box.root,
          fbx.root,
          ...fbx.nodes,
          basic.root,
          ...basic.nodes,
          ...basic.meshes,
          shared,
        ];
      const entries = [...cpuEntries([box, fbx]), ...coreEntries([...basic.meshes, shared])],
        expected = reference(entries);
      const meshes = entries.map((entry) => entry.node),
        facade = loadedModel(instance, { root: group, meshes: [group, ...meshes, meshes[0]], dispose() {} });
      const assertFacadeFit = (selection, bounds, message) =>
        noGPU(() => {
          stage.fit(selection);
          engine.camera.advance(1);
          close(
            engine.camera.target,
            [0, 1, 2].map((axis) => (bounds[axis] + bounds[axis + 3]) / 2),
            message,
          );
        }, `${message}: query performed GPU work`);
      const baseline = await capture('mixed:before-queries'),
        savedCamera = { position: [...engine.camera.position], target: [...engine.camera.target] };
      const measured = noGPU(() => getSceneBounds(instance, roots), 'bounds allocated, uploaded or encoded GPU work');
      check(measured instanceof Float32Array && measured.length === 6, 'scene bounds must be six Float32 values');
      close(measured, expected, 'independent mixed bind-pose bounds');
      close(
        noGPU(() => getSceneBounds(instance, overlap), 'overlapping bounds performed GPU work'),
        expected,
        'overlapping roots deduplicate descendants',
      );
      const raw = noGPU(
        () => assertRaw(gatherSceneBuffers(instance, roots)),
        'raw gather allocated/uploaded/destroyed GPU resources',
      );
      noGPU(() => assertRaw(gatherSceneBuffers(instance, overlap)), 'overlapping raw gather performed GPU work');
      close(
        noGPU(() => worldBounds(instance, meshes, new Float32Array(6)), 'facade bounds performed GPU work'),
        expected,
        'facade independent mixed bounds',
      );
      assertFacadeFit(meshes, expected, 'Stage.fit mixed PBR/core center');
      assertFacadeFit(undefined, expected, 'Stage.fit default scene center');
      for (const model of [box, fbx])
        assertFacadeFit(
          model.primitives.map((primitive) => primitive.node),
          reference(cpuEntries([model])),
          'Stage.fit pure ' + model.name,
        );
      facadeChecks.push('mixed/default/pure PBR fitting without GPU work');
      noGPU(() => assertFacadeRaw(facade.raw), 'facade raw allocated, uploaded or encoded GPU work');
      facadeChecks.push('native borrowed PBR buffers and deduplicated core batch');
      engine.camera.position = savedCamera.position;
      engine.camera.target = savedCamera.target;
      const center = [0, 1, 2].map((axis) => (expected[axis] + expected[axis + 3]) / 2),
        radius = Math.hypot(...[0, 1, 2].map((axis) => (expected[axis + 3] - expected[axis]) / 2)),
        aspect = 0.75,
        padding = 1.2;
      const direction = savedCamera.position.map((value, axis) => value - savedCamera.target[axis]),
        distance = (radius * padding) / Math.sin(Math.atan(Math.tan((engine.camera.fov * Math.PI) / 360) * aspect)),
        length = Math.hypot(...direction);
      const fitBounds = noGPU(
        () => fitScene(instance, roots, { aspect, padding, duration: 0 }),
        'fitScene performed GPU work',
      );
      close(fitBounds, expected, 'fitScene returned mixed bounds');
      close(engine.camera.target, center, 'fitScene union center');
      close(
        engine.camera.position,
        center.map((value, axis) => value + (direction[axis] / length) * distance),
        'fitScene aspect/padding forwarding',
      );
      engine.camera.cancelFit();
      engine.camera.position = savedCamera.position;
      engine.camera.target = savedCamera.target;
      close(await capture('mixed:after-queries-camera-reset'), baseline, 'query and fit camera reset raster parity', 0);
      group.visible = false;
      fbx.root.visible = false;
      const hiddenBounds = reference(coreEntries([...basic.meshes, shared]));
      close(
        noGPU(() => getSceneBounds(instance, roots), 'hidden bounds performed GPU work'),
        hiddenBounds,
        'ancestor visibility bounds',
      );
      check(
        noGPU(() => gatherSceneBuffers(instance, roots), 'hidden raw gather performed GPU work').length === 2,
        'hidden ancestors left visible PBR records',
      );
      close(
        noGPU(() => getSceneBounds(instance, roots, { visibleOnly: false }), 'all bounds performed GPU work'),
        expected,
        'visibleOnly:false includes hidden PBR descendants',
      );
      assertFacadeFit(meshes, hiddenBounds, 'Stage.fit excludes hidden PBR ancestors');
      close(
        noGPU(() => facade.bounds, 'hidden facade bounds performed GPU work'),
        expected,
        'facade bounds include hidden PBR geometry',
      );
      noGPU(() => assertFacadeRaw(facade.raw), 'hidden facade raw performed GPU work');
      facadeChecks.push('hidden fitting excluded while bounds and raw include hidden parts');
      noGPU(
        () => assertRaw(gatherSceneBuffers(instance, roots, { visibleOnly: false })),
        'all raw gather performed GPU work',
      );
      group.visible = true;
      fbx.root.visible = true;
      engine.camera.position = [0, 0, 4];
      engine.camera.target = [0, 0, 0];
      await capture('mixed:core-outside-frustum', true);
      check(
        engine.store.visible[basic.meshes[0].id] === 0 && !engine.store.hidden[basic.meshes[0].id],
        'offcamera control must have a culled core sphere',
      );
      close(
        noGPU(() => getSceneBounds(instance, roots), 'offcamera bounds performed GPU work'),
        expected,
        'scene bounds must ignore frustum visibility',
      );
      noGPU(() => assertRaw(gatherSceneBuffers(instance, roots)), 'offcamera raw gather performed GPU work');
      engine.camera.position = savedCamera.position;
      engine.camera.target = savedCamera.target;
      animation = Animation.attach(fbx, { loop: false });
      animation.playing = false;
      check(animation.clips.length > 0, 'real FBX has no animation');
      animation.seek(animation.clips[0].duration * 0.53);
      await capture('mixed:animated-FBX');
      const animatedPrimitive = fbx.primitives[0];
      check(animatedPrimitive.deformed instanceof GPUBuffer, 'real FBX did not allocate its current GPU deformation');
      const time = animation.time,
        prepare = fbx.prepareDeformation;
      let prepareCalls = 0;
      fbx.prepareDeformation = (context) => {
        prepareCalls++;
        return prepare(context);
      };
      const animatedRaw = noGPU(
        () => assertRaw(gatherSceneBuffers(instance, roots)),
        'current-pose gather encoded or uploaded GPU work',
      );
      close(
        noGPU(() => getSceneBounds(instance, roots), 'animated bind-pose bounds performed GPU work'),
        reference(entries),
        'animated bounds remain bind pose in current world matrices',
      );
      const facadeAnimatedRaw = noGPU(() => assertFacadeRaw(facade.raw), 'animated facade raw performed GPU work');
      check(
        facadeAnimatedRaw.find((record) => record.primitive === animatedPrimitive).vertex ===
          animatedPrimitive.deformed,
        'facade raw exposed the bind-pose buffer instead of current deformation',
      );
      close(
        noGPU(() => facade.bounds, 'animated facade bounds performed GPU work'),
        reference(entries),
        'facade bounds remain CPU bind pose',
      );
      facadeChecks.push('current deformation borrowed without advancing animation');
      check(
        animatedRaw.find((record) => record.node === animatedPrimitive.node).vertex === animatedPrimitive.deformed &&
          animation.time === time &&
          prepareCalls === 0,
        'gather prepared deformation, advanced animation or exposed bind-pose GPU buffers',
      );
      fbx.prepareDeformation = prepare;
      const beforeRestore = await capture('mixed:before-restore'),
        oldDevice = engine.gpu,
        oldRaw = gatherSceneBuffers(instance, roots),
        oldLive = resources.filter((record) => record.device === oldDevice && !record.destroyed);
      const oldFacadeRaw = facade.raw;
      await instance.rebootDevice();
      check(engine.gpu !== oldDevice, 'restoration retained the old GPUDevice');
      const restoredRaw = noGPU(
        () => assertRaw(gatherSceneBuffers(instance, roots)),
        'restored raw gather performed GPU work',
      );
      for (const record of restoredRaw) {
        const previous = oldRaw.find((value) => value.node === record.node);
        check(
          record.vertex !== previous.vertex &&
            record.index !== previous.index &&
            (record.kind !== 'core' || record.instance !== previous.instance),
          'restored gather exposed obsolete device buffers',
        );
      }
      const restoredFacadeRaw = noGPU(() => assertFacadeRaw(facade.raw), 'restored facade raw performed GPU work');
      for (const record of restoredFacadeRaw) {
        const previous = oldFacadeRaw.find((value) => value.primitive === record.primitive);
        check(
          previous &&
            record.vertex !== previous.vertex &&
            record.index !== previous.index &&
            (!record.instance || record.instance !== previous.instance),
          'facade raw retained obsolete device buffers',
        );
      }
      facadeChecks.push('device restoration refreshes borrowed buffers');
      check(
        oldLive.every((record) => record.destroyed),
        'device restoration retained old borrowed resources',
      );
      close(await capture('mixed:after-restore'), beforeRestore, 'restored mixed raster parity', 0);
      const boxMesh = box.primitives[0].node,
        fbxMesh = fbx.primitives[0].node;
      animation.destroy();
      animation = undefined;
      box.destroy();
      box = undefined;
      fbx.destroy();
      fbx = undefined;
      const remaining = noGPU(
        () => gatherSceneBuffers(instance, [group, basic.root, shared]),
        'disposed scene raw gather performed GPU work',
      );
      check(
        remaining.length === 2 && remaining.every((record) => record.kind === 'core'),
        'disposed PBR sources remained in mixed gather',
      );
      check(boxMesh.geometry === null && fbxMesh.geometry === null, 'disposal attached core copies to old PBR handles');
      for (const query of [() => facade.bounds, () => facade.raw, () => stage.fit([boxMesh])]) {
        noGPU(() => {
          let rejected = false;
          try {
            query();
          } catch (error) {
            rejected = /^Mesh disposed$/.test(error.message);
          }
          check(rejected, 'facade query accepted a disposed PBR handle');
        }, 'stale facade query performed GPU work');
      }
      assertFacadeFit(
        undefined,
        reference(coreEntries([...basic.meshes, shared])),
        'Stage.fit remaining core-only scene',
      );
      facadeChecks.push('disposed handles rejected and remaining core geometry still fits');
      const empty = instance.createMesh();
      check(
        noGPU(() => gatherSceneBuffers(instance, [empty]), 'empty gather performed GPU work').length === 0,
        'recycled mesh ID inherited loader buffers',
      );
      check(
        noGPU(
          () => loadedModel(instance, { root: empty, meshes: [empty], dispose() {} }).raw,
          'empty facade raw performed GPU work',
        ).length === 0,
        'recycled mesh ID inherited facade buffers',
      );
      empty.dispose();
      facadeChecks.push('reused empty handles inherit no buffers');
      basic.dispose();
      basic = undefined;
      shared.dispose();
      shared = undefined;
      group.dispose();
      group = undefined;
      instance.dispose();
      webglCanvas = document.createElement('canvas');
      webglCanvas.style.cssText = 'width:96px;height:96px';
      document.body.append(webglCanvas);
      webgl = await EngineKernel.create(webglCanvas, { backend: 'webgl2', fallback: webglRenderer, capacity: 16 });
      webglBasic = await loadBasicGLTF(webgl, '/packages/exporters/tests/fixtures/Box.glb');
      webglBasic.root.setPosition([12, 0, 0]);
      const glExpected = reference(coreEntries(webglBasic.meshes), engineRuntime(webgl));
      close(getSceneBounds(webgl, [webglBasic.root]), glExpected, 'WebGL2 core bounds');
      check(gatherSceneBuffers(webgl, [webglBasic.root]) === null, 'WebGL2 raw gathering must return null');
      const glStage = new Stage(webgl);
      glStage.fit(webglBasic.meshes);
      webgl.camera.advance(1);
      close(
        webgl.camera.target,
        [0, 1, 2].map((axis) => (glExpected[axis] + glExpected[axis + 3]) / 2),
        'Stage.fit WebGL2 core center',
      );
      check(loadedModel(webgl, webglBasic).raw === null, 'facade raw must stay null on WebGL2');
      facadeChecks.push('WebGL2 core fitting and null raw buffers');
      close(fitScene(webgl, [webglBasic.root], { duration: 0 }), glExpected, 'WebGL2 fit bounds');
      close(
        webgl.camera.target,
        [0, 1, 2].map((axis) => (glExpected[axis] + glExpected[axis + 3]) / 2),
        'WebGL2 fit center',
      );
      webglBasic.dispose();
      webglBasic = undefined;
      webgl.dispose();
      webgl = undefined;
      const compilation = (await Promise.all(modules.map((module) => module.getCompilationInfo()))).flatMap((info) =>
        info.messages.filter((message) => message.type === 'error').map((message) => message.message),
      );
      check(compilation.length === 0 && errors.length === 0, [...compilation, ...errors].join('\n'));
      check(
        resources.every((record) => record.destroyed),
        `GPU resources leaked: ${resources
          .filter((record) => !record.destroyed)
          .map((record) => JSON.stringify(record.descriptor))
          .join(', ')}`,
      );
      return {
        sources: [
          'real Box.glb via gltf-pro',
          'real blender-rig.fbx via fbx',
          'real Box.glb via minimal gltf at X=12',
          'shared core Geometry at X=15',
        ],
        bounds: [...measured],
        records: raw.map((record) => ({ kind: record.kind, stride: record.stride, count: record.count })),
        facade: { checks: facadeChecks, rawRecords: restoredFacadeRaw.length, queryGPUActivity: 0 },
        sharedCoreBatchBorrowed: true,
        overlappingRootsDeduplicated: true,
        ancestorVisibility: true,
        frustumIndependent: true,
        queryGPUActivity: 0,
        cameraFitCenter: center,
        fitAspect: aspect,
        fitPadding: padding,
        queryRasterBitExact: true,
        currentDeformedBuffer: true,
        animationTimeUnchanged: true,
        bindPoseBounds: true,
        restoredBuffers: true,
        restoredRasterBitExact: true,
        disposedSourcesExcluded: true,
        webgl2BoundsAndFit: true,
        webgl2Buffers: null,
        captures,
        shaders: modules.length,
        resourcesDestroyed: resources.length,
        compilationErrors: compilation,
        validationErrors: errors,
      };
    } catch (error) {
      throw new Error(`${label}: ${error.message}\n${errors.join('\n')}`);
    } finally {
      animation?.destroy();
      box?.destroy();
      fbx?.destroy();
      basic?.dispose();
      shared?.dispose();
      group?.dispose();
      if (instance && !instance.disposed) instance.dispose();
      webglBasic?.dispose();
      if (webgl && !webgl.disposed) webgl.dispose();
      GPUAdapter.prototype.requestDevice = requestDevice;
      canvas.remove();
      webglCanvas?.remove();
    }
  });
}

export async function runSceneHelperTests() {
  await mkdir('test-results', { recursive: true });
  const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5212 }),
    errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error' || /ValidationError|Invalid .*Pipeline/.test(message.text()))
      errors.push(message.text());
  });
  try {
    const checks = await sceneHelperBrowserChecks(browser.page);
    assert.deepEqual(errors, []);
    const result = { hardware: browser.hardware, ...checks, errors };
    await writeFile('test-results/scene-helpers-webgpu.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSceneHelperTests();
