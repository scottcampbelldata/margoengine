// Margo implementation of the parity texture scenes (../parity.js, area 'textures'). Textures are
// @margoengine/materials `Texture`s on materials meshes; KTX2 goes through @margoengine/decoders.
import { Engine } from '@margoengine/core';
import { PALETTE } from '../catalog.js';
import { app, engineFor, floor } from '../margo.js';

const ms = (s) => +(performance.now() - s).toFixed(1);

/** A still camera for task scenes (they draw at most one small quad). */
const stillCamera = { fov: 45, near: 0.1, far: 100, target: [0, 0, 0], at: () => [0, 0, 3] };

/** The first image of a GLB (bytes and MIME type), read from its JSON and BIN chunks. */
function glbImage(glb, index) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength),
    jsonLength = view.getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))),
    binStart = 20 + jsonLength + 8,
    image = json.images[index],
    bv = json.bufferViews[image.bufferView];
  return {
    bytes: glb.slice(binStart + (bv.byteOffset ?? 0), binStart + (bv.byteOffset ?? 0) + bv.byteLength),
    type: image.mimeType,
  };
}

/**
 * Materials textures upload when a material that uses them is drawn (there is no separate upload call), so a task
 * puts the texture on one small unlit quad, draws one frame and waits for the GPU. `probe` is that quad's material.
 */
async function uploader(canvas, marks) {
  const engine = await engineFor(canvas, stillCamera, 16, marks),
    { UnlitMaterial, Texture, createMesh } = await import('@margoengine/materials'),
    { planeGeometry } = await import('@margoengine/geometry'),
    material = new UnlitMaterial({ color: '#ffffff' });
  createMesh(engine, planeGeometry(0.2, 0.2), material);
  // Compile the quad's pipeline once with a placeholder map, outside the timing.
  material.map = new Texture({ data: new Uint8Array(4 * 4 * 4).fill(255), width: 4, height: 4 });
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  let last;
  return {
    engine,
    Texture,
    /** Draws `texture` once (uploading it and its mips) and resolves when the GPU is done; frees the previous one. */
    async upload(texture) {
      material.map = texture;
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
      last?.dispose();
      last = texture;
      return texture;
    },
    get last() {
      return last;
    },
  };
}

