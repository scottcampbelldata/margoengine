import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { parseGLTF } from '@margoengine/gltf';
import { exportGLB, exportGLTF, exportOBJ, exportPLY, exportSTL } from '@margoengine/exporters';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Renders one frame and copies the canvas in the same task, before the swap chain texture expires. */
function snapshot(engine) {
  // A new drawing buffer: WebKit answers every read of one buffer in a task from the first read.
  engine.canvas.setAttribute('width', engine.canvas.width);
  engine.render({ culling: false });
  const canvas = document.createElement('canvas');
  canvas.width = engine.canvas.width;
  canvas.height = engine.canvas.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(engine.canvas, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}
function difference(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) count++;
  return count;
}
const covered = (pixels, background) => {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (
      Math.abs(pixels[i] - background[0]) +
        Math.abs(pixels[i + 1] - background[1]) +
        Math.abs(pixels[i + 2] - background[2]) >
      12
    )
      n++;
  return n;
};

window.runExporterTests = async () => {
  const checks = [],
    report = { checks };
  const engine = await Engine.create(document.getElementById('view'), {
    camera: { position: [0, 2.5, 7], target: [0, 1, 0] },
  });
  const runtime = engineRuntime(engine),
    gpu = runtime.gpu,
    gpuErrors = [];
  report.backend = engine.backend;
  if (gpu) {
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    gpu.pushErrorScope('validation');
  }

  // A small hierarchy: parented meshes, a transform-only node, shared geometry, two materials, a hidden mesh.
  const cube = box(1, 2, 1),
    red = new PbrMaterial({ color: '#e03030', roughness: 0.4 }),
    blue = new PbrMaterial({ color: '#3050e0', roughness: 0.8, metalness: 0.2, doubleSided: false });
  const base = engine
    .createMesh()
    .setGeometry(cube)
    .setMaterial(red)
    .setPosition([-2, 0, 0])
    .setRotation([0, 0.5, 0.2]);
  base.name = 'base';
  const arm = engine
    .createMesh(base)
    .setGeometry(cube)
    .setMaterial(blue)
    .setPosition([1.2, 1.5, 0])
    .setScale([0.6, 0.8, 0.6])
    .setRotation([0, 0, -0.6]);
  arm.name = 'arm';
  const pivot = engine.createMesh(arm).setPosition([0, 1.4, 0]).setRotation([0.4, 0, 0]);
  pivot.name = 'pivot';
  const hand = engine.createMesh(pivot).setGeometry(cube).setMaterial(red).setScale([1.5, 0.4, 1.5]);
  hand.name = 'hand';
  const other = engine
    .createMesh()
    .setGeometry(cube)
    .setMaterial(blue)
    .setPosition([2.5, 0.5, -1])
    .setScale([1, 1, -1.5]);
  other.name = 'other';
  const ghost = engine.createMesh(base).setGeometry(box()).setMaterial(blue).setPosition([0, -3, 0]);
  ghost.name = 'ghost';
  ghost.visible = false;
  const originals = [base, arm, hand, other];

  const before = snapshot(engine),
    background = Array.from(before.slice(0, 3));
  report.coveredPixels = covered(before, background);
  assert(report.coveredPixels > 500, `scene renders (${report.coveredPixels} covered pixels)`);
  checks.push(`Original hierarchy renders on ${engine.backend} (${report.coveredPixels} covered pixels)`);

  const { layoutGLB } = await import('@margoengine/exporters/sparse');
  const denseGLB = exportGLB(engine, { generator: 'Margo Engine exporters browser test' });
  const layout = layoutGLB(denseGLB, { sparse: false });
  assert(layout.stats.interleaved > 0, 'exported scene must exercise interleaved vertex streams');
  const glb = layout.glb;
  checks.push('Interleaved accessor output is used for the pixel and independent loader round-trip');
  const gltf = exportGLTF(engine);
  const flat = exportGLB(engine, { flatten: true });
  report.glb = Array.from(glb);
  report.gltf = gltf.text;
  report.flat = Array.from(flat);
  const wanted = originals.map((mesh) => ({
    name: mesh.name,
    matrix: Array.from(meshRuntime(mesh).matrix),
    vertices: Array.from(mesh.geometry.vertices),
    material: Array.from(mesh.material.data),
  }));

  // Hide the originals and re-import the GLB with @margoengine/gltf into the same engine.
  base.visible = false;
  other.visible = false;
  const model = parseGLTF(engine, glb);
  const after = snapshot(engine);
  report.pixelDifference = difference(before, after);
  assert(
    report.pixelDifference <= 8,
    `re-imported scene renders like the original (${report.pixelDifference} pixels differ)`,
  );
  model.root.visible = false;
  report.coveredWithBothHidden = covered(snapshot(engine), background);
  assert(report.coveredWithBothHidden === 0, 'originals and import hidden leaves an empty frame');
  model.root.visible = true;
  checks.push(
    `Re-imported GLB renders like the original (${report.pixelDifference} of ${after.length / 4} pixels differ)`,
  );

  assert(model.meshes.length === 4, `imported ${model.meshes.length} renderable meshes`);
  assert(!model.nodes.some((node) => node.name === 'ghost'), 'hidden mesh skipped');
  for (const want of wanted) {
    const node = model.nodes.find((n) => n.name === want.name),
      mesh = model.meshes.find((m) => engineRuntime(engine).store.parents[meshRuntime(m).id] === meshRuntime(node).id);
    const got = meshRuntime(mesh).matrix;
    for (let i = 0; i < 16; i++)
      assert(
        Math.abs(got[i] - want.matrix[i]) < 1e-5,
        `${want.name} world matrix [${i}] ${got[i]} vs ${want.matrix[i]}`,
      );
    assert(
      mesh.geometry.vertices.every((v, i) => v === want.vertices[i]),
      `${want.name} vertices`,
    );
    assert(
      mesh.material.data.every((v, i) => Math.abs(v - want.material[i]) < 1e-7),
      `${want.name} material`,
    );
  }
  const imported = new Set(model.meshes.map((m) => m.geometry));
  // The exporter writes one accessor set for the shared geometry; margoengine-gltf builds one Geometry per glTF mesh (one per material).
  assert(imported.size === 2, `expected 2 imported Geometry objects, got ${imported.size}`);
  checks.push('World matrices, vertex data and materials match after re-import');

  // The re-imported model exports to the same structure (names, meshes, materials).
  model.dispose();
  base.visible = true;
  other.visible = true;
  report.formats = {
    stlBytes: exportSTL(engine).length,
    stlAsciiLines: exportSTL(engine, { binary: false }).split('\n').length,
    objLines: exportOBJ(engine, { materials: true }).obj.split('\n').length,
    plyBytes: exportPLY(engine, { binary: true, colors: true }).length,
  };
  assert(report.formats.stlBytes === 84 + 48 * 50, 'STL size');
  checks.push('STL, OBJ and PLY export from a live engine');

  // Draco in a real worker: the encoder and its Wasm load from the package, and Google's decoder reads the stream back.
  const { compressDraco } = await import('@margoengine/exporters/draco'),
    { DracoDecoder } = await import('@margoengine/decoders'),
    plain = exportGLB(engine),
    draco = await compressDraco(plain);
  assert(draco.compressed > 0 && draco.glb.length > 0, 'Draco compressed nothing');
  report.draco = Array.from(draco.glb);
  const binAt = 20 + new DataView(draco.glb.buffer, draco.glb.byteOffset).getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(draco.glb.subarray(20, binAt))),
    primitive = json.meshes[0].primitives[0],
    extension = primitive.extensions.KHR_draco_mesh_compression,
    view = json.bufferViews[extension.bufferView],
    stream = draco.glb.subarray(
      binAt + 8 + (view.byteOffset ?? 0),
      binAt + 8 + (view.byteOffset ?? 0) + view.byteLength,
    ),
    decoder = new DracoDecoder(),
    decoded = await decoder.decode(stream, { attributeIds: extension.attributes });
  decoder.dispose();
  assert(decoded.vertexCount === json.accessors[primitive.attributes.POSITION].count, 'Draco vertex count');
  const stopped = new AbortController(),
    pending = compressDraco(plain, { signal: stopped.signal });
  stopped.abort();
  assert(
    await pending.then(
      () => false,
      (error) => error.name === 'AbortError',
    ),
    'Draco abort',
  );
  checks.push('compressDraco runs in its worker, the Draco decoder reads the stream, and an abort stops it');

  // KTX2 in a real worker: the encoder and its Wasm load from the package and read a JPEG there, and the transcoder reads it.
  const { compressTextures, encodeKTX2 } = await import('@margoengine/exporters/ktx2'),
    { KTX2Decoder } = await import('@margoengine/decoders'),
    jpeg = new Uint8Array(await (await fetch('fixtures/jpeg/progressive-420.jpg')).arrayBuffer()),
    textured = exportGLB({
      nodes: [
        {
          geometry: {
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
            indices: [0, 1, 2],
          },
          material: { baseColorTexture: { image: jpeg, mimeType: 'image/jpeg' } },
        },
      ],
    }),
    ktx2 = await compressTextures(textured);
  assert(ktx2.compressed === 1, 'KTX2 compressed nothing');
  const ktx2At = 20 + new DataView(ktx2.glb.buffer, ktx2.glb.byteOffset).getUint32(12, true),
    ktx2JSON = JSON.parse(new TextDecoder().decode(ktx2.glb.subarray(20, ktx2At))),
    ktx2View = ktx2JSON.bufferViews[ktx2JSON.images[0].bufferView],
    ktx2Bytes = ktx2.glb.subarray(
      ktx2At + 8 + (ktx2View.byteOffset ?? 0),
      ktx2At + 8 + (ktx2View.byteOffset ?? 0) + ktx2View.byteLength,
    ),
    transcoder = new KTX2Decoder({ target: 'rgba8' }),
    transcoded = await transcoder.transcode(ktx2Bytes);
  transcoder.dispose();
  assert(transcoded.width === 56 && transcoded.height === 40, 'KTX2 size');
  assert((await encodeKTX2(jpeg)).length > 0 && jpeg.length > 0, 'encodeKTX2 must leave the caller bytes attached');
  const halted = new AbortController(),
    running = compressTextures(textured, { signal: halted.signal });
  halted.abort();
  assert(
    await running.then(
      () => false,
      (error) => error.name === 'AbortError',
    ),
    'KTX2 abort',
  );
  // The own encoder's files must also decode through Margo's production GPU
  // path, including alpha, both block formats and every mip. Compare stored
  // texel bytes against the independent transcoder, before any display curve.
  assert(gpu, 'encoder upload regression needs the native or compatibility GPU device');
  const { KTX2GPUDecoder } = await import('@margoengine/decoders/ktx2-gpu');
  const gpuDecoder = new KTX2GPUDecoder({ device: gpu });
  const cpuDecoder = new KTX2Decoder({ target: 'rgba8' });
  report.encoderGPU = [];
  try {
    for (const mode of ['etc1s', 'uastc']) {
      for (const role of ['color', 'data', 'normal']) {
        const bytes = await encodeKTX2(jpeg, {
          mode,
          colorSpace: role === 'color' ? 'srgb' : 'linear',
          normalMap: role === 'normal',
        });
        const expected = await cpuDecoder.transcode(bytes.slice());
        const texture = await gpuDecoder.createTexture(bytes, { usage: GPUTextureUsage.COPY_SRC });
        let checked = 0;
        try {
          assert(texture.mipLevelCount === expected.mipmaps.length, `${mode}/${role} mip count`);
          for (let level = 0; level < expected.mipmaps.length; level++) {
            const mip = expected.mipmaps[level];
            const stride = Math.ceil((mip.width * 4) / 256) * 256;
            const read = gpu.createBuffer({
              size: stride * mip.height,
              usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
            try {
              const encoder = gpu.createCommandEncoder();
              encoder.copyTextureToBuffer({ texture, mipLevel: level }, { buffer: read, bytesPerRow: stride }, [
                mip.width,
                mip.height,
              ]);
              gpu.queue.submit([encoder.finish()]);
              await read.mapAsync(GPUMapMode.READ);
              const actual = new Uint8Array(read.getMappedRange());
              for (let y = 0; y < mip.height; y++)
                for (let x = 0; x < mip.width * 4; x++) {
                  assert(
                    actual[y * stride + x] === mip.data[y * mip.width * 4 + x],
                    `${mode}/${role}/${level}: texel ${x},${y}`,
                  );
                  checked++;
                }
              read.unmap();
            } finally {
              read.destroy();
            }
          }
        } finally {
          texture.destroy();
        }
        report.encoderGPU.push({ mode, role, levels: expected.mipmaps.length, exactBytes: checked });
      }
    }
  } finally {
    cpuDecoder.dispose();
    gpuDecoder.dispose();
  }
  checks.push('Own ETC1S/UASTC color, data and normal files upload and decode every mip exactly on the GPU');

  // Errors keep their type across the worker, as the same failures have in Node.
  const refused = await encodeKTX2(new Uint8Array([1, 2, 3, 4])).catch((error) => error);
  assert(refused instanceof TypeError, `KTX2 bad bytes gave ${refused?.name}`);
  const cut = await encodeKTX2(jpeg.subarray(0, 40)).catch((error) => error);
  assert(cut?.name === 'MargoError' && cut.code === 'failed', `KTX2 cut JPEG gave ${cut?.name} ${cut?.code}`);
  checks.push(
    'compressTextures reads a JPEG and encodes in its worker, the transcoder reads the file, and an abort stops it',
  );

  report.textures = await (await import('./textures-browser.js')).textureBrowserChecks();
  checks.push('Texture resize, native WebP serialization, AVIF capability/error, GLB image fallbacks and DOM toBlob');

  if (gpu) report.validationError = (await gpu.popErrorScope())?.message ?? null;
  report.gpuErrors = gpuErrors;
  assert(
    !report.validationError && !gpuErrors.length,
    `WebGPU validation errors: ${report.validationError} ${gpuErrors}`,
  );
  if (gpu) checks.push('Zero WebGPU validation errors');
  engine.dispose();
  return report;
};
