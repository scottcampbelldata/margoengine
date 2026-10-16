import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';

/** Real files, native GPU objects, real consumers. No loader/renderer shims. */
export async function silentGeometryBrowserChecks(page) {
  return page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { loadGLTF, parseGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { loadFBX } = await import('/packages/fbx/dist/index.js');
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { Inspector } = await import('/packages/inspector/dist/index.js');
    const { BoxHelper, VertexNormalsHelper } = await import('/packages/lines/dist/index.js');
    const { Picking, Selection } = await import('/packages/selection/dist/index.js');
    const { Raycaster } = await import('/packages/bvh/dist/index.js');
    const { AssemblyBVH } = await import('/packages/machinery/dist/spatial.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { Clustered } = await import('/packages/clustered/dist/index.js');
    const { TAA } = await import('/packages/taa/dist/index.js');
    // Imported separately from each package's bundled copy, intentionally.
    const { meshTriangles } = await import('/packages/shared/mesh-source.js');
    const check = (value, message) => {
      if (!value) throw new Error(message);
    };
    const W = 256,
      canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${W}px;height:${W}px`;
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 128,
      camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 45, near: 0.1, far: 150 },
    });
    const engine = engineRuntime(instance),
      resources = [],
      modules = [],
      errors = [],
      draws = [],
      captures = [],
      report = { assets: [] };
    let label = 'setup',
      picker,
      currentModel,
      boxData;
    const pipelines = new WeakMap(),
      tracked = new WeakSet();
    const track = (device) => {
      if (tracked.has(device)) return;
      tracked.add(device);
      device.addEventListener('uncapturederror', (event) => errors.push(`${label}: ${event.error.message}`));
      for (const name of ['createBuffer', 'createTexture']) {
        const create = device[name].bind(device);
        device[name] = (descriptor) => {
          const resource = create(descriptor),
            record = { device, resource, descriptor, destroyed: false },
            destroy = resource.destroy.bind(resource);
          resources.push(record);
          resource.destroy = () => {
            record.destroyed = true;
            destroy();
          };
          return resource;
        };
      }
      const shader = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const module = shader(descriptor);
        modules.push({ device, module, code: descriptor.code });
        return module;
      };
      const pipeline = device.createRenderPipeline.bind(device);
      device.createRenderPipeline = (descriptor) => {
        const result = pipeline(descriptor);
        pipelines.set(result, descriptor);
        return result;
      };
      const encode = device.createCommandEncoder.bind(device);
      device.createCommandEncoder = (...args) => {
        const encoder = encode(...args),
          begin = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (descriptor) => {
          const pass = begin(descriptor);
          let pipeline;
          const set = pass.setPipeline.bind(pass),
            indexed = pass.drawIndexed.bind(pass),
            draw = pass.draw.bind(pass);
          pass.setPipeline = (value) => {
            pipeline = pipelines.get(value);
            set(value);
          };
          pass.drawIndexed = (...args) => {
            draws.push({
              label,
              indexed: true,
              count: args[0],
              instances: args[1] ?? 1,
              colors: descriptor.colorAttachments.length,
              format: pipeline?.fragment?.targets?.[0]?.format,
              stride: pipeline?.vertex?.buffers?.[0]?.arrayStride,
            });
            indexed(...args);
          };
          pass.draw = (...args) => {
            draws.push({
              label,
              indexed: false,
              count: args[0],
              instances: args[1] ?? 1,
              colors: descriptor.colorAttachments.length,
              format: pipeline?.fragment?.targets?.[0]?.format,
            });
            draw(...args);
          };
          return pass;
        };
        return encoder;
      };
    };
    track(engine.gpu);
    engine.lighting.direction.set([2, 3, 5, 1]);
    engine.lighting.radiance.set([1, 1, 1, 0.4]);
    const settled = async (device) => {
      await device.queue.onSubmittedWorkDone();
      check(errors.length === 0, errors.join('\n'));
    };
    const textureBytes = async (device, texture, { layer = 0, aspect = 'all', bytes = 4 } = {}) => {
      const width = texture.width,
        height = texture.height,
        row = Math.ceil((width * bytes) / 256) * 256;
      const buffer = device.createBuffer({
        size: row * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture, origin: [0, 0, layer], aspect }, { buffer, bytesPerRow: row }, [
          width,
          height,
        ]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(buffer.getMappedRange()),
          output = new Uint8Array(width * height * bytes);
        for (let y = 0; y < height; y++)
          output.set(mapped.subarray(y * row, y * row + width * bytes), y * width * bytes);
        buffer.unmap();
        await settled(device);
        return output;
      } finally {
        buffer.destroy();
      }
    };
    const capture = async (name, culling = false) => {
      label = name;
      captures.push(name);
      const device = engine.gpu,
        context = canvas.getContext('webgpu'),
        format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const original = context.getCurrentTexture.bind(context);
      let texture;
      context.getCurrentTexture = () => (texture = original());
      try {
        instance.render({ culling });
        return await textureBytes(device, texture);
      } finally {
        context.getCurrentTexture = original;
      }
    };
    const delta = (a, b) => {
      let pixels = 0,
        left = 0,
        right = 0,
        max = 0;
      for (let i = 0; i < a.length; i += 4) {
        let changed = false;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(a[i + c] - b[i + c]);
          max = Math.max(max, d);
          changed ||= d > 0;
        }
        if (changed) {
          pixels++;
          if ((i / 4) % W < W / 2) left++;
          else right++;
        }
      }
      return { pixels, left, right, max };
    };
    const world = (vertices, matrix) =>
      Array.from({ length: vertices.length / 20 }, (_, i) =>
        [0, 1, 2].map(
          (a) =>
            matrix[a] * vertices[i * 20] +
            matrix[a + 4] * vertices[i * 20 + 1] +
            matrix[a + 8] * vertices[i * 20 + 2] +
            matrix[a + 12],
        ),
      );
    const project = (point) => {
      engine.camera.update(1, true);
      const m = engine.camera.matrix,
        q = [0, 0, 0, 0];
      for (let a = 0; a < 4; a++) q[a] = m[a] * point[0] + m[a + 4] * point[1] + m[a + 8] * point[2] + m[a + 12];
      return [((q[0] / q[3]) * 0.5 + 0.5) * W, (0.5 - (q[1] / q[3]) * 0.5) * W];
    };
    const visibleTriangle = (vertices, indices, matrix) => {
      const points = world(vertices, matrix);
      let best,
        area = 0;
      for (let i = 0; i < indices.length; i += 3) {
        const p = [0, 1, 2].map((a) => points[indices[i + a]]),
          xy = p.map(project);
        const size = Math.abs(
          (xy[1][0] - xy[0][0]) * (xy[2][1] - xy[0][1]) - (xy[1][1] - xy[0][1]) * (xy[2][0] - xy[0][0]),
        );
        if (size > area) {
          area = size;
          best = [0, 1, 2].map((a) => (p[0][a] + p[1][a] + p[2][a]) / 3);
        }
      }
      check(best && area > 8, 'loaded mesh has no useful projected triangle');
      return best;
    };
    const analyticRay = (primitive) => {
      const vertices = world(primitive.vertices, primitive.node.matrix);
      for (let i = 0; i < primitive.indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((n) => vertices[primitive.indices[i + n]]),
          u = b.map((v, n) => v - a[n]),
          v = c.map((v, n) => v - a[n]);
        const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
          length = Math.hypot(...normal);
        if (length < 1e-8) continue;
        const center = a.map((v, n) => (v + b[n] + c[n]) / 3),
          offset = Math.max(1, Math.hypot(...u), Math.hypot(...v));
        return {
          origin: center.map((v, n) => v + (normal[n] / length) * offset),
          direction: normal.map((v) => -v / length),
        };
      }
      throw new Error('loaded geometry contains no nondegenerate triangle');
    };
    const fit = (model) => {
      const b = model.bounds;
      check(b.every(Number.isFinite), 'model bounds must be finite');
      engine.camera.fitToBoundingBox(Array.from(b.subarray(0, 3)), Array.from(b.subarray(3)), {
        duration: 0,
        padding: 1.5,
      });
      engine.camera.update(1, true);
      return Array.from(b);
    };
    const pick = async (
      model,
      primitive = model.primitives[0],
      vertices = primitive.vertices,
      matrix = primitive.node.matrix,
    ) => {
      const point = visibleTriangle(vertices, primitive.indices, matrix),
        xy = project(point),
        actual = await instance.pick(...xy);
      check(actual === primitive.node, `${label}: automatic engine.pick missed actual loaded triangle at ${xy}`);
      await settled(engine.gpu);
      return xy;
    };
    const half = (value) => {
      const sign = value & 0x8000 ? -1 : 1,
        e = (value >> 10) & 31,
        fraction = value & 1023;
      return (
        sign *
        (e
          ? e === 31
            ? fraction
              ? NaN
              : Infinity
            : 2 ** (e - 15) * (1 + fraction / 1024)
          : (2 ** -14 * fraction) / 1024)
      );
    };

    // A genuine second GPUDevice proves that neither desktop buffers nor bind
    // groups are accidentally borrowed by XR's per-eye renderer.
    const separateDevice = async (model, name, expectedPose, animation) => {
      label = `${name}:second-device`;
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
        device = await adapter.requestDevice();
      check(device !== engine.gpu, 'stereo renderer must use a genuinely different GPUDevice');
      track(device);
      const before = resources.length,
        renderers = [model.createRenderer(device), model.createRenderer(device)];
      const replicaResources = resources.slice(before),
        targets = [],
        beforeTime = animation?.time;
      const bounds = model.bounds,
        center = [0, 1, 2].map((a) => (bounds[a] + bounds[a + 3]) / 2),
        radius = Math.max(0.1, Math.hypot(...[0, 1, 2].map((a) => (bounds[a + 3] - bounds[a]) / 2))),
        distance = radius * 4;
      const eyes = [],
        poses = [];
      try {
        const encoder = device.createCommandEncoder();
        for (const renderer of renderers) renderer.prepare({ backend: 'webgpu', device, encoder });
        for (let eye = 0; eye < 2; eye++) {
          const color = device.createTexture({
            size: [W, W],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          const msaa = device.createTexture({
            size: [W, W],
            format: 'rgba8unorm',
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          const depth = device.createTexture({
            size: [W, W],
            format: 'depth24plus',
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          targets.push(color, msaa, depth);
          const position = [center[0] + (eye ? 1 : -1) * radius * 0.2, center[1], center[2] + distance],
            angle = 0.19,
            co = Math.cos(angle),
            si = Math.sin(angle);
          const view = new Float32Array([
            co,
            -si,
            0,
            0,
            si,
            co,
            0,
            0,
            0,
            0,
            1,
            0,
            -co * position[0] - si * position[1],
            si * position[0] - co * position[1],
            -position[2],
            1,
          ]);
          const projection = new Float32Array(16),
            f = 1 / Math.tan(Math.PI / 8),
            near = 0.1,
            far = 150;
          projection[0] = projection[5] = f;
          projection[10] = far / (near - far);
          projection[11] = -1;
          projection[14] = (near * far) / (near - far);
          const matrix = new Float32Array(16);
          for (let c = 0; c < 4; c++)
            for (let r = 0; r < 4; r++)
              for (let k = 0; k < 4; k++) matrix[c * 4 + r] += projection[k * 4 + r] * view[c * 4 + k];
          const colorView = msaa.createView(),
            depthView = depth.createView();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: colorView,
                resolveTarget: color.createView(),
                clearValue: [0, 0, 0, 1],
                loadOp: 'clear',
                storeOp: 'discard',
              },
            ],
            depthStencilAttachment: {
              view: depthView,
              depthClearValue: 1,
              depthLoadOp: 'clear',
              depthStoreOp: 'discard',
            },
          });
          renderers[eye].draw(
            {
              backend: 'webgpu',
              device,
              encoder,
              camera: { ...engine.camera, position, target: center, matrix },
              width: W,
              height: W,
              delta: 0,
              color: colorView,
              depth: depthView,
              format: 'rgba8unorm',
              shader: '',
              bindings: [],
              indirect: false,
              descriptor: {
                vertex: { buffers: [] },
                multisample: { count: 4 },
                depthStencil: { format: 'depth24plus' },
              },
              draw() {},
            },
            pass,
            view,
          );
          pass.end();
        }
        device.queue.submit([encoder.finish()]);
        await settled(device);
        const pbrShaders = modules.filter(
          (record) =>
            record.device === device &&
            record.code.includes('fn surface(') &&
            record.code.includes('normalMap') &&
            record.code.includes('mrMap'),
        );
        check(pbrShaders.length === 2, `${name}: each eye must compile the ordinary material PBR shader`);
        for (const target of [targets[0], targets[3]]) {
          const pixels = await textureBytes(device, target);
          let count = 0,
            x = 0,
            y = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 8) {
              count++;
              x += (i / 4) % W;
              y += Math.floor(i / 4 / W);
            }
          check(count > 100, `${name}: second-device eye contains no PBR surface`);
          eyes.push({ pixels: count, centroid: [x / count, y / count] });
        }
        check(
          eyes[0].centroid[0] - eyes[1].centroid[0] > 4,
          `${name}: eyes lost independent view uniforms: ${JSON.stringify(eyes)}`,
        );
        if (expectedPose) {
          const outputs = replicaResources.filter(
            (r) =>
              r.resource instanceof GPUBuffer &&
              r.descriptor.size === expectedPose.byteLength &&
              (r.descriptor.usage & (GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC)) ===
                (GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC),
          );
          check(outputs.length === 2, `${name}: expected one separate deformed buffer per eye, got ${outputs.length}`);
          for (const { resource } of outputs) {
            const buffer = device.createBuffer({
              size: resource.size,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            try {
              const copy = device.createCommandEncoder();
              copy.copyBufferToBuffer(resource, 0, buffer, 0, resource.size);
              device.queue.submit([copy.finish()]);
              await buffer.mapAsync(GPUMapMode.READ);
              const values = new Float32Array(buffer.getMappedRange());
              let max = 0;
              for (let i = 0; i < expectedPose.length; i++) max = Math.max(max, Math.abs(values[i] - expectedPose[i]));
              check(
                max < 2e-5,
                `${name}: independent device deformation differs from current desktop GPU pose by ${max}`,
              );
              poses.push({ vertices: values.length / 20, maxDifference: max });
              buffer.unmap();
            } finally {
              buffer.destroy();
            }
          }
        }
        check(animation?.time === beforeTime, 'second-device prepare advanced desktop playback');
        model.destroy();
        check(
          replicaResources.every((record) => record.destroyed),
          `${name}: disposing source leaked per-eye GPU resources`,
        );
        let rejected = false;
        try {
          renderers[0].prepare({ backend: 'webgpu', device, encoder: device.createCommandEncoder() });
        } catch {
          rejected = true;
        }
        check(rejected, 'a disposed model left its external renderer usable');
        await settled(device);
        return {
          eyes,
          poses,
          pbrShaders: pbrShaders.length,
          resources: replicaResources.length,
          sampleCount: 4,
          depthFormat: 'depth24plus',
          separateDevice: true,
        };
      } finally {
        for (const renderer of renderers) renderer.dispose();
        for (const target of targets) target.destroy();
        await device.queue.onSubmittedWorkDone();
        device.destroy();
      }
    };

    try {
      picker = Picking.attach(instance, { capture: false });
      for (const fixture of [
        { name: 'gltf-pro:Box.glb', load: loadGLTF, url: '/packages/exporters/tests/fixtures/Box.glb' },
        { name: 'fbx:blender-rig.fbx', load: loadFBX, url: '/packages/fbx/test/fixtures/blender-rig.fbx' },
      ]) {
        label = fixture.name + ':load';
        const model = (currentModel = await fixture.load(instance, fixture.url)),
          primitive = model.primitives[0],
          mesh = primitive.node;
        check(
          model.primitives.length === 1 && primitive.indices.length > 0,
          label + ': actual file did not load a primitive',
        );
        if (fixture.load === loadGLTF)
          boxData = { doc: structuredClone(model.asset.doc), buffers: model.asset.buffers.map((data) => data.slice()) };
        const source = meshTriangles(mesh);
        check(
          source?.kind === 'pbr' && source.source.primitives[0] === primitive,
          label + ': bundled registry is disconnected',
        );
        const bounds = fit(model),
          summary = {
            asset: fixture.name,
            vertices: primitive.vertices.length / 20,
            indices: primitive.indices.length,
            bounds,
          };
        const base = await capture(fixture.name + ':beauty');
        summary.pick = await pick(model);
        const { origin, direction } = analyticRay(primitive),
          ray = new Raycaster(origin, direction);
        check(
          ray.intersectMeshes(instance, [mesh]).some((hit) => hit.mesh === mesh),
          'synchronous Raycaster dropped the loaded mesh',
        );
        check(
          ray.intersectEngine(instance).some((hit) => hit.mesh === mesh),
          'engine Raycaster dropped the loaded mesh',
        );
        const assembly = await AssemblyBVH.create([mesh]);
        try {
          check(assembly.raycast(origin, direction)?.node === mesh, 'AssemblyBVH dropped a loaded mesh');
        } finally {
          assembly.dispose();
        }
        summary.staticQueries = true;
        const box = new BoxHelper(mesh),
          normals = new VertexNormalsHelper(mesh);
        try {
          check(box.update(instance) && box.segmentCount === 12, 'real PBR box helper empty');
          check(
            normals.update(instance) && normals.segmentCount === primitive.vertices.length / 20,
            'real PBR normal helper empty',
          );
          check(
            box.points.every(Number.isFinite) && normals.points.every(Number.isFinite),
            'nonfinite helper attributes',
          );
        } finally {
          box.dispose();
          normals.dispose();
        }
        const inspector = Inspector.attach(instance);
        summary.overlays = {};
        try {
          for (const mode of ['wireframe', 'normals', 'bounds']) {
            inspector.setDebug(mode, true);
            const image = await capture(fixture.name + ':inspector:' + mode),
              difference = delta(base, image);
            check(
              difference.pixels > 20,
              `${fixture.name}: ${mode} overlay emitted no visible pixels: ${JSON.stringify(difference)}`,
            );
            summary.overlays[mode] = difference;
            inspector.setDebug(mode, false);
          }
          model.root.visible = false;
          const hidden = await capture(fixture.name + ':hidden');
          for (const mode of ['wireframe', 'normals', 'bounds']) inspector.setDebug(mode, true);
          check(
            delta(hidden, await capture(fixture.name + ':hidden-overlays')).max === 0,
            'inherited visibility left visible inspector geometry',
          );
          for (const mode of ['wireframe', 'normals', 'bounds']) inspector.setDebug(mode, false);
          model.root.visible = true;
        } finally {
          inspector.dispose();
        }
        const selection = Selection.attach(instance, { width: 4, color: [0, 1, 0] });
        try {
          selection.set([]);
          const plain = await capture(fixture.name + ':selection-empty');
          selection.set([mesh]);
          const difference = delta(plain, await capture(fixture.name + ':selection-auto'));
          check(difference.pixels > 30, `${fixture.name}: Selection.set without add silently dropped PBR mask`);
          summary.selection = difference;
        } finally {
          selection.dispose();
        }
        const shadows = Shadows.attach(instance, { resolution: 64, distance: 40, casterMargin: 10 });
        shadows.add(mesh);
        try {
          await capture(fixture.name + ':mesh-cascades');
          check(shadows.stats.dynamicDraws === 4, 'Mesh shadow route did not submit four cascades');
          const maps = resources.filter(
            (record) =>
              record.device === engine.gpu &&
              !record.destroyed &&
              record.descriptor.format === 'depth32float' &&
              Array.isArray(record.descriptor.size) &&
              record.descriptor.size[2] === 4,
          );
          check(maps.length === 2, 'cascade map textures missing');
          let written = 0;
          for (let layer = 0; layer < 4; layer++) {
            const bytes = await textureBytes(engine.gpu, maps[1].resource, { layer, aspect: 'depth-only' }),
              values = new Float32Array(bytes.buffer);
            written += values.filter((v) => v < 0.99999).length;
          }
          check(written > 0, 'cascade draws wrote no native depth texels');
          summary.cascadeTexels = written;
        } finally {
          shadows.dispose();
        }
        const clustered = Clustered.attach(instance, { grid: [4, 4, 4], shadows: { resolution: 64, maxLights: 2 } });
        clustered.setLights([
          { position: engine.camera.position, range: 100, shadow: true },
          {
            position: engine.camera.position,
            range: 100,
            direction: engine.camera.target.map((v, a) => v - engine.camera.position[a]),
            outerAngle: 0.7,
            shadow: true,
          },
        ]);
        clustered.addShadowCaster(mesh);
        try {
          const start = draws.length;
          await capture(fixture.name + ':mesh-local-shadows');
          const depth = draws.slice(start).filter((draw) => draw.indexed && draw.colors === 0 && draw.stride === 80);
          check(depth.length === 7, `${fixture.name}: expected six point faces and one spot face, got ${depth.length}`);
          summary.localShadowFaces = depth.length;
        } finally {
          clustered.dispose();
        }
        const taa = TAA.attach(instance);
        taa.add(model);
        const x = mesh.position.x;
        try {
          await capture(fixture.name + ':taa-static');
          mesh.position.x += Math.max(0.2, (bounds[3] - bounds[0]) * 0.15);
          const start = draws.length;
          await capture(fixture.name + ':taa-moving');
          const velocityDraws = draws.slice(start).filter((draw) => draw.indexed && draw.format === 'rg16float');
          check(
            velocityDraws.length === 1 && velocityDraws[0].stride === 80,
            'TAA duplicated or dropped loader motion',
          );
          const values = new Uint16Array((await textureBytes(engine.gpu, taa.gpuState.velocity)).buffer);
          let moving = 0,
            maximum = 0;
          for (let i = 0; i < values.length; i += 2) {
            const vx = half(values[i]),
              vy = half(values[i + 1]);
            check(Number.isFinite(vx) && Number.isFinite(vy), 'TAA velocity contains invalid values');
            if (vx > 0.01) moving++;
            maximum = Math.max(maximum, vx);
          }
          check(moving > 20, `${fixture.name}: TAA motion has no moving surface: ${moving}, ${maximum}`);
          summary.taa = { draws: velocityDraws.length, movingPixels: moving, maxVelocity: maximum };
        } finally {
          mesh.position.x = x;
          taa.dispose();
        }
        let pose, animation;
        if (fixture.load === loadFBX) {
          animation = Animation.attach(model, { loop: false });
          animation.playing = false;
          check(animation.clips.length > 0, 'real FBX rig contains no animation');
          animation.seek(animation.clips[0].duration * 0.53);
          const snapshots = await model.readPickingGeometry();
          pose = snapshots[0].vertices;
          check(snapshots.length === 1 && primitive.deformed, 'real rig has no GPU deformation');
          let changed = 0;
          for (let i = 0; i < pose.length; i += 20)
            for (let a = 0; a < 3; a++) changed = Math.max(changed, Math.abs(pose[i + a] - primitive.vertices[i + a]));
          check(changed > 0.001, 'real rig animation remained in bind pose');
          summary.poseDifference = changed;
          fit(model);
          await capture(fixture.name + ':animated');
          await pick(model, primitive, pose, snapshots[0].matrix);
          const point = visibleTriangle(pose, primitive.indices, snapshots[0].matrix),
            origin = engine.camera.position,
            direction = point.map((v, a) => v - origin[a]);
          check(
            (await new Raycaster(origin, direction).intersectModel(model)).some((hit) => hit.mesh === mesh),
            'current-pose async BVH dropped real rig',
          );
        }
        const beforeRestore = await capture(fixture.name + ':before-restore'),
          oldDevice = engine.gpu,
          oldVertex = meshTriangles(mesh).source.draws[0].vertex,
          oldRecords = resources.filter((record) => record.device === oldDevice);
        await instance.rebootDevice();
        track(engine.gpu);
        check(
          engine.gpu !== oldDevice && meshTriangles(mesh).source.draws[0].vertex !== oldVertex,
          'registry retained old device buffers',
        );
        const afterRestore = await capture(fixture.name + ':after-restore');
        check(delta(beforeRestore, afterRestore).max === 0, 'device restoration changed current-pose beauty');
        check(
          oldRecords.every((record) => record.destroyed),
          'device restoration leaked tracked resources',
        );
        if (pose) {
          const snapshots = await model.readPickingGeometry();
          pose = snapshots[0].vertices;
          await pick(model, primitive, pose, snapshots[0].matrix);
        } else await pick(model);
        summary.restored = true;
        summary.external = await separateDevice(model, fixture.name, pose, animation);
        check(
          meshTriangles(mesh) === null && mesh.geometry === null,
          'model disposal did not clear registry ownership',
        );
        currentModel = undefined;
        report.assets.push(summary);
      }
      label = 'multi-primitive';
      const doc = structuredClone(boxData.doc),
        definition = doc.meshes[0].primitives[0];
      // Read source positions through the real parser, then extend its actual file data.
      const original = parseGLTF(instance, doc, boxData.buffers),
        values = original.primitives[0].vertices,
        positions = new Float32Array((values.length / 20) * 3);
      for (let i = 0; i < positions.length / 3; i++)
        positions.set([values[i * 20] + 3, values[i * 20 + 1], values[i * 20 + 2]], i * 3);
      original.destroy();
      const buffer = doc.buffers.length,
        view = doc.bufferViews.length,
        accessor = doc.accessors.length;
      doc.buffers.push({ byteLength: positions.byteLength });
      doc.bufferViews.push({ buffer, byteLength: positions.byteLength });
      doc.accessors.push({ bufferView: view, count: positions.length / 3, componentType: 5126, type: 'VEC3' });
      const second = structuredClone(definition);
      second.attributes.POSITION = accessor;
      doc.meshes[0].primitives.push(second);
      const combined = (currentModel = parseGLTF(instance, doc, [...boxData.buffers, positions]));
      fit(combined);
      check(
        meshTriangles(combined.primitives[0].node).source.primitives.length === 2,
        'multi-primitive registry lost a part',
      );
      const plain = await capture('multi-primitive:plain');
      await pick(combined, combined.primitives[0]);
      await pick(combined, combined.primitives[1]);
      const selection = Selection.attach(instance, { width: 4, color: [0, 1, 0] });
      try {
        selection.set([combined.primitives[0].node]);
        const start = draws.length,
          difference = delta(plain, await capture('multi-primitive:selection'));
        const masks = draws.slice(start).filter((draw) => draw.indexed && draw.format === 'r8unorm');
        check(
          masks.length === 2 && difference.left > 30 && difference.right > 30,
          'one-node multi-primitive selection silently omitted a part: ' + JSON.stringify({ masks, difference }),
        );
        report.multiPrimitive = difference;
      } finally {
        selection.dispose();
      }
      const deleted = combined.primitives[0].node;
      combined.destroy();
      currentModel = undefined;
      check(meshTriangles(deleted) === null, 'multi-primitive source survived disposal');
      const fresh = instance.createMesh();
      check(fresh.geometry === null && meshTriangles(fresh) === null, 'reused ID inherited deleted PBR triangles');
      fresh.dispose();
      const edge = (currentModel = parseGLTF(instance, structuredClone(boxData.doc), boxData.buffers)),
        edgeMesh = edge.primitives[0].node;
      edgeMesh.setPosition([3.279201435678004 * 0.75, 0, 0]);
      engine.camera.position = [0, 0, 4];
      engine.camera.target = [0, 0, 0];
      engine.camera.fov = 60;
      edge.root.visible = false;
      const emptyEdge = await capture('frustum-edge:hidden', true);
      edge.root.visible = true;
      const edgeBeauty = await capture('frustum-edge:beauty', true);
      check(
        engine.store.visible[edgeMesh.id] === 0 && !engine.store.hidden[edgeMesh.id],
        'edge fixture must cull its empty core sphere',
      );
      check(delta(emptyEdge, edgeBeauty).pixels > 50, 'edge fixture has no actually visible PBR surface');
      const edgeInspector = Inspector.attach(instance);
      report.frustumEdge = {};
      try {
        for (const mode of ['wireframe', 'normals', 'bounds']) {
          edgeInspector.setDebug(mode, true);
          const difference = delta(edgeBeauty, await capture('frustum-edge:' + mode, true));
          check(engine.store.visible[edgeMesh.id] === 0, 'debug overlays changed core culling state');
          check(
            difference.pixels > 10,
            `${mode} dropped PBR triangles crossing the frustum: ${JSON.stringify(difference)}`,
          );
          report.frustumEdge[mode] = difference;
          edgeInspector.setDebug(mode, false);
        }
      } finally {
        edgeInspector.dispose();
        edge.destroy();
        currentModel = undefined;
      }
      picker.dispose();
      picker = undefined;
      instance.dispose();
      const compilation = (await Promise.all(modules.map(({ module }) => module.getCompilationInfo()))).flatMap(
        (info) => info.messages.filter((message) => message.type === 'error').map((message) => message.message),
      );
      check(compilation.length === 0, compilation.join('\n'));
      check(errors.length === 0, errors.join('\n'));
      check(
        resources.every((record) => record.destroyed),
        `GPU resources leaked: ${resources
          .filter((record) => !record.destroyed)
          .map((record) => JSON.stringify(record.descriptor))
          .join(', ')}`,
      );
      return {
        ...report,
        captures: captures.length,
        labels: captures,
        shaders: modules.length,
        resourcesDestroyed: resources.length,
        compilationErrors: compilation,
        validationErrors: errors,
      };
    } catch (error) {
      throw new Error(label + ': ' + error.message + '\n' + errors.join('\n'));
    } finally {
      currentModel?.destroy();
      picker?.dispose();
      if (!instance.disposed) instance.dispose();
      canvas.remove();
    }
  });
}

export async function runSilentGeometryTests() {
  await mkdir('test-results', { recursive: true });
  const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5209 }),
    errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error' || /ValidationError|Invalid .*Pipeline/.test(message.text()))
      errors.push(message.text());
  });
  try {
    const checks = await silentGeometryBrowserChecks(browser.page);
    assert.deepEqual(errors, []);
    const result = { hardware: browser.hardware, ...checks, errors };
    await writeFile('test-results/silent-geometry-webgpu.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSilentGeometryTests();