/** The moving plasma (the same function on the three.js side), RGBA8 rows written into `out`. */
const SINE = Float32Array.from({ length: 1024 }, (_, i) => Math.sin((i / 1024) * Math.PI * 2));
function plasma(out, size, t) {
  const a = Math.floor(t * 60),
    b = Math.floor(t * 40),
    c = Math.floor(t * 50);
  for (let y = 0, o = 0; y < size; y++) {
    const sy = SINE[(y * 3 - b) & 1023];
    for (let x = 0; x < size; x++, o += 4) {
      const v = SINE[(x * 2 + a) & 1023] + sy + SINE[(x + y + c) & 1023];
      out[o] = 128 + 127 * SINE[(Math.floor(v * 160) + 1024 * 4) & 1023];
      out[o + 1] = 128 + 127 * SINE[(Math.floor(v * 160) + 341 + 1024 * 4) & 1023];
      out[o + 2] = 128 + 127 * SINE[(Math.floor(v * 160) + 683 + 1024 * 4) & 1023];
      out[o + 3] = 255;
    }
  }
}
/** The static 64^3 R8 volume (the same function on the three.js side). */
function volumeData(n) {
  const out = new Uint8Array(n * n * n);
  for (let z = 0, o = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++, o++)
        out[o] = Math.round(255 * (0.5 + 0.5 * Math.sin(x * 0.2) * Math.cos(y * 0.15) * Math.sin(z * 0.25 + 1)));
  return out;
}
/** The canvas texture's picture at time t: a gradient and `n` moving circles (the same on the three.js side). */
function paint(ctx, size, n, t) {
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#1d3557');
  g.addColorStop(1, '#e9c46a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = PALETTE[i % 16];
    ctx.beginPath();
    ctx.arc(
      size * (0.5 + 0.4 * Math.sin(t * 0.7 + i * 1.3)),
      size * (0.5 + 0.4 * Math.cos(t * 0.9 + i * 2.1)),
      size * (0.03 + (i % 5) * 0.012),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}
/** The 4 x 4 tile atlas: tile k has palette colour k, a white bar toward its top and its number. */
function atlasCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'),
    tile = size / 4;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${tile * 0.45}px sans-serif`;
  for (let k = 0; k < 16; k++) {
    const x = (k % 4) * tile,
      y = Math.floor(k / 4) * tile;
    ctx.fillStyle = PALETTE[k];
    ctx.fillRect(x, y, tile, tile);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + tile * 0.1, y + tile * 0.08, tile * 0.8, tile * 0.12);
    ctx.fillStyle = '#101010';
    ctx.fillText(String(k), x + tile / 2, y + tile * 0.6);
  }
  return canvas;
}

/** Places one materials mesh per catalog item through its model root. */
function place(engine, createMesh, geometry, def, material) {
  return def.items.map((b, i) => {
    const mesh = createMesh(engine, geometry, material(b, i));
    mesh.root.setPosition(b.position).setRotation(b.rotation);
    return mesh;
  });
}

/** A muted, looping video of `url`, resolved once it is playing. */
async function playing(url) {
  const video = document.createElement('video');
  Object.assign(video, { src: url, muted: true, loop: true, playsInline: true, crossOrigin: 'anonymous' });
  const started = new Promise((done, fail) => {
    video.addEventListener('playing', done, { once: true });
    video.addEventListener('error', () => fail(new Error(`video ${url} failed to load`)), { once: true });
  });
  await video.play();
  await started;
  return video;
}

export const builders = {
  async 'p-texture-decode'(canvas, data, marks) {
    const up = await uploader(canvas, marks),
      s = performance.now(),
      glb = new Uint8Array(await (await fetch(data.url)).arrayBuffer()),
      { bytes, type } = glbImage(glb, data.image),
      blob = new Blob([bytes], { type });
    marks.buildMs = ms(s);
    return {
      // Decode as loadTexture does (no colour or alpha conversion), upload with its mip chain.
      async task() {
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        await up.upload(new up.Texture(bitmap, {}, true));
      },
      output: () => {
        const t = up.last?.gpuTexture(up.engine.gpu);
        return { width: t?.width, height: t?.height, mips: t?.mipLevelCount, bytes: bytes.length };
      },
      info: () => ({
        note: 'the GLB base colour image is a 1024 x 1024 JPEG (spec says 2048 PNG); Margo uploads on first draw: each call draws one frame with a small quad using the texture',
      }),
    };
  },

  async 'p-ktx2'(canvas, data, marks) {
    // KTX2Decoder picks the best format the device has; the device must request the compression features.
    const s0 = performance.now(),
      adapter = await navigator.gpu.requestAdapter(),
      features = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2'].filter((f) =>
        adapter?.features.has(f),
      ),
      engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        features,
        camera: { fov: 45, near: 0.1, far: 100, position: [0, 0, 3], target: [0, 0, 0] },
      });
    marks.createMs = ms(s0);
    const s = performance.now(),
      { KTX2Decoder } = await import('@margoengine/decoders'),
      decoder = new KTX2Decoder({ device: engine.gpu }),
      bytes = new Uint8Array(await (await fetch(data.url)).arrayBuffer());
    // Warm the worker pool and transcoder outside the timing (three's loader is warmed the same way).
    (await decoder.createTexture(bytes)).destroy();
    await engine.gpu.queue.onSubmittedWorkDone();
    marks.buildMs = ms(s);
    let last;
    return {
      async task() {
        const texture = await decoder.createTexture(bytes);
        await engine.gpu.queue.onSubmittedWorkDone();
        last?.destroy();
        last = texture;
      },
      output: () => ({ width: last?.width, height: last?.height, mips: last?.mipLevelCount, format: last?.format }),
      info: () => ({ note: `features: ${features.join(', ') || 'none'}` }),
    };
  },

  async 'p-mipmaps'(canvas, data, marks) {
    const up = await uploader(canvas, marks),
      s = performance.now(),
      n = data.size,
      pixels = new Uint8Array(n * n * 4);
    for (let y = 0, o = 0; y < n; y++)
      for (let x = 0; x < n; x++, o += 4) {
        pixels[o] = x & 255;
        pixels[o + 1] = y & 255;
        pixels[o + 2] = (x ^ y) & 255;
        pixels[o + 3] = 255;
      }
    marks.buildMs = ms(s);
    return {
      task: () => up.upload(new up.Texture({ data: pixels, width: n, height: n }, { mipmaps: true })),
      output: () => {
        const t = up.last?.gpuTexture(up.engine.gpu);
        return { width: t?.width, height: t?.height, mips: t?.mipLevelCount };
      },
      info: () => ({
        note: 'Margo uploads on first draw: each call draws one frame with a small quad using the texture',
      }),
    };
  },

  async 'p-data-texture'(canvas, data, marks) {
    // A screen-filling quad: a still camera at z = 1 looking at a quad that exactly fills its view.
    const d = 1,
      h = 2 * d * Math.tan((45 / 2) * (Math.PI / 180)),
      camera = { fov: 45, near: 0.1, far: 10, target: [0, 0, 0], at: () => [0, 0, d] },
      engine = await engineFor(canvas, camera, 16, marks),
      s = performance.now(),
      { Texture, WgslMaterial, createMesh } = await import('@margoengine/materials'),
      { planeGeometry } = await import('@margoengine/geometry'),
      n = data.size,
      v = data.volume,
      pixels = new Uint8Array(n * n * 4);
    plasma(pixels, n, 0);
    const image = new Texture(
        { data: pixels, width: n, height: n, format: 'rgba8unorm' },
        { colorSpace: 'linear', mipmaps: false },
      ),
      volume = new Texture(
        { data: volumeData(v), width: v, height: v, depth: v, format: 'r8unorm' },
        { dimension: '3d', colorSpace: 'linear' },
      ),
      material = new WgslMaterial({
        shading: 'basic',
        wgsl: `fn shade(i: Out, s: Surface) -> Surface {
  var o = s;
  let uv = i.uv.xy;
  let k = textureSample(volume, volumeSampler, vec3f(uv, (uv.x + uv.y) * 0.5)).r;
  o.base = vec4f(textureSample(image, imageSampler, uv).rgb * (0.25 + 0.75 * k), 1.0);
  return o;
}`,
        textures: { image, volume },
      });
    createMesh(engine, planeGeometry((h * canvas.width) / canvas.height, h), material);
    marks.buildMs = ms(s);
    return app(
      engine,
      (t) => {
        plasma(pixels, n, t);
        image.update();
      },
      { camera, note: 'materials mesh, WgslMaterial' },
    );
  },

  async 'p-canvas-texture'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [{ PbrMaterial, Texture, createMesh }, { boxGeometry }] = await Promise.all([
        import('@margoengine/materials'),
        import('@margoengine/geometry'),
      ]),
      surface = document.createElement('canvas');
    surface.width = surface.height = data.size;
    const ctx = surface.getContext('2d');
    paint(ctx, data.size, data.circles, 0);
    const map = new Texture(surface),
      material = new PbrMaterial({ map, ...data.material });
    floor(engine, data.floor);
    place(engine, createMesh, boxGeometry(0.5, 0.5, 0.5), data, () => material);
    marks.buildMs = ms(s);
    return app(
      engine,
      (t) => {
        paint(ctx, data.size, data.circles, t);
        map.update();
      },
      { camera: data.camera, note: 'materials meshes' },
    );
  },

  async 'p-video'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [{ PbrMaterial, Texture, createMesh }, { boxGeometry }] = await Promise.all([
        import('@margoengine/materials'),
        import('@margoengine/geometry'),
      ]),
      video = await playing(data.url),
      // A video Texture re-uploads whenever the video's currentTime changes (no mips, the video default).
      material = new PbrMaterial({ map: new Texture(video), ...data.material });
    floor(engine, data.floor);
    place(engine, createMesh, boxGeometry(data.size, data.size, data.size), data, () => material);
    marks.buildMs = ms(s);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'materials meshes; the video plays in real time, so the frame shown in a screenshot differs between engines',
    });
  },

  async 'p-uv-transform'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      [{ PbrMaterial, Texture, createMesh }, { boxGeometry }] = await Promise.all([
        import('@margoengine/materials'),
        import('@margoengine/geometry'),
      ]),
      atlas = new Texture(atlasCanvas(1024));
    place(engine, createMesh, boxGeometry(data.size, data.size, data.size), data, (b, i) => {
      const k = i % 16;
      return new PbrMaterial({
        map: atlas,
        ...data.material,
        uvTransform: { offset: [(k % 4) / 4, Math.floor(k / 4) / 4], scale: [0.25, 0.25], rotation: i * 0.1 },
      });
    });
    marks.buildMs = ms(s);
    return app(engine, () => {}, { camera: data.camera, note: 'materials meshes, one material each' });
  },

  async 'p-depth-texture'(canvas, data, marks) {
    // DepthTexture draws the core boxes into its own depth before the main pass; a basic WgslMaterial quad in front
    // of the camera (placed by `displace` from per-frame uniforms) shows the linear view depth (z - near) / (far - near).
    const { camera } = data,
      engine = await engineFor(canvas, camera, data.items.length + 16, marks),
      s = performance.now(),
      [{ Texture, WgslMaterial, createMesh }, { planeGeometry }, { DepthTexture }, { meshes, palette }] =
        await Promise.all([
          import('@margoengine/materials'),
          import('@margoengine/geometry'),
          import('@margoengine/post/depth'),
          import('../margo.js'),
        ]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const depth = DepthTexture.attach(engine),
      tan = Math.tan((camera.fov / 2) * (Math.PI / 180)),
      aspect = canvas.width / canvas.height,
      quad = new WgslMaterial({
        shading: 'basic',
        wgsl: `fn displace(i: Input) -> vec3f {
  return uniforms.eye.xyz + uniforms.fwd.xyz * uniforms.eye.w
    + uniforms.right.xyz * i.position.x * uniforms.right.w + uniforms.up.xyz * i.position.y * uniforms.up.w;
}
fn shade(i: Out, s: Surface) -> Surface {
  var o = s;
  let d = textureLoad(sceneDistance, vec2i(i.clip.xy), 0).r;
  let z = select(uniforms.range.y, d * dot(normalize(i.position - uniforms.eye.xyz), uniforms.fwd.xyz), d > 0.0);
  let v = clamp((z - uniforms.range.x) / (uniforms.range.y - uniforms.range.x), 0.0, 1.0);
  o.base = vec4f(v, v, v, 1.0);
  return o;
}`,
        uniforms: {
          eye: [0, 0, 0, 0],
          fwd: [0, 0, -1, 0],
          right: [1, 0, 0, 1],
          up: [0, 1, 0, 1],
          range: [camera.near, camera.far],
        },
        textures: {
          sceneDistance: new Texture({ data: new Float32Array(1), width: 1, height: 1, format: 'r32float' }),
        },
        depthTest: false,
        depthWrite: false,
      });
    depth.onResize(() => (quad.textures.sceneDistance = new Texture(depth.distance)));
    // The quad's mesh space is its own: displace puts it in front of the camera, so its root stays at the origin.
    createMesh(engine, planeGeometry(2, 2), quad, { renderOrder: 10 });
    const place = (t) => {
      const e = camera.at(t),
        f = camera.target.map((x, k) => x - e[k]),
        fl = Math.hypot(...f),
        fw = f.map((x) => x / fl),
        r = [-fw[2], 0, fw[0]],
        rl = Math.hypot(...r),
        rn = r.map((x) => x / rl),
        u = [rn[1] * fw[2] - rn[2] * fw[1], rn[2] * fw[0] - rn[0] * fw[2], rn[0] * fw[1] - rn[1] * fw[0]],
        dist = camera.near * 2,
        hh = dist * tan * 1.02,
        U = quad.uniforms;
      U.eye = [...e, dist];
      U.fwd = [...fw, 0];
      U.right = [...rn, hh * aspect];
      U.up = [...u, hh];
    };
    place(0);
    marks.buildMs = ms(s);
    return app(engine, place, {
      camera,
      note: 'Margo draws the boxes twice (DepthTexture pass, then the main pass under the quad); three draws them once into its target',
    });
  },
};
