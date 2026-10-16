import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';
import { materialQuad } from '../tests/support/materials-fixture.js';
import { textureQuad } from '../tests/support/texture-fixture.js';

const serialize = (fixture) => ({
  doc: fixture.doc,
  buffers: fixture.buffers.map((buffer) => [...new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)]),
});
const horizontal = (fixture, size = 1, height = 0) => {
  const { attributes } = fixture.doc.meshes[0].primitives[0],
    positions = fixture.buffers[attributes.POSITION],
    normals = fixture.buffers[attributes.NORMAL];
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= size;
    positions[i + 2] = -positions[i + 1] * size;
    positions[i + 1] = height;
    normals.set([0, 1, 0], i);
  }
  return fixture;
};

/** Real renderer coverage of local-light depth maps, independent of directional shadows. */
export async function localShadowBrowserChecks(page) {
  const floor = horizontal(materialQuad(), 4),
    transform = { offset: [0.29, 0.14], rotation: 0.43, scale: [0.71, 0.83], texCoord: 1 };
  const actual = horizontal(textureQuad('base', transform, { required: true }), 1.2, 1.8),
    reference = horizontal(textureQuad('base', transform, { bake: true }), 1.2, 1.8);
  for (const fixture of [floor, actual, reference]) {
    fixture.doc.materials[0].pbrMetallicRoughness.baseColorFactor = [0.65, 0.65, 0.65, 1];
    fixture.doc.materials[0].pbrMetallicRoughness.metallicFactor = 0;
    fixture.doc.materials[0].pbrMetallicRoughness.roughnessFactor = 0.8;
  }
  for (const fixture of [actual, reference]) {
    fixture.doc.materials[0].alphaMode = 'MASK';
    fixture.doc.materials[0].alphaCutoff = 0.5;
  }
  return page.evaluate(
    async (payload) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js'),
        { engineRuntime, box, PbrMaterial } = await import('/packages/core/dist/extension.js');
      const { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { Clustered, clusteredSampling } = await import('/packages/clustered/dist/index.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js');
      const { Terrain } = await import('/packages/terrain/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js');
      const assert = (value, message) => {
          if (!value) throw new Error(message);
        },
        canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:320px';
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          capacity: 64,
          camera: { position: [6, 6, 8], target: [0, 0, 0], fov: 50, near: 0.1, far: 60 },
        }),
        engine = engineRuntime(instance);
      const resources = [],
        modules = [],
        validation = [],
        captured = [],
        width = 320,
        height = 320,
        bytesPerRow = width * 4;
      const track = (device) => {
        device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
        for (const name of ['createTexture', 'createBuffer']) {
          const create = device[name].bind(device);
          device[name] = (descriptor) => {
            const value = create(descriptor),
              record = { value, descriptor, kind: name, destroyed: false },
              destroy = value.destroy.bind(value);
            resources.push(record);
            value.destroy = () => {
              record.destroyed = true;
              destroy();
            };
            return value;
          };
        }
        const create = device.createShaderModule.bind(device);
        device.createShaderModule = (descriptor) => {
          const value = create(descriptor);
          modules.push(value);
          return value;
        };
      };
      track(engine.gpu);
      engine.lighting.direction.set([2, 5, 3, 0]);
      engine.lighting.radiance.set([1, 1, 1, 0]);
      const geometry = box(),
        material = new PbrMaterial({ color: [0.65, 0.65, 0.65], roughness: 0.8 });
      const coreFloor = instance
        .createMesh()
        .setGeometry(geometry)
        .setScale([8, 0.2, 8])
        .setPosition([0, -0.1, 0])
        .setMaterial(material);
      const blocker = instance
        .createMesh()
        .setGeometry(geometry)
        .setScale([1.1, 1.1, 1.1])
        .setPosition([0, 1.5, 0])
        .setMaterial(material);
      const load = (fixture) =>
        parseGLTF(
          instance,
          structuredClone(fixture.doc),
          fixture.buffers.map((buffer) => new Uint8Array(buffer)),
        );
      const pbrFloor = load(payload.floor);
      pbrFloor.root.visible = false;
      let clustered, removeBlocker, directional;
      const point = { position: [-2, 5, 2], range: 14, color: [1, 1, 1], intensity: 60 },
        spot = {
          position: [0, 5, 0],
          range: 14,
          color: [1, 1, 1],
          intensity: 60,
          direction: [0, -1, 0],
          outerAngle: 0.52,
          innerAngle: 0.38,
        };
      const difference = (left, right, channel) => {
        let max = 0,
          pixels = 0,
          sum = 0,
          x = 0,
          y = 0;
        for (let i = 0; i < left.length; i += 4) {
          let delta = 0;
          for (let c = 0; c < 3; c++)
            if (channel === undefined || c === channel) {
              const d = Math.abs(left[i + c] - right[i + c]);
              max = Math.max(max, d);
              delta += d;
            }
          if (delta > 3) {
            pixels++;
            x += (i / 4) % width;
            y += Math.floor(i / 4 / width);
          }
          sum += delta;
        }
        return { max, pixels, sum, centroid: pixels ? [x / pixels, y / pixels] : [0, 0] };
      };
      const exact = (a, b, message) => {
        const diff = difference(a, b);
        assert(diff.max === 0, message + ': ' + JSON.stringify(diff));
        return diff;
      };
      // Copy the actual canvas texture immediately after submit, before presentation.
      // This keeps MSAA, core batches, PBR passes and the frame graph in the test path.
      const render = async (label) => {
        const device = engine.gpu,
          context = canvas.getContext('webgpu'),
          format = navigator.gpu.getPreferredCanvasFormat();
        let current;
        context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const getCurrentTexture = context.getCurrentTexture.bind(context);
        context.getCurrentTexture = () => (current = getCurrentTexture());
        let read;
        try {
          captured.push(label);
          instance.render({ culling: false });
          read = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture: current }, { buffer: read, bytesPerRow }, [width, height]);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const bytes = new Uint8Array(read.getMappedRange()).slice();
          read.unmap();
          if (format.startsWith('bgra'))
            for (let i = 0; i < bytes.length; i += 4) {
              const b = bytes[i];
              bytes[i] = bytes[i + 2];
              bytes[i + 2] = b;
            }
          assert(validation.length === 0, label + ': ' + validation.join('\n'));
          return bytes;
        } finally {
          context.getCurrentTexture = getCurrentTexture;
          read?.destroy();
        }
      };
      const lit = async (light, shadow, label) => {
        clustered.setLights([{ ...light, shadow }]);
        return render(label);
      };
      const surface = (pbr) => {
        coreFloor.visible = !pbr;
        pbrFloor.root.visible = pbr;
      };
      const sample = (bytes, position) => {
        const m = engine.camera.matrix,
          p = [...position, 1],
          v = [0, 0, 0, 0];
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) v[r] += m[c * 4 + r] * p[c];
        const x = Math.round(((v[0] / v[3]) * 0.5 + 0.5) * width),
          y = Math.round((0.5 - (v[1] / v[3]) * 0.5) * height),
          values = [0, 0, 0];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            for (let c = 0; c < 3; c++) values[c] += bytes[((y + dy) * width + x + dx) * 4 + c] / 9;
        return values;
      };
      const report = {};
      try {
        clustered = Clustered.attach(instance, { grid: [4, 4, 8] });
        clustered.add(pbrFloor);
        const corePlain = await lit(point, false, 'core:baseline');
        surface(true);
        const pbrPlain = await lit(point, false, 'pbr:baseline');
        clustered.dispose();
        clustered = Clustered.attach(instance, { grid: [4, 4, 8], shadows: { resolution: 128, maxLights: 4 } });
        clustered.add(pbrFloor);
        removeBlocker = clustered.addShadowCaster(blocker);
        report.disabledParity = {
          pbr: exact(pbrPlain, await lit(point, false, 'pbr:disabled'), 'Disabled local shadows changed PBR pixels'),
        };
        surface(false);
        report.disabledParity.core = exact(
          corePlain,
          await lit(point, false, 'core:disabled'),
          'Disabled local shadows changed core pixels',
        );
        const results = [];
        for (const pbr of [false, true])
          for (const [kind, light] of [
            ['point', point],
            ['spot', spot],
          ]) {
            surface(pbr);
            const unshadowed = await lit(light, false, `${pbr ? 'pbr' : 'core'}:${kind}:off`),
              shadowed = await lit(
                light,
                { near: 0.1, bias: 0.0005, normalBias: 0.015 },
                `${pbr ? 'pbr' : 'core'}:${kind}:on`,
              ),
              delta = difference(unshadowed, shadowed);
            assert(
              delta.pixels > 70,
              `${kind} shadows did not darken the ${pbr ? 'PBR' : 'core'} receiver: ${JSON.stringify(delta)}`,
            );
            let dark = 0,
              bright = 0;
            for (let i = 0; i < shadowed.length; i += 4)
              for (let c = 0; c < 3; c++) {
                dark += Math.max(0, unshadowed[i + c] - shadowed[i + c]);
                bright += Math.max(0, shadowed[i + c] - unshadowed[i + c]);
              }
            assert(dark > bright * 20 + 100, `${kind} shadow map added light rather than occluding it`);
            results.push({ surface: pbr ? 'pbr' : 'core', kind, ...delta, dark, bright });
          }
        report.receivers = results;
        coreFloor.visible = false;
        pbrFloor.root.visible = false;
        const terrain = Terrain.attach(instance, {
            resolution: 32,
            levels: 1,
            size: [8, 8],
            origin: [-4, -4],
            heightScale: 1,
            layers: Array.from({ length: 4 }, () => ({ height: [-2, 2], slope: [0, 1], scale: 1 })),
            textures: (device) => {
              const heightmap = device.createTexture({
                  size: [4, 4],
                  format: 'r32float',
                  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                }),
                layers = device.createTexture({
                  size: [1, 1, 4],
                  format: 'rgba8unorm-srgb',
                  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });
              device.queue.writeTexture({ texture: heightmap }, new Float32Array(16), { bytesPerRow: 16 }, [4, 4]);
              device.queue.writeTexture(
                { texture: layers },
                new Uint8Array(Array.from({ length: 4 }, () => [210, 210, 210, 255]).flat()),
                { bytesPerRow: 4, rowsPerImage: 1 },
                [1, 1, 4],
              );
              return { heightmap, layers };
            },
          }),
          removeTerrain = clustered.add(terrain),
          terrainResults = [];
        try {
          for (const [kind, light] of [
            ['point', point],
            ['spot', spot],
          ]) {
            const off = await lit(light, false, `terrain:${kind}:off`),
              on = await lit(light, true, `terrain:${kind}:on`),
              delta = difference(off, on);
            assert(delta.pixels > 70, `Terrain did not receive ${kind} shadows: ${JSON.stringify(delta)}`);
            terrainResults.push({ kind, ...delta });
          }
        } finally {
          removeTerrain();
          terrain.dispose();
        }
        report.terrain = terrainResults;
        surface(false);
        const stationaryOn = await lit(point, true, 'movement:stationary:on'),
          stationaryOff = await lit(point, false, 'movement:stationary:off'),
          stationaryMask = difference(stationaryOn, stationaryOff);
        blocker.setPosition([1.7, 1.5, 0]);
        const casterOn = await lit(point, true, 'movement:caster:on'),
          casterOff = await lit(point, false, 'movement:caster:off'),
          casterMask = difference(casterOn, casterOff);
        assert(
          casterMask.pixels > 50 &&
            Math.hypot(
              casterMask.centroid[0] - stationaryMask.centroid[0],
              casterMask.centroid[1] - stationaryMask.centroid[1],
            ) > 10,
          'Moving a caster did not move its shadow',
        );
        blocker.setPosition([0, 1.5, 0]);
        const movedLight = { ...point, position: [2, 5, -2] },
          lightOn = await lit(movedLight, true, 'movement:light:on'),
          lightOff = await lit(movedLight, false, 'movement:light:off'),
          lightMask = difference(lightOn, lightOff);
        assert(
          lightMask.pixels > 50 &&
            Math.hypot(
              lightMask.centroid[0] - stationaryMask.centroid[0],
              lightMask.centroid[1] - stationaryMask.centroid[1],
            ) > 5,
          'Moving a point light did not move its shadow',
        );
        report.movement = { stationary: stationaryMask, caster: casterMask, light: lightMask };
        const red = { ...point, color: [1, 0, 0] },
          blue = { position: [2, 4, 2], range: 14, color: [0, 0, 1], intensity: 30 };
        clustered.setLights([{ ...red, shadow: false }, blue]);
        const mixedOff = await render('independent:off');
        clustered.setLights([{ ...red, shadow: true }, blue]);
        const mixedOn = await render('independent:on');
        report.independentLight = { red: difference(mixedOff, mixedOn, 0), blue: difference(mixedOff, mixedOn, 2) };
        assert(report.independentLight.red.pixels > 50, 'Shadowed red light did not change');
        assert(report.independentLight.blue.max === 0, 'A red light shadow attenuated an independent blue light');
        const cone = await lit(spot, true, 'spot:cone'),
          inside = sample(cone, [1.8, 0, 0]),
          outside = sample(cone, [3.5, 0, 0]);
        assert(Math.min(...inside) > Math.max(...outside) + 25, 'Spot light illuminated pixels outside its cone');
        report.spotCone = { inside, outside };
        // Six independent axis-aligned boxes make every cube face observable, with
        // different analytic depths so accidentally reusing a face cannot pass.
        removeBlocker();
        blocker.visible = false;
        coreFloor.visible = false;
        pbrFloor.root.visible = false;
        const axes = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ],
          faceBoxes = [],
          faceRemovers = [],
          distances = axes.map((_, i) => 1.7 + i * 0.45);
        for (let i = 0; i < 6; i++) {
          const mesh = instance
            .createMesh()
            .setGeometry(geometry)
            .setScale([0.4, 0.4, 0.4])
            .setPosition(axes[i].map((v) => v * distances[i]));
          faceBoxes.push(mesh);
          faceRemovers.push(clustered.addShadowCaster(mesh));
        }
        clustered.setLights([
          { position: [0, 0, 0], range: 6, intensity: 1, shadow: { near: 0.15, bias: 0, normalBias: 0 } },
        ]);
        await render('point:six-faces');
        const map = clustered.localShadows.depth,
          device = engine.gpu,
          size = 128,
          row = size * 4,
          layerBytes = row * size,
          read = device.createBuffer({
            size: layerBytes * 6,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer(
            { texture: map, aspect: 'depth-only' },
            { buffer: read, bytesPerRow: row, rowsPerImage: size },
            [size, size, 6],
          );
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const depths = new Float32Array(read.getMappedRange()),
            faces = [];
          for (let face = 0; face < 6; face++) {
            const pixels = depths.subarray(face * size * size, (face + 1) * size * size),
              depth = pixels[(size / 2) * size + size / 2],
              expected = 6 / (6 - 0.15) - (6 * 0.15) / ((6 - 0.15) * (distances[face] - 0.2)),
              coverage = pixels.filter((value) => value < 1).length;
            assert(
              coverage > 9 && Math.abs(depth - expected) < 0.0005,
              `Point face ${face} has the wrong independently calculated depth: ${JSON.stringify({ depth, expected, coverage })}`,
            );
            faces.push({ axis: axes[face], depth, expected, coverage });
          }
          report.pointFaces = faces;
          read.unmap();
          const output = device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
            visibilityRead = device.createBuffer({
              size: 48,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
          try {
            // Read the renderer's light buffer so the probes do not duplicate its shadow-index packing.
            const samples = axes.flatMap((axis, i) => [
              axis.map((value) => value * (distances[i] - 0.4)),
              axis.map((value) => value * (distances[i] + 0.3)),
            ]);
            const program =
              clusteredSampling(0, true) +
              `\n@group(0) @binding(19) var<storage,read_write> localVisibility:array<f32>;
            @compute @workgroup_size(1) fn sampleVisibility(@builtin(global_invocation_id) id:vec3u){
              let positions=array<vec3f,12>(${samples.map((position) => 'vec3f(' + position.join(',') + ')').join(',')});
              let light=clusterLights[0];
              localVisibility[id.x]=clusterShadowVisibility(light,positions[id.x],vec3f(0));
            }`;
            const module = device.createShaderModule({ code: program }),
              pipeline = device.createComputePipeline({
                layout: 'auto',
                compute: { module, entryPoint: 'sampleVisibility' },
              });
            const group = device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                ...clustered.bindings().filter((entry) => entry.binding === 5 || entry.binding >= 28),
                { binding: 19, resource: { buffer: output } },
              ],
            });
            const encoder = device.createCommandEncoder(),
              pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(12);
            pass.end();
            encoder.copyBufferToBuffer(output, 0, visibilityRead, 0, 48);
            device.queue.submit([encoder.finish()]);
            await visibilityRead.mapAsync(GPUMapMode.READ);
            const values = [...new Float32Array(visibilityRead.getMappedRange())];
            visibilityRead.unmap();
            assert(
              values.every((value, i) => value === (i % 2 === 0 ? 1 : 0)),
              'Point shadow sampling selected the wrong cube face: ' + JSON.stringify(values),
            );
            report.pointFaceVisibility = values;
          } finally {
            output.destroy();
            visibilityRead.destroy();
          }
        } finally {
          read.destroy();
          for (const remove of faceRemovers) remove();
          for (const mesh of faceBoxes) mesh.dispose();
        }
        // Normal bias can move a diagonal receiver across a cube-face boundary.
        // Query the real sampler, then deliberately restore the old face choice
        // against the same maps to prove this fixture detects the fully lit seam.
        const diagonal = instance.createMesh().setGeometry(geometry).setScale([0.7, 0.7, 0.7]).setPosition([2, 0, 2]),
          removeDiagonal = clustered.addShadowCaster(diagonal);
        try {
          clustered.setLights([
            { position: [0, 0, 0], range: 8, intensity: 1, shadow: { near: 0.15, bias: 0, normalBias: 0.02 } },
          ]);
          await render('point:normal-bias-seam');
          const query = async (legacy) => {
            const device = engine.gpu,
              output = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
              readback = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            try {
              let source = clusteredSampling(0, true);
              if (legacy) {
                const before = source;
                source = source.replace(
                  'clusterShadowFace(receiver-light.positionRange.xyz)',
                  'clusterShadowFace(position-light.positionRange.xyz)',
                );
                assert(source !== before, 'Seam regression must replace the current point-face selection');
              }
              const module = device.createShaderModule({
                  code:
                    source +
                    `\n@group(0) @binding(19) var<storage,read_write> seamVisibility:array<f32>;
              @compute @workgroup_size(1) fn sampleSeam(){
                let light=clusterLights[0];
                seamVisibility[0]=clusterShadowVisibility(light,vec3f(1,0,1),vec3f(0,0,1));
                seamVisibility[1]=clusterShadowVisibility(light,vec3f(4,0,4),vec3f(0,0,1));
              }`,
                }),
                pipeline = device.createComputePipeline({
                  layout: 'auto',
                  compute: { module, entryPoint: 'sampleSeam' },
                });
              const group = device.createBindGroup({
                  layout: pipeline.getBindGroupLayout(0),
                  entries: [
                    ...clustered.bindings().filter((entry) => entry.binding === 5 || entry.binding >= 28),
                    { binding: 19, resource: { buffer: output } },
                  ],
                }),
                encoder = device.createCommandEncoder(),
                pass = encoder.beginComputePass();
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, group);
              pass.dispatchWorkgroups(1);
              pass.end();
              encoder.copyBufferToBuffer(output, 0, readback, 0, 8);
              device.queue.submit([encoder.finish()]);
              await readback.mapAsync(GPUMapMode.READ);
              const result = [...new Float32Array(readback.getMappedRange())];
              readback.unmap();
              return result;
            } finally {
              output.destroy();
              readback.destroy();
            }
          };
          const actual = await query(false),
            legacy = await query(true);
          assert(
            actual[0] === 1 && actual[1] === 0,
            'Normal-biased point shadow leaked light at the cube seam: ' + JSON.stringify(actual),
          );
          assert(
            legacy[0] === 1 && legacy[1] === 1,
            'The previous point-face selection unexpectedly passed the seam regression: ' + JSON.stringify(legacy),
          );
          report.normalBiasSeam = { actual, legacy };
        } finally {
          removeDiagonal();
          diagonal.dispose();
        }
        // The alpha caster uses UV1 and a nontrivial affine transform. Its shadow
        // must match independent CPU-baked UVs for both local-light projections.
        surface(true);
        const imageCanvas = document.createElement('canvas');
        imageCanvas.width = imageCanvas.height = 4;
        const pixels = new Uint8ClampedArray(64);
        for (let i = 0; i < 16; i++)
          pixels.set([255, 255, 255, i % 4 === 1 || Math.floor(i / 4) === 2 ? 255 : 0], i * 4);
        imageCanvas.getContext('2d').putImageData(new ImageData(pixels, 4, 4), 0, 0);
        const loadAlpha = async (fixture) =>
          parseGLTF(
            instance,
            structuredClone(fixture.doc),
            fixture.buffers.map((buffer) => new Uint8Array(buffer)),
            [await createImageBitmap(imageCanvas)],
          );
        const alphaActual = await loadAlpha(payload.actual),
          alphaReference = await loadAlpha(payload.reference);
        alphaReference.root.visible = false;
        const alphaResults = [];
        try {
          for (const [kind, light] of [
            ['point', point],
            ['spot', spot],
          ]) {
            let remove = clustered.addShadowCaster(alphaActual);
            const actual = await lit(light, true, `alpha:${kind}:actual`);
            remove();
            alphaActual.root.visible = false;
            alphaReference.root.visible = true;
            remove = clustered.addShadowCaster(alphaReference);
            const reference = await lit(light, true, `alpha:${kind}:baked`);
            remove();
            const delta = difference(actual, reference);
            assert(delta.max <= 1, `Local ${kind} alpha mask differs from CPU-baked UV1: ${JSON.stringify(delta)}`);
            const noCaster = await lit(light, true, `alpha:${kind}:none`);
            assert(difference(reference, noCaster).pixels > 20, `Local ${kind} ignored the alpha caster`);
            alphaResults.push({ kind, ...delta });
            alphaReference.root.visible = false;
            alphaActual.root.visible = true;
          }
        } finally {
          alphaActual.destroy();
          alphaReference.destroy();
        }
        report.alphaUV1 = alphaResults;
        // Registration order must not change either independent light's visibility.
        blocker.visible = true;
        removeBlocker = clustered.addShadowCaster(blocker);
        engine.lighting.direction[3] = 1.5;
        engine.lighting.radiance[3] = 0.05;
        const composition = [];
        for (const order of ['clustered-first', 'directional-first']) {
          if (order === 'directional-first') {
            removeBlocker();
            clustered.dispose();
          }
          directional = Shadows.attach(instance, {
            resolution: 128,
            distance: 25,
            bias: 0.0005,
            normalBias: 0.015,
            lightSize: 0,
            casterMargin: 20,
          });
          directional.add(blocker);
          directional.add(pbrFloor);
          if (order === 'directional-first') {
            clustered = Clustered.attach(instance, { grid: [4, 4, 8], shadows: { resolution: 128, maxLights: 4 } });
            clustered.add(pbrFloor);
            removeBlocker = clustered.addShadowCaster(blocker);
          }
          const on = await lit(point, true, `composition:${order}:on`),
            off = await lit(point, false, `composition:${order}:off`),
            delta = difference(on, off);
          assert(delta.pixels > 50, 'Directional shadows suppressed local shadow contribution');
          composition.push({ order, on, off, delta });
          directional.dispose();
          directional = undefined;
        }
        report.composition = {
          localDifference: composition.map(({ order, delta }) => ({ order, ...delta })),
          registrationParity: exact(
            composition[0].on,
            composition[1].on,
            'Light registration order changed shadowed pixels',
          ),
        };
        // Static PBR geometry uses camera velocity; add() is for deforming or
        // moving sources with storage-enabled vertex buffers.
        const taa = TAA.attach(instance, { historyWeight: 0 }),
          temporal = [];
        try {
          for (const pbr of [false, true]) {
            surface(pbr);
            const off = await lit(point, false, `taa:${pbr ? 'pbr' : 'core'}:off`),
              on = await lit(point, true, `taa:${pbr ? 'pbr' : 'core'}:on`),
              delta = difference(off, on);
            assert(delta.pixels > 70, 'TAA composition lost local light shadows');
            temporal.push({ surface: pbr ? 'pbr' : 'core', ...delta });
          }
        } finally {
          taa.dispose();
        }
        report.taa = temporal;
        surface(true);
        // Removing the final caster clears all old depth data, even if the light
        // remains shadow enabled. Then restore the complete engine/device graph.
        engine.lighting.direction[3] = 0;
        engine.lighting.radiance[3] = 0;
        removeBlocker();
        const empty = await lit(point, true, 'empty-casters:on'),
          disabled = await lit(point, false, 'empty-casters:off');
        report.emptyCasterParity = exact(empty, disabled, 'Removing a caster retained stale local shadows');
        removeBlocker = clustered.addShadowCaster(blocker);
        const before = await lit(point, true, 'restore:before');
        const oldDevice = engine.gpu,
          oldRecords = resources.slice();
        await instance.rebootDevice();
        assert(engine.gpu !== oldDevice, 'Engine did not replace its GPU device');
        track(engine.gpu);
        const after = await lit(point, true, 'restore:after');
        report.restoration = exact(before, after, 'Device restoration changed point light shadow pixels');
        assert(
          oldRecords.every((record) => record.destroyed),
          'Device restoration retained an old GPU buffer or texture',
        );
        const errors = (await Promise.all(modules.map((module) => module.getCompilationInfo()))).flatMap((info) =>
          info.messages.filter((message) => message.type === 'error').map((message) => message.message),
        );
        assert(errors.length === 0, errors.join('\n'));
        assert(validation.length === 0, validation.join('\n'));
        report.shaderModules = modules.length;
        report.captures = captured.length;
        report.labels = captured;
        report.compilationErrors = errors;
        report.validationErrors = validation;
        pbrFloor.destroy();
        clustered.dispose();
        instance.dispose();
        assert(
          resources.every((record) => record.destroyed),
          'Local shadow regression leaked a GPU buffer or texture',
        );
        report.resourcesDestroyed = resources.length;
        return report;
      } catch (error) {
        throw new Error(captured.at(-1) + ': ' + error.message + '\n' + validation.join('\n'));
      } finally {
        directional?.dispose();
        clustered?.dispose();
        if (!pbrFloor.disposed) pbrFloor.destroy();
        if (!instance.disposed) instance.dispose();
        canvas.remove();
      }
    },
    { floor: serialize(floor), actual: serialize(actual), reference: serialize(reference) },
  );
}

export async function runLocalShadowBrowserTests() {
  await mkdir('test-results', { recursive: true });
  const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5206 }),
    errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
      errors.push(message.text());
  });
  try {
    const result = await localShadowBrowserChecks(browser.page);
    assert.deepEqual(errors, []);
    const report = { hardware: browser.hardware, ...result, errors };
    await writeFile('test-results/local-shadows-webgpu.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runLocalShadowBrowserTests();
