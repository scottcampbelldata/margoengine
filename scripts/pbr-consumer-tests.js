import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

/** Real loader handles, native contact-shadow pixels, and captured GPU draw ownership. */
export async function pbrConsumerBrowserChecks(page) {
  return page.evaluate(async () => {
    const { EngineKernel, PbrMaterial, box } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { loadFBX } = await import('/packages/fbx/dist/index.js');
    const { ContactShadows } = await import('/packages/staging/dist/index.js');
    const { FrameDebugger } = await import('/packages/inspector/dist/frame.js');
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const fixtures = [
        { name: 'gltf-pro', path: '/packages/exporters/tests/fixtures/Box.glb', load: loadGLTF },
        { name: 'FBX', path: '/packages/fbx/test/fixtures/blender-rig.fbx', load: loadFBX },
      ],
      results = [];
    for (const fixture of fixtures) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:320px';
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          capacity: 64,
          camera: { position: [0, 3, 5], target: [0, 0, 0], near: 0.01, far: 100 },
        }),
        engine = engineRuntime(instance),
        device = engine.gpu,
        shaders = [],
        errors = [];
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const createShaderModule = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const shader = createShaderModule(descriptor);
        shaders.push(shader);
        return shader;
      };
      device.pushErrorScope('validation');
      let model;
      const capture = async () => {
        const context = canvas.getContext('webgpu'),
          format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const getCurrentTexture = context.getCurrentTexture.bind(context);
        let texture, staging;
        context.getCurrentTexture = () => (texture = getCurrentTexture());
        try {
          instance.render({ culling: false });
          const bytesPerRow = Math.ceil((texture.width * 4) / 256) * 256;
          staging = device.createBuffer({
            size: bytesPerRow * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, [texture.width, texture.height]);
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);
          const mapped = new Uint8Array(staging.getMappedRange()),
            pixels = new Uint8Array(texture.width * texture.height * 4);
          for (let y = 0; y < texture.height; y++)
            pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + texture.width * 4), y * texture.width * 4);
          staging.unmap();
          await device.queue.onSubmittedWorkDone();
          return pixels;
        } finally {
          context.getCurrentTexture = getCurrentTexture;
          staging?.destroy();
        }
      };
      try {
        model = await fixture.load(instance, fixture.path);
        check(model.primitives.length === 1, `${fixture.name}: fixture primitive count changed`);
        const mesh = model.primitives[0].node,
          bounds = model.bounds,
          size = Math.max(bounds[3] - bounds[0], bounds[5] - bounds[2]),
          ground = bounds[1],
          center = [(bounds[0] + bounds[3]) / 2, ground, (bounds[2] + bounds[5]) / 2];
        check(
          mesh.geometry === null && model.shadowPrimitives[0].vertex instanceof GPUBuffer,
          `${fixture.name}: loader must supply native PBR buffers without core Geometry`,
        );
        instance
          .createMesh()
          .setGeometry(box(size * 4, 0.05, size * 4))
          .setMaterial(new PbrMaterial({ color: '#d0d0d0', roughness: 0.9 }))
          .setPosition([center[0], ground - 0.025, center[2]]);
        engine.camera.fitToBoundingBox([...bounds.subarray(0, 3)], [...bounds.subarray(3)], {
          duration: 0,
          padding: 1.8,
        });
        const contact = ContactShadows.attach(instance, { blur: size * 0.08, opacity: 0, resolution: 256 }).fit(
          bounds,
          2,
        );
        contact.add(mesh);
        const off = await capture();
        contact.options.opacity = 0.8;
        const on = await capture();
        let darkenedPixels = 0,
          strongestDarkening = 0,
          totalDarkening = 0;
        for (let i = 0; i < off.length; i += 4) {
          const darkening = off[i] + off[i + 1] + off[i + 2] - on[i] - on[i + 1] - on[i + 2];
          if (darkening > 12) {
            darkenedPixels++;
            totalDarkening += darkening;
          }
          strongestDarkening = Math.max(strongestDarkening, darkening);
        }
        check(
          darkenedPixels > 20 && strongestDarkening > 30,
          `${fixture.name}: no visible PBR contact shadow (${darkenedPixels} pixels, peak ${strongestDarkening})`,
        );
        const debug = FrameDebugger.attach(instance, { parent: null }),
          report = await debug.capture({ render: true }),
          commands = (owner) =>
            report.graph
              .filter((entry) => entry.owner === owner)
              .flatMap((entry) => entry.passes.flatMap((pass) => pass.commands))
              .filter((command) => command.kind === 'drawIndexed'),
          contacts = commands(contact.name),
          beauty = commands(model.name);
        check(
          contacts.length === 1 && beauty.length === 1,
          `${fixture.name}: expected one contact and one beauty indexed draw`,
        );
        for (const command of [...contacts, ...beauty])
          check(
            command.entities.length === 1 && command.entities[0] === mesh.id,
            `${fixture.name}: captured PBR draw has incorrect owners ${JSON.stringify(command.entities)}`,
          );
        check(mesh.geometry === null, `${fixture.name}: consumers attached a core Geometry`);
        await device.queue.onSubmittedWorkDone();
        const validation = await device.popErrorScope(),
          compilation = (await Promise.all(shaders.map((shader) => shader.getCompilationInfo()))).flatMap((info) =>
            info.messages.filter((message) => message.type === 'error').map((message) => message.message),
          );
        check(
          !validation && errors.length === 0 && compilation.length === 0,
          `${fixture.name}: ${[validation?.message, ...errors, ...compilation].filter(Boolean).join('\n')}`,
        );
        results.push({
          source: fixture.name,
          fixture: fixture.path,
          coreGeometry: null,
          nativeVertexBuffer: true,
          darkenedPixels,
          strongestDarkening,
          totalDarkening,
          contactDrawEntities: contacts.map((command) => command.entities),
          beautyDrawEntities: beauty.map((command) => command.entities),
          shaderModules: shaders.length,
          compilationErrors: compilation,
          validationErrors: errors,
        });
      } finally {
        model?.destroy();
        instance.dispose();
        canvas.remove();
      }
    }
    return results;
  });
}

export async function runPBRConsumerTests() {
  await mkdir('test-results', { recursive: true });
  const release = await acquire({ owner: 'pbr-consumer-tests' });
  let browser;
  try {
    browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5224 });
    assert.ok(browser.hardware.webgpu, 'WebGPU adapter unavailable');
    assert.notEqual(browser.hardware.webgpu.fallback, true, 'A native hardware adapter is required');
    assert.doesNotMatch(browser.hardware.webglRenderer ?? '', /swiftshader|llvmpipe|software/i);
    const errors = [];
    browser.page.on('pageerror', (error) => errors.push(error.message));
    browser.page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const checks = await pbrConsumerBrowserChecks(browser.page);
    assert.deepEqual(errors, []);
    const result = { recordedAt: new Date().toISOString(), hardware: browser.hardware, checks, errors };
    await writeFile('test-results/pbr-consumers-webgpu.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runPBRConsumerTests();
