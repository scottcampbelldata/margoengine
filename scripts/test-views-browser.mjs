// The real-GPU multi-view check: views and scenes in core, then the view-aware packages, at 1x and 4x MSAA where it
// matters. Each section draws views and checks pixels, picks and validation errors. The lead runs it under the GPU lock:
//   npm run check:views
// Sections: scenes (separate scenes, picking, resize, device restore), postfx (four views equal one view with Tonemap,
// DOF, PostStack and zero-density fog), temporal (TAA, motion blur and volumetric fog keep separate histories and
// depth), water (a later view keeps the earlier view's pixels, also after resize and device restore), preview (an item
// preview drawn at 4x into a caller's 1x colour and depth matches 1x, with antialiased edges), demos (the three
// multi-view demos: picks through each view, layers kept out of a view, frame time).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const release = await acquire({ owner: 'views-browser' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5293 });
  const { page, hardware } = browser,
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const scenes = await page.evaluate(async () => {
    const { EngineKernel, box } = await import('/packages/core/dist/index.js');
    const { Camera, engineRuntime } = await import('/packages/core/dist/extension.js');
    const reports = [];
    for (const samples of [1, 4]) {
      if (samples === 1) globalThis.margoLow = 1;
      else delete globalThis.margoLow;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:128px;height:96px';
      canvas.width = 128;
      canvas.height = 96;
      document.body.append(canvas);
      const options = { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 };
      const instance = await EngineKernel.create(canvas, { backend: 'webgpu', camera: options });
      const engine = engineRuntime(instance),
        hud = engine.createScene('hud'),
        other = new Camera(options),
        errors = [];
      const a = engine.createMesh().setGeometry(box()),
        b = hud.createMesh().setGeometry(box());
      a.material.set({ color: '#ff0000' });
      b.material.set({ color: '#0000ff' });
      engine.scene.background = '#440000';
      hud.background = '#000044';
      let target, device;
      // Canvas format may be BGRA; returned bytes are in the native texture order.
      const bgra = navigator.gpu.getPreferredCanvasFormat().startsWith('bgra');
      const read = async () => {
        const row = Math.ceil((canvas.width * 4) / 256) * 256;
        const buffer = device.createBuffer({
          size: row * canvas.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
          const command = device.createCommandEncoder();
          command.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: row }, [canvas.width, canvas.height]);
          device.queue.submit([command.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const bytes = new Uint8Array(buffer.getMappedRange());
          const pixel = (x, y) => {
            const offset = Math.floor(y) * row + Math.floor(x) * 4;
            return Array.from(bytes.subarray(offset, offset + 3));
          };
          // Pixels of each view's half that are not its colour (object or background): 0 when both clears drew.
          const split = Math.round(canvas.width / 2),
            wrong = [0, 0];
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++) {
              const [first, , third] = pixel(x, y),
                [r, b] = bgra ? [third, first] : [first, third];
              if (x < split ? !(r > b + 20) : !(b > r + 20)) wrong[+(x >= split)]++;
            }
          return {
            left: pixel(canvas.width / 4, canvas.height / 2),
            right: pixel((3 * canvas.width) / 4, canvas.height / 2),
            leftGround: pixel(2, 2),
            rightGround: pixel(canvas.width - 3, 2),
            wrong,
          };
        } finally {
          buffer.destroy();
        }
      };
      const frame = async () => {
        target?.destroy();
        device = engine.gpu;
        device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        target = device.createTexture({
          size: [canvas.width, canvas.height],
          format: navigator.gpu.getPreferredCanvasFormat(),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const views = [
          { camera: engine.camera, viewport: [0, 0, 0.5, 1], target: { color: target } },
          { camera: other, viewport: [0.5, 0, 0.5, 1], target: { color: target }, scene: hud },
        ];
        device.pushErrorScope('validation');
        instance.render({ culling: false, delta: 0.1, views });
        const pixels = await read();
        instance.render({ culling: false, views: views.map(({ target: _target, ...view }) => view) });
        const pickedLeft = await instance.pick(canvas.clientWidth / 4, canvas.clientHeight / 2);
        const pickedRight = await instance.pick((3 * canvas.clientWidth) / 4, canvas.clientHeight / 2);
        const masked = await instance.pick((3 * canvas.clientWidth) / 4, canvas.clientHeight / 2, {
          ...views[1],
          layers: 0,
        });
        const validation = await device.popErrorScope();
        if (validation) throw new Error(validation.message);
        const red = (p) => p[0] > p[2] + 20,
          blue = (p) => p[2] > p[0] + 20;
        for (const [key, p] of Object.entries(pixels)) if (bgra && key !== 'wrong') p.reverse();
        // Each partial view clears by a draw (bug 61: at 4x on Intel Arc a blend-constant clear left both black).
        if (
          !red(pixels.left) ||
          !blue(pixels.right) ||
          !red(pixels.leftGround) ||
          !blue(pixels.rightGround) ||
          pixels.wrong.some(Boolean)
        )
          throw new Error(`scene pixels mixed at ${samples}x: ` + JSON.stringify(pixels));
        if (pickedLeft !== a || pickedRight !== b || masked !== null) throw new Error('wrong scene pick');
        if (engine.lighting !== engine.scene.lighting || engine.frameGraph !== engine.scene.frameGraph)
          throw new Error('scene aliases leaked');
        return { pixels, leftPick: pickedLeft.id, rightPick: pickedRight.id, zeroMask: masked };
      };
      try {
        const initial = await frame();
        canvas.style.width = '321px';
        canvas.style.height = '101px';
        // Picking must resolve the last fractional views at the new dimensions,
        // even when no frame has been drawn since the CSS resize.
        const beforeDrawLeft = await instance.pick(canvas.clientWidth / 4, canvas.clientHeight / 2);
        const beforeDrawRight = await instance.pick((3 * canvas.clientWidth) / 4, canvas.clientHeight / 2);
        if (beforeDrawLeft !== a || beforeDrawRight !== b) throw new Error('stale view rectangles after resize');
        const resized = await frame();
        const previous = engine.gpu;
        previous.destroy();
        await previous.lost;
        await engine.rebootDevice();
        const restored = await frame();
        if (errors.length) throw new Error(errors.join('\n'));
        reports.push({
          samples,
          initial,
          resized,
          restored,
          resizeBeforeDraw: true,
          oddSize: [canvas.width, canvas.height],
          deviceReplaced: previous !== engine.gpu,
          errors,
        });
      } finally {
        target?.destroy();
        instance.dispose();
        canvas.remove();
      }
    }
    return reports;
  });

  const postfx = [];
  const shot = async (mode, multi) => {
    const state = await page.evaluate(
      async ({ mode, multi }) => {
        window.postfxViewInstance?.dispose();
        document.querySelector('#postfx-view-fixture')?.remove();
        const { EngineKernel } = await import('/packages/core/dist/index.js');
        const { box, engineRuntime } = await import('/packages/core/dist/extension.js');
        const { DOF } = await import('/packages/dof/dist/index.js');
        const { Tonemap } = await import('/packages/tonemap/dist/index.js');
        const { PostStack } = await import('/packages/post/dist/index.js');
        const { VolumetricFog } = await import('/packages/environment/dist/volumetric.js');
        const canvas = document.createElement('canvas');
        canvas.id = 'postfx-view-fixture';
        canvas.width = 128;
        canvas.height = 96;
        canvas.style.cssText = 'width:128px;height:96px';
        document.body.append(canvas);
        const instance = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          capacity: 8,
          camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
        });
        window.postfxViewInstance = instance;
        const engine = engineRuntime(instance),
          device = engine.gpu,
          uncaptured = [];
        device.addEventListener('uncapturederror', (e) => uncaptured.push(e.error.message));
        device.pushErrorScope('validation');
        instance.createMesh().setGeometry(box()).setScale([0.9, 0.9, 0.1]);
        const lens = { enabled: mode === 'dof-focused', focalDistance: 6, focalLength: 0.8, aperture: 0.5 };
        if (mode.startsWith('tonemap')) Tonemap.attach(instance);
        if (mode.startsWith('dof')) DOF.attach(instance, lens);
        if (mode === 'stack') PostStack.attach(instance, [new DOF({ enabled: false }), new Tonemap()]);
        if (mode === 'tonemap-fog-zero') VolumetricFog.attach(instance, { density: 0, grid: [8, 8, 8] });
        const views = multi
          ? [
              [0, 0, 64, 48],
              [64, 0, 64, 48],
              [0, 48, 64, 48],
              [64, 48, 64, 48],
            ].map((viewport, i) => ({ id: String(i), camera: instance.camera, pixels: true, viewport }))
          : undefined;
        instance.render({ culling: false, ...(views ? { views } : {}) });
        await device.queue.onSubmittedWorkDone();
        const validation = await device.popErrorScope();
        if (validation) throw new Error(validation.message);
        if (uncaptured.length) throw new Error(uncaptured.join('\n'));
        return { mode, multi, validation: null, uncaptured };
      },
      { mode, multi },
    );
    const image = await decodePNG(
      await page
        .locator('#postfx-view-fixture')
        .screenshot({ path: `test-results/postfx-view-${mode}-${multi ? 'four' : 'single'}.png` }),
    );
    return { ...state, image };
  };
  for (const multi of [false, true]) {
    const baseline = await shot('none', multi);
    const graded = await shot('tonemap', multi);
    const centers = multi
      ? [
          [32, 24],
          [96, 24],
          [32, 72],
          [96, 72],
        ]
      : [[64, 48]];
    for (const [x, y] of centers) {
      const i = (y * baseline.image.width + x) * 4;
      assert.ok(Math.max(...baseline.image.data.subarray(i, i + 3)) > 50, 'reference object is visible');
    }
    for (const mode of ['tonemap', 'dof-sharp', 'dof-focused', 'stack', 'tonemap-fog-zero']) {
      const actual = mode === 'tonemap' ? graded : await shot(mode, multi);
      const reference = mode === 'tonemap' ? baseline.image : graded.image;
      let maximum = 0,
        sum = 0,
        changed = 0;
      for (let i = 0; i < actual.image.data.length; i++) {
        if (i % 4 === 3) continue;
        const pixel = i - (i % 4);
        const x = (pixel / 4) % 128,
          y = Math.floor(pixel / 4 / 128);
        if (mode === 'dof-focused' && !centers.some(([cx, cy]) => Math.abs(cx - x) <= 1 && Math.abs(cy - y) <= 1))
          continue;
        // Core's default clear is display encoded; an HDR capture grades that background separately.
        // Compare core-to-neutral only where actual geometry covers the pixel, and fog/effects across the whole image.
        if (mode === 'tonemap' && Math.max(...reference.data.subarray(pixel, pixel + 3)) < 80) continue;
        const delta = Math.abs(actual.image.data[i] - reference.data[i]);
        maximum = Math.max(maximum, delta);
        sum += delta;
        if (delta > 3) changed++;
      }
      // The focused lens preserves the front-face centers; its defocused background and silhouettes may change.
      assert.ok(
        maximum <= 3,
        `${mode}/${multi ? 'four' : 'single'} differs from the visible reference by ${maximum} (${changed} channels)`,
      );
      postfx.push({
        mode,
        views: multi ? 4 : 1,
        maximumChannelDifference: maximum,
        meanChannelDifference: sum / (128 * 96 * 3),
        validation: actual.validation,
      });
    }
  }

  const temporal = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { box, engineRuntime } = await import('/packages/core/dist/extension.js');
    const { TAA } = await import('/packages/taa/dist/index.js');
    const { PostStack, MotionBlur, FXAA } = await import('/packages/post/dist/index.js');
    const { VolumetricFog } = await import('/packages/environment/dist/volumetric.js');
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 96;
    canvas.style.cssText = 'width:128px;height:96px';
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    const engine = engineRuntime(instance),
      device = engine.gpu,
      uncaptured = [];
    device.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
    device.pushErrorScope('validation');
    // Give the renderer's depth attachment readback visibility without changing its contents or sampling.
    const owners = new WeakMap(),
      createTexture = device.createTexture.bind(device);
    device.createTexture = (descriptor) => {
      const texture = createTexture(
        descriptor.format.startsWith('depth')
          ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.TEXTURE_BINDING }
          : descriptor,
      );
      const createView = texture.createView.bind(texture);
      texture.createView = (...args) => {
        const view = createView(...args);
        owners.set(view, texture);
        return view;
      };
      return texture;
    };
    const width = canvas.width,
      height = canvas.height;
    instance.createMesh().setGeometry(box()).setScale([10, 10, 0.1]);
    let stack;
    const taa = TAA.attach(instance, { depth: () => stack?.depthTexture });
    const blur = new MotionBlur({ velocity: () => taa.velocity });
    stack = PostStack.attach(instance, [blur, new FXAA()]);
    const fog = VolumetricFog.attach(instance, { grid: [8, 8, 8], density: 0.02, ambient: [0.1, 0.1, 0.1] });
    const views = [
      { id: 'left', camera: instance.camera, pixels: true, viewport: [0, 0, width / 2, height] },
      { id: 'right', camera: instance.camera, pixels: true, viewport: [width / 2, 0, width / 2, height] },
    ];
    const failures = [],
      observed = new Map(),
      frames = [];
    const preserved = device.createTexture({
      size: [width, height],
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const pipelines = new Map();
    const remove = engine.frameGraph.add({
      name: 'temporal-views:read-depth',
      order: 50,
      execute(c) {
        const samples = c.descriptor.multisample?.count ?? 1;
        let pipeline = pipelines.get(samples);
        if (!pipeline) {
          const module = device.createShaderModule({
            code: `@group(0) @binding(0) var depth:${samples === 4 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@group(0) @binding(1) var output:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=textureDimensions(output))){return;}textureStore(output,vec2i(id.xy),vec4f(textureLoad(depth,vec2i(id.xy),0)));}`,
          });
          pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
          pipelines.set(samples, pipeline);
        }
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: owners.get(c.depth).createView({ aspect: 'depth-only' }) },
            { binding: 1, resource: preserved.createView() },
          ],
        });
        const pass = c.encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        observed.set(c.view.id, {
          velocity: taa.velocity.texture,
          history: taa.velocity.resolved,
          jitter: [...taa.velocity.jitter],
          volume: fog.texture,
        });
      },
    });
    const read = async (texture, x, y, channels, half = false) => {
      const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const raw = buffer.getMappedRange();
        if (!half) return [...new Float32Array(raw, 0, channels)];
        return [...new Uint16Array(raw, 0, channels)].map((n) => {
          const s = n & 32768 ? -1 : 1,
            e = (n >> 10) & 31,
            f = n & 1023;
          return s * (e ? 2 ** (e - 15) * (1 + f / 1024) : (2 ** -14 * f) / 1024);
        });
      } finally {
        buffer.unmap();
        buffer.destroy();
      }
    };
    try {
      for (let frame = 0; frame < 3; frame++) {
        instance.render({ views, culling: false });
        await device.queue.onSubmittedWorkDone();
        const left = observed.get('left'),
          right = observed.get('right');
        if (left.history === right.history || left.volume === right.volume)
          throw new Error('View histories or froxels were shared');
        const row = { frame, views: [], depth: [] };
        for (const [id, x] of [
          ['left', width / 4],
          ['right', (3 * width) / 4],
        ]) {
          const view = observed.get(id),
            velocity = await read(view.velocity, x, height / 2, 2, true);
          for (let i = 0; i < 2; i++)
            if (Math.abs(velocity[i] - view.jitter[i]) > 0.001)
              failures.push(`${id} stationary velocity ${velocity} disagrees with jitter ${view.jitter}`);
          row.views.push({ id, velocity, jitter: view.jitter });
          const depth = (await read(preserved, x, height / 2, 1))[0];
          if (!(depth > 0)) failures.push(`${id} depth was erased by the next view: ${depth}`);
          row.depth.push(depth);
        }
        frames.push(row);
      }
      taa.reset();
      instance.render({ views, culling: false });
      for (const [id, view] of observed)
        if (view.jitter.some((n) => n !== 0)) throw new Error(`${id} reset retained jitter history`);
      await device.queue.onSubmittedWorkDone();
      const validation = await device.popErrorScope();
      if (validation) throw new Error(validation.message);
      if (uncaptured.length) throw new Error(uncaptured.join('\n'));
      if (failures.length) throw new Error(failures.join('\n'));
      return { width, height, frames, validation: null, uncaptured };
    } finally {
      remove();
      preserved.destroy();
      instance.dispose();
    }
  });

  const water = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Camera, engineRuntime } = await import('/packages/core/dist/extension.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const reports = [];
    for (const samples of [1, 4]) {
      if (samples === 1) globalThis.margoLow = 1;
      else delete globalThis.margoLow;
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 96;
      canvas.style.cssText = 'width:128px;height:96px';
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 4,
        camera: { position: [0, 3, 7], target: [0, 0, 0], near: 0.1, far: 100 },
      });
      const engine = engineRuntime(instance),
        other = new Camera({ position: [6, 4, 0], target: [0, 0, 0], near: 0.1, far: 100 });
      let device,
        width = 0,
        height = 0,
        color,
        resolve,
        depth,
        buffers,
        owned = [],
        suppress = false;
      const errors = [];
      const removePrepare = engine.frameGraph.add({
        name: 'water-views:target',
        order: -150,
        execute(c) {
          if (device !== c.device || width !== c.width || height !== c.height) {
            for (const resource of owned) resource.destroy();
            owned = [];
            device = c.device;
            width = c.width;
            height = c.height;
            device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
            const texture = (descriptor) => {
              const t = device.createTexture(descriptor);
              owned.push(t);
              return t;
            };
            color = texture({
              size: [width, height],
              format: c.format,
              sampleCount: samples,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.COPY_SRC : 0),
            });
            resolve =
              samples === 4
                ? texture({
                    size: [width, height],
                    format: c.format,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                  })
                : color;
            depth = texture({
              size: [width, height],
              format: 'depth32float',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            buffers = {};
            for (const key of ['left', 'right']) {
              const b = device.createBuffer({
                size: Math.ceil((width * 4) / 256) * 256 * height,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              });
              owned.push(b);
              buffers[key] = b;
            }
            c.encoder
              .beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: {
                  view: depth.createView(),
                  depthLoadOp: 'clear',
                  depthClearValue: 0,
                  depthStoreOp: 'store',
                },
              })
              .end();
          }
          c.color = color.createView();
          if (suppress) {
            const begin = c.encoder.beginRenderPass.bind(c.encoder);
            c.encoder.beginRenderPass = (descriptor) => {
              const pass = begin(descriptor);
              if (descriptor.colorAttachments?.length !== 2) return pass;
              return new Proxy(pass, {
                get(target, key) {
                  if (key === 'setViewport' || key === 'setScissorRect') return () => {};
                  const value = target[key];
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
            };
          }
        },
      });
      Water.attach(instance, { segments: 16, size: [30, 30], depth: () => depth });
      const removeRead = engine.frameGraph.add({
        name: 'water-views:read',
        order: 50,
        execute(c) {
          if (samples === 4)
            c.encoder
              .beginRenderPass({
                colorAttachments: [
                  { view: c.color, resolveTarget: resolve.createView(), loadOp: 'load', storeOp: 'store' },
                ],
              })
              .end();
          c.encoder.copyTextureToBuffer(
            { texture: resolve },
            { buffer: buffers[c.view.id], bytesPerRow: Math.ceil((width * 4) / 256) * 256 },
            [width, height],
          );
        },
      });
      const frame = async (control = false) => {
        suppress = control;
        engine.gpu.pushErrorScope('validation');
        instance.render({
          culling: false,
          views: [
            {
              id: 'left',
              camera: instance.camera,
              pixels: true,
              viewport: [0, 0, canvas.width / 2, canvas.height],
              clear: { color: '#cc2200' },
            },
            {
              id: 'right',
              camera: other,
              pixels: true,
              viewport: [canvas.width / 2, 0, canvas.width / 2, canvas.height],
              clear: { color: '#0022cc' },
            },
          ],
        });
        await engine.gpu.queue.onSubmittedWorkDone();
        const validation = await engine.gpu.popErrorScope();
        if (validation) throw new Error(validation.message);
        const data = {};
        for (const key of ['left', 'right']) {
          await buffers[key].mapAsync(GPUMapMode.READ);
          data[key] = new Uint8Array(buffers[key].getMappedRange().slice(0));
          buffers[key].unmap();
        }
        let changedLeft = 0,
          changedRight = 0;
        const row = Math.ceil((width * 4) / 256) * 256;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const i = y * row + x * 4;
            let changed = false;
            for (let c = 0; c < 3; c++) if (data.left[i + c] !== data.right[i + c]) changed = true;
            if (changed) {
              if (x < width / 2) changedLeft++;
              else changedRight++;
            }
          }
        return { width, height, changedLeft, changedRight };
      };
      try {
        const control = await frame(true);
        if (control.changedLeft === 0) throw new Error('missing-viewport control did not exercise the earlier view');
        const initial = await frame();
        if (initial.changedLeft || !initial.changedRight)
          throw new Error('second view overwrote earlier view ' + JSON.stringify(initial));
        canvas.width = 160;
        canvas.style.width = '160px';
        const resized = await frame();
        if (resized.changedLeft || !resized.changedRight) throw new Error('resized second view overwrote earlier view');
        const previous = engine.gpu;
        previous.destroy();
        await previous.lost;
        await engine.rebootDevice();
        const restored = await frame();
        if (restored.changedLeft || !restored.changedRight)
          throw new Error('restored second view overwrote earlier view');
        if (errors.length) throw new Error(errors.join('\n'));
        reports.push({ samples, control, initial, resized, restored, deviceReplaced: engine.gpu !== previous, errors });
      } finally {
        removePrepare();
        removeRead();
        instance.dispose();
        for (const resource of owned) resource.destroy();
        canvas.remove();
      }
    }
    return reports;
  });

  assert.deepEqual(errors, []);
  // Item preview: a scene drawn at 4x MSAA into a caller's 1x colour and depth matches a 1x render of the same view,
  // with antialiased edges, the caller depth written, and no validation error.
  const preview = await page.evaluate(async () => {
    const { EngineKernel, box } = await import('/packages/core/dist/index.js');
    const { Camera, engineRuntime } = await import('/packages/core/dist/extension.js');
    const size = 64;
    const draw = async (samples) => {
      if (samples === 1) globalThis.margoLow = 1;
      else delete globalThis.margoLow;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:32px;height:32px';
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, { backend: 'webgpu' }),
        engine = engineRuntime(instance),
        device = engine.gpu,
        uncaptured = [];
      device.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
      try {
        const item = engine.createScene('item');
        item.background = '#000000';
        const mesh = item.createMesh().setGeometry(box());
        mesh.setRotation([0.4, 0.7, 0]);
        mesh.material.set({ color: '#ffffff' });
        const color = device.createTexture({
            size: [size, size],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          }),
          depth = device.createTexture({
            size: [size, size],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
        device.pushErrorScope('validation');
        instance.render({
          culling: false,
          views: [
            {
              camera: new Camera({ position: [0, 0, 3], target: [0, 0, 0] }),
              viewport: [0, 0, 1, 1],
              scene: item,
              target: { color, depth },
            },
          ],
        });
        const read = async (texture, bytes) => {
          const row = Math.ceil((size * bytes) / 256) * 256,
            buffer = device.createBuffer({
              size: row * size,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [size, size]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const copy = new Uint8Array(buffer.getMappedRange()).slice(),
            out = [];
          for (let y = 0; y < size; y++) out.push(copy.subarray(y * row, y * row + size * bytes));
          buffer.destroy();
          return out;
        };
        const pixels = (await read(color, 4)).map((row) => Array.from({ length: size }, (_, x) => row[x * 4])),
          depthRows = await read(depth, 4),
          depthAt = (x, y) => new Float32Array(depthRows[y].slice(x * 4, x * 4 + 4).buffer)[0];
        const validation = await device.popErrorScope();
        return {
          samples,
          pixels,
          centerDepth: depthAt(size / 2, size / 2),
          cornerDepth: depthAt(0, 0),
          errors: [validation?.message, ...uncaptured].filter(Boolean),
        };
      } finally {
        instance.dispose();
        canvas.remove();
        delete globalThis.margoLow;
      }
    };
    const msaa = await draw(4),
      reference = await draw(1);
    let differing = 0,
      intermediate = 0,
      referenceIntermediate = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const a = msaa.pixels[y][x],
          b = reference.pixels[y][x];
        if (Math.abs(a - b) > 48) differing++;
        // Red channel of a white box on black: values strictly between them mark partially covered edge pixels.
        if (a > 24 && a < 200 && msaa.pixels[y][x - 1] !== a) intermediate++;
        if (b > 24 && b < 200 && reference.pixels[y][x - 1] !== b) referenceIntermediate++;
      }
    return {
      size,
      differingPixels: differing,
      intermediateEdgePixels: intermediate,
      referenceIntermediateEdgePixels: referenceIntermediate,
      centerDepth: msaa.centerDepth,
      cornerDepth: msaa.cornerDepth,
      errors: [...msaa.errors, ...reference.errors],
    };
  });
  assert.deepEqual(preview.errors, [], 'item preview: no WebGPU validation errors');
  // Only silhouette pixels may differ from the 1x reference (a 64 x 64 image has about 250 edge pixels).
  assert.ok(preview.differingPixels <= 250, `item preview differs from 1x in ${preview.differingPixels} pixels`);
  assert.ok(
    preview.intermediateEdgePixels > preview.referenceIntermediateEdgePixels,
    'item preview edges are antialiased (more partially covered pixels than at 1x)',
  );
  assert.ok(preview.centerDepth > 0 && preview.cornerDepth === 0, 'the caller depth holds the item and nothing else');

  // exactSize (pixel-exact drawing): a 16 x 8 backbuffer under a 64 x 32 CSS box keeps exactly 16 x 8, draws a
  // 1-texel checker of per-pixel views back exactly, and has no MSAA (a tilted box's edges show only two colours).
  const exact = await page.evaluate(async () => {
    const { EngineKernel, box } = await import('/packages/core/dist/index.js');
    const { Camera } = await import('/packages/core/dist/extension.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:32px;image-rendering:pixelated';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        exactSize: [16, 8],
        camera: { position: [0, 0, 6], target: [0, 0, 0] },
      }),
      read = () => {
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const context = copy.getContext('2d');
        context.drawImage(canvas, 0, 0);
        return context.getImageData(0, 0, copy.width, copy.height).data;
      };
    try {
      const camera = new Camera({ position: [0, 0, 6], target: [0, 0, 0] }),
        views = [];
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 16; x++)
          views.push({
            camera,
            viewport: [x, y, 1, 1],
            pixels: true,
            clear: { color: (x + y) % 2 ? '#0000ff' : '#ff0000' },
          });
      engine.render({ views });
      const checker = read();
      let wrong = 0;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 16; x++) {
          const i = (y * 16 + x) * 4,
            blue = (x + y) % 2 === 1;
          if (checker[i] !== (blue ? 0 : 255) || checker[i + 2] !== (blue ? 255 : 0) || checker[i + 1] !== 0) wrong++;
        }
      const mesh = engine
        .createMesh()
        .setGeometry(box(3, 3, 0.1))
        .setRotation([0, 0, 0.5]);
      mesh.material.set({ color: '#ffffff', roughness: 1 });
      engine.scene.background = '#000000';
      engine.render();
      const colors = new Set(),
        edge = read();
      for (let i = 0; i < edge.length; i += 4) colors.add(`${edge[i]},${edge[i + 1]},${edge[i + 2]}`);
      return { width: canvas.width, height: canvas.height, wrong, colors: colors.size };
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
  assert.deepEqual(
    [exact.width, exact.height],
    [16, 8],
    'exactSize keeps the backbuffer at 16 x 8 under a 64 x 32 CSS box',
  );
  assert.equal(exact.wrong, 0, 'the 1-texel checker reads back exactly');
  assert.equal(exact.colors, 2, 'no MSAA: a tilted box shows only its face colour and the background');

  // The multi-view demos (examples/split-screen, minimap) held still by reduced motion: picks through each
  // view hit what that view shows, a mesh on a layer a view leaves out is never picked through it, and the frame time
  // (median of 60 frames, each awaited on the GPU) is recorded.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scan = (name, index) =>
    page.evaluate(
      async ([name, index]) => {
        const hits = [];
        for (let fx = 0.05; fx < 1; fx += 0.1)
          for (let fy = 0.05; fy < 1; fy += 0.05) hits.push(await window[name].pickAt(index, fx, fy));
        return [...new Set(hits)];
      },
      [name, index],
    );
  const demos = {};
  for (const [file, name, checks] of [
    [
      'split-screen',
      'splitScreen',
      [
        [0, 0.5, 0.6, 'Player 1'],
        [1, 0.5, 0.6, 'Player 2'],
      ],
    ],
    [
      'minimap',
      'minimap',
      [
        [0, 0.5, 0.75, 'Car'],
        [1, 0.5, 0.5, 'Car marker'],
      ],
    ],
  ]) {
    const before = errors.length;
    await page.goto(`${new URL(page.url()).origin}/examples/${file}.html`);
    await page.waitForFunction((name) => !!window[name], name, { timeout: 120_000 });
    const picks = await page.evaluate(
      // Overlapping picks: core answers them in order, each for its own view.
      ([name, checks]) => Promise.all(checks.map(([index, fx, fy]) => window[name].pickAt(index, fx, fy))),
      [name, checks],
    );
    checks.forEach(([index, fx, fy, expected], i) =>
      assert.equal(picks[i], expected, `${file}: pick at (${fx}, ${fy}) in view ${index}`),
    );
    const views = await page.evaluate((name) => window[name].views.length, name);
    demos[file] = {
      views,
      picks: Object.fromEntries(checks.map(([index, fx, fy], i) => [`${index}:${fx},${fy}`, picks[i]])),
      frameMs: Math.round((await page.evaluate((name) => window[name].frameTime(60), name)) * 100) / 100,
    };
    // Layers: player 2 never picks player 1's marker, the chase view never picks the map-only car marker.
    if (file === 'split-screen')
      assert.ok(!(await scan(name, 1)).includes('Player 1 marker'), "player 2's view leaves out player 1's marker");
    if (file === 'minimap')
      assert.ok(!(await scan(name, 0)).includes('Car marker'), 'the chase view leaves out the map-only marker');
    assert.deepEqual(errors.slice(before), [], `${file}: no page errors`);
  }

  const report = { hardware, scenes, postfx, temporal, water, preview, exact, demos };
  await writeFile('test-results/views-browser.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.page.evaluate(() => window.postfxViewInstance?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
