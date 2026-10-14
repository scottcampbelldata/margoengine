import {Engine, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {SceneTarget} from '../../shared/msaa.js';
import {PointsPlugin, PointCloud, SpriteBatch, SpriteMaterial, atlasRect, random} from '@margoengine/points';
import {CameraProjection} from '../../cameras/dist/index.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const SIZE = 256;
const PROJ = 0.5 * SIZE / Math.tan(Math.PI / 6); // pixels per world unit at distance 1, fov 60

// Test-only plugin: redirects the frame into a copyable texture, then copies it to a mappable buffer.
class Capture {
  name = 'capture';
  setup(engine) {this.device = engine.gpu; this.texture = undefined;}
  registerPasses(graph) {
    graph.add({name: 'capture:redirect', order: -100, execute: context => {
      if (!this.texture) {
        this.format = context.format;
        this.texture = this.device.createTexture({size: [context.width, context.height], format: context.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING});
        this.depth = this.device.createTexture({size: [context.width, context.height], format: context.descriptor.depthStencil.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
        this.target = new SceneTarget(this.device, this.texture, this.depth, context.descriptor.multisample.count);
        this.buffer = this.device.createBuffer({size: context.width * context.height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      }
      this.target.begin(context);
    }});
    graph.add({name: 'capture:copy', order: 900, execute: context => {
      this.target.present(context);
      context.encoder.copyTextureToBuffer({texture: this.texture}, {buffer: this.buffer, bytesPerRow: context.width * 4}, [context.width, context.height]);
    }});
  }
  onDeviceRestored(engine) {this.dispose(); this.setup(engine);}
  dispose() {this.target?.dispose(); this.depth?.destroy(); this.texture?.destroy(); this.buffer?.destroy(); this.target = this.depth = this.texture = this.buffer = undefined;}
  async read() {
    await this.buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(this.buffer.getMappedRange()).slice(); this.buffer.unmap();
    if (this.format.startsWith('bgra')) for (let i = 0; i < bytes.length; i += 4) {const b = bytes[i]; bytes[i] = bytes[i + 2]; bytes[i + 2] = b;}
    return {bytes, at: (x, y) => [...bytes.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)]};
  }
}

const count = (image, test) => {let n = 0; for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (test(image.at(x, y))) n++; return n;};
const bbox = (image, test) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (test(image.at(x, y))) {b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);}
  return {x: b[0], y: b[1], width: b[2] - b[0] + 1, height: b[3] - b[1] + 1};
};
const white = ([r, g, b]) => r > 128 && g > 128 && b > 128;
const red = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const green = ([r, g, b]) => g > 200 && r < 60 && b < 60;
const blue = ([r, g, b]) => b > 200 && r < 60 && g < 60;
const yellow = ([r, g, b]) => r > 200 && g > 200 && b < 60;
const lit = ([r, g, b]) => r + g + b > 60;
const project = (x, y, z, eye = 10) => [SIZE / 2 + x * PROJ / (eye - z), SIZE / 2 - y * PROJ / (eye - z)];

/** 2x2 atlas: red top left, green top right, blue bottom left, yellow bottom right. */
async function atlas(cell = 32) {
  const data = new Uint8ClampedArray(cell * 2 * cell * 2 * 4), colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let y = 0; y < cell * 2; y++) for (let x = 0; x < cell * 2; x++) {
    const c = colors[(y < cell ? 0 : 2) + (x < cell ? 0 : 1)], o = (y * cell * 2 + x) * 4;
    data.set([...c, 255], o);
  }
  return createImageBitmap(new ImageData(data, cell * 2, cell * 2));
}

/** A soft round alpha mask: opaque disc of radius 0.35, transparent outside. */
async function discTexture(size = 32) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / size;
    data.set([255, 255, 255, d < 0.35 ? 255 : 0], (y * size + x) * 4);
  }
  return createImageBitmap(new ImageData(data, size, size));
}

window.runPointTests = async () => {
  const canvas = document.querySelector('#view');
  const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 10], target: [0, 0, 0], fov: 60, near: 0.1, far: 100}});
  const runtime = engineRuntime(engine), report = {checks: [], backend: engine.backend};
  const errors = [], modules = [];
  const watch = device => {
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    device.pushErrorScope('validation');
    const create = device.createShaderModule.bind(device);
    device.createShaderModule = descriptor => {const module = create(descriptor); modules.push(module); return module;};
  };
  const settle = async device => {
    const diagnostics = (await Promise.all(modules.splice(0).map(m => m.getCompilationInfo()))).flatMap(info => info.messages).filter(m => m.type === 'error');
    const validation = await device.popErrorScope();
    assert(!diagnostics.length && !validation && !errors.length, `GPU errors: ${JSON.stringify(diagnostics.map(d => d.message))} ${validation?.message ?? ''} ${errors.join('; ')}`);
    device.pushErrorScope('validation');
  };
  watch(runtime.gpu);
  const capture = new Capture(), points = new PointsPlugin({pointBudget: 1_000_000});
  engine.use(capture).use(points);
  const frame = async () => {engine.render(); report.samples = capture.target.samples; return capture.read();};
  const background = (await frame()).at(0, 0);
  const isBackground = pixel => pixel.every((v, i) => Math.abs(v - background[i]) <= 1);

  // 1. Pixel sizes: an even-sized square point centered on a pixel corner covers exactly size x size pixels.
  const dot = points.add(new PointCloud({positions: [0, 0, 0], material: {size: 4}}));
  let image = await frame();
  await settle(runtime.gpu);
  const squares = {};
  for (const size of [2, 4, 8, 16]) {
    dot.material.size = size; image = await frame();
    squares[size] = count(image, white);
    assert(squares[size] === size * size, `Square point of ${size} px covers ${squares[size]} pixels`);
  }
  // Round points: the antialiased coverage sums to the disc area and the quad corners stay empty.
  dot.material.set({shape: 'round', size: 16}); image = await frame();
  let coverage = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) coverage += Math.max(0, image.at(x, y)[1] - background[1]) / (255 - background[1]);
  const corners = [[120, 120], [135, 120], [120, 135], [135, 135]].map(([x, y]) => image.at(x, y));
  assert(Math.abs(coverage - Math.PI * 64) < Math.PI * 64 * 0.04, `Round coverage ${coverage}, expected ${Math.PI * 64}`);
  assert(corners.every(isBackground), `Round point corners are not empty: ${JSON.stringify(corners)}`);
  assert(white(image.at(128, 128)) && white(image.at(122, 128)), 'Round point center is not filled');
  const partial = count(image, ([, g]) => g > background[1] + 10 && g < 245);
  assert(partial >= 16, `Round point edge is not antialiased: ${partial} partial pixels`);
  report.sizes = {squares, roundCoverage: Math.round(coverage * 10) / 10, expected: Math.round(Math.PI * 640) / 10};
  report.checks.push('Square points cover size x size pixels; round points match the disc area with empty corners and antialiased edges');

  // 2. Per-point colors: byte RGB, float RGBA with alpha, material color multiply.
  dot.dispose();
  const quad = points.add(new PointCloud({
    positions: [-2, 2, 0, 2, 2, 0, -2, -2, 0, 2, -2, 0],
    colors: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), material: {size: 10},
  }));
  image = await frame();
  const spots = [[-2, 2], [2, 2], [-2, -2], [2, -2]].map(([x, y]) => project(x, y, 0).map(Math.floor));
  assert(red(image.at(...spots[0])) && green(image.at(...spots[1])) && blue(image.at(...spots[2])) && yellow(image.at(...spots[3])),
    `Colors misplaced: ${spots.map(s => image.at(...s)).join(' | ')}`);
  assert(isBackground(image.at(128, 128)), 'Center should be empty');
  quad.setColors(new Float32Array([1, 0, 0, 0.5, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1]), 4); image = await frame();
  const half = image.at(...spots[0]);
  assert(half[0] > 120 && half[0] < 140, `RGBA alpha did not blend: ${half}`);
  quad.material.setColor('#00ff00'); quad.material.vertexColors = true; image = await frame();
  assert(isBackground(image.at(...spots[2])) || image.at(...spots[2]).every(v => v < 20), 'Material color should multiply blue to black');
  assert(green(image.at(...spots[1])), 'Material color multiply lost green');
  quad.material.vertexColors = false; image = await frame();
  assert(green(image.at(...spots[2])), 'vertexColors: false should use the material color');
  quad.dispose();
  report.checks.push('Byte RGB and float RGBA per-point colors land on their points; alpha blends; material color multiplies');

  // 3. Depth against a core mesh (reversed-Z greater-equal) and following a mesh.
  const mesh = engine.createMesh().setGeometry(box(2, 2, 2)).setMaterial(new PbrMaterial({color: '#ff0000', roughness: 1}));
  const marker = points.add(new PointCloud({positions: [0, 0, -2], colors: new Uint8Array([0, 255, 0]), material: {size: 12}}));
  image = await frame();
  assert(!green(image.at(128, 128)), `Point behind the mesh is visible: ${image.at(128, 128)}`);
  marker.updatePositions(0, [0, 0, 2]); image = await frame();
  assert(green(image.at(128, 128)), `Point in front of the mesh is hidden: ${image.at(128, 128)}`);
  // Opaque points write depth: a red point behind a green one stays hidden whatever the draw order.
  const behind = points.add(new PointCloud({positions: [0, 0, 1.5], colors: new Uint8Array([0, 0, 255]), material: {size: 30}}));
  image = await frame();
  assert(green(image.at(128, 128)) && blue(image.at(128, 141)), `Opaque points do not occlude each other: ${image.at(128, 128)} ${image.at(128, 141)}`);
  behind.dispose();
  mesh.visible = false;
  const anchor = engine.createMesh(); anchor.setPosition([0, 2, 0]);
  marker.updatePositions(0, [0, 0, 0]).attach(anchor); image = await frame();
  const lifted = project(0, 2, 0).map(Math.floor);
  assert(green(image.at(...lifted)) && !green(image.at(128, 128)), 'Attached cloud did not follow the mesh');
  anchor.visible = false; image = await frame();
  assert(!green(image.at(...lifted)), 'Cloud attached to a hidden mesh still draws');
  anchor.visible=true;const parent=engine.createMesh();anchor.setParent(parent);parent.visible=false;image=await frame();
  assert(!green(image.at(...lifted)), 'Cloud attached below a hidden ancestor still draws');parent.visible=true;image=await frame();assert(green(image.at(...lifted)), 'Cloud did not return when its ancestor became visible');
  marker.dispose(); anchor.dispose();
  await settle(runtime.gpu);
  report.checks.push('Points behind a mesh are hidden (greater-equal), opaque points occlude each other, attached clouds follow the mesh');

  // 4. Size attenuation: world-unit points shrink with distance.
  const pair = points.add(new PointCloud({positions: [-2, 0, 0, 2, 0, -10], material: {size: 1, sizeUnits: 'world'}}));
  image = await frame();
  const nearBox = bbox({at: (x, y) => x < 128 ? image.at(x, y) : [0, 0, 0]}, white), farBox = bbox({at: (x, y) => x >= 128 ? image.at(x, y) : [0, 0, 0]}, white);
  const nearExpected = PROJ / 10, farExpected = PROJ / 20;
  assert(Math.abs(nearBox.width - nearExpected) <= 1.5 && Math.abs(farBox.width - farExpected) <= 1.5, `Attenuated sizes ${nearBox.width} / ${farBox.width}, expected ${nearExpected.toFixed(1)} / ${farExpected.toFixed(1)}`);
  pair.material.sizeAttenuation = false; pair.material.size = 6; image = await frame();
  const flatNear = bbox({at: (x, y) => x < 128 ? image.at(x, y) : [0, 0, 0]}, white), flatFar = bbox({at: (x, y) => x >= 128 ? image.at(x, y) : [0, 0, 0]}, white);
  assert(flatNear.width === 6 && flatFar.width === 6, `sizeAttenuation false should keep 6 px: ${flatNear.width} / ${flatFar.width}`);
  pair.dispose();
  report.attenuation = {near: nearBox.width, far: farBox.width, nearExpected: +nearExpected.toFixed(2), farExpected: +farExpected.toFixed(2)};
  report.checks.push('World-unit points attenuate with distance (1/d); pixel points keep their size');

  // 5. Subrange updates write only that range.
  const row = new Float32Array(64 * 3);
  for (let i = 0; i < 64; i++) row[i * 3] = -6 + i * 12 / 63;
  const strip = points.add(new PointCloud({positions: row, colors: new Uint8Array(64 * 3).fill(255), material: {size: 4}}));
  const before = await frame();
  const writes = [], queue = runtime.gpu.queue, writeBuffer = queue.writeBuffer;
  queue.writeBuffer = function (buffer, offset, data, dataOffset = 0, size) {
    const element = data.BYTES_PER_ELEMENT ?? 1, bytes = size !== undefined ? size * element : data.byteLength - dataOffset * element;
    writes.push({buffer: buffer.size, offset, bytes});
    return writeBuffer.call(this, buffer, offset, data, dataOffset, size);
  };
  strip.updatePositions(10, [row[30], 2, 0, row[33], 2, 0, row[36], 2, 0, row[39], 2, 0]);
  strip.updateColors(10, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]));
  const after = await frame();
  queue.writeBuffer = writeBuffer;
  const positionWrites = writes.filter(w => w.buffer === 64 * 12), colorWrites = writes.filter(w => w.buffer === 64 * 4);
  assert(JSON.stringify(positionWrites) === JSON.stringify([{buffer: 768, offset: 120, bytes: 48}]), `Position writes ${JSON.stringify(positionWrites)}`);
  assert(JSON.stringify(colorWrites) === JSON.stringify([{buffer: 256, offset: 40, bytes: 16}]), `Color writes ${JSON.stringify(colorWrites)}`);
  assert(points.stats.uploadBytes === 64, `Uploaded ${points.stats.uploadBytes} bytes`);
  let changed = 0, outside = 0;
  const moved = [10, 11, 12, 13].map(i => project(row[i * 3], 0, 0)[0]), raised = project(0, 2, 0)[1];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const a = before.at(x, y), b = after.at(x, y);
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 30) continue;
    changed++;
    const nearOld = Math.abs(y - 128) <= 3 && moved.some(mx => Math.abs(x - mx) <= 3), nearNew = Math.abs(y - raised) <= 3;
    if (!nearOld && !nearNew) outside++;
  }
  assert(changed >= 4 * 16 * 2 - 8 && outside === 0, `Subrange update changed ${changed} pixels, ${outside} outside the updated points`);
  assert(red(after.at(Math.floor(project(row[30], 2, 0)[0]), Math.floor(raised))), 'Updated point did not move or recolor');
  strip.dispose();
  await settle(runtime.gpu);
  report.subrange = {positionWrites, colorWrites, changedPixels: changed};
  report.checks.push('Subrange position and color updates use one writeBuffer on exactly that byte range');

  // 6. Picking returns the right point.
  const next = random(4), pickPositions = [];
  for (let i = 0; i < 12; i++) pickPositions.push((next() - 0.5) * 8, (next() - 0.5) * 8, (next() - 0.5) * 4);
  const pickCloud = points.add(new PointCloud({positions: pickPositions, material: {size: 6}}));
  await frame();
  for (let i = 0; i < 12; i++) {
    const [x, y] = project(pickPositions[i * 3], pickPositions[i * 3 + 1], pickPositions[i * 3 + 2]);
    const hit = points.pick(x + 0.7, y - 0.4);
    assert(hit && hit.cloud === pickCloud && hit.index === i, `Pick ${i} returned ${hit?.index}`);
    assert(Math.abs(hit.position[0] - pickPositions[i * 3]) < 1e-5 && hit.distance < 1.5, 'Pick position or distance wrong');
  }
  assert(points.pick(2, 2, {radius: 1}) === null, 'Empty pick should be null');
  pickCloud.dispose();
  report.checks.push('CPU picking returns the nearest point under the cursor and null on empty space');

  // 7. Sprites: camera facing after an orbit, atlas cells, rotation, pivot, pixel units, one draw for thousands.
  const bitmap = await atlas();
  const sprites = points.add(new SpriteBatch({material: {map: bitmap, mapFilter: 'nearest', transparent: false}}));
  sprites.add({position: [0, 0, 0], size: 2});
  engine.camera.position = [7, 3, 7];
  image = await frame();
  const distance = Math.hypot(7, 3, 7), expected = 2 * PROJ / distance, quadBox = bbox(image, lit);
  assert(Math.abs(quadBox.width - expected) <= 2 && Math.abs(quadBox.height - expected) <= 2, `Sprite after orbit is ${quadBox.width}x${quadBox.height}, expected ${expected.toFixed(1)} square`);
  const cx = quadBox.x + quadBox.width / 2, cy = quadBox.y + quadBox.height / 2, q = quadBox.width / 4;
  const quadrant = (dx, dy) => image.at(Math.floor(cx + dx * q), Math.floor(cy + dy * q));
  assert(red(quadrant(-1, -1)) && green(quadrant(1, -1)) && blue(quadrant(-1, 1)) && yellow(quadrant(1, 1)), `Sprite texture orientation wrong: ${[quadrant(-1, -1), quadrant(1, -1), quadrant(-1, 1), quadrant(1, 1)].join(' | ')}`);
  sprites.set(0, {uv: atlasRect(1, 2, 2)}); image = await frame();
  assert(count(image, green) > expected * expected * 0.8 && count(image, red) === 0, 'Atlas cell 1 should show only green');
  sprites.set(0, {uv: [0, 0, 1, 1], rotation: Math.PI / 2}); image = await frame();
  assert(green(quadrant(-1, -1)) && yellow(quadrant(1, -1)) && red(quadrant(-1, 1)) && blue(quadrant(1, 1)), `Rotation by 90 degrees wrong: ${[quadrant(-1, -1), quadrant(1, -1), quadrant(-1, 1), quadrant(1, 1)].join(' | ')}`);
  engine.camera.position = [0, 0, 10];
  sprites.set(0, {rotation: 0, center: [0, 0]}); image = await frame();
  const pivotBox = bbox(image, lit);
  assert(Math.abs(pivotBox.x - 128) <= 1 && Math.abs(pivotBox.y + pivotBox.height - 128) <= 1, `Pivot [0, 0] should anchor the bottom left at the center: ${JSON.stringify(pivotBox)}`);
  sprites.material.sizeAttenuation = false;
  sprites.set(0, {center: [0.5, 0.5], size: 20, position: [0, 0, -30]}); image = await frame();
  const pixelBox = bbox(image, lit);
  assert(pixelBox.width === 20 && pixelBox.height === 20, `Pixel-size sprite is ${pixelBox.width}x${pixelBox.height}`);
  sprites.material.sizeAttenuation = true;
  sprites.clear();
  for (let i = 0; i < 5000; i++) sprites.add({position: [(next() - 0.5) * 8, (next() - 0.5) * 8, (next() - 0.5) * 8], size: 0.1, uv: atlasRect(i % 4, 2, 2)});
  image = await frame();
  assert(points.stats.sprites === 5000 && points.stats.drawCalls === 1, `5000 sprites took ${points.stats.drawCalls} draw calls`);
  assert(count(image, lit) > 3000, 'Thousands of sprites drew too little');
  sprites.clear().add({position: [0, 0, 0], size: 2});
  await settle(runtime.gpu);
  report.sprites = {orbitSize: [quadBox.width, quadBox.height], expected: +expected.toFixed(2), pivotBox, pixelBox};
  report.checks.push('Sprites face the camera after orbiting, show the right atlas cell, rotate, honor the pivot and pixel sizes; 5000 sprites in one draw call');

  // 8. Textured points with alpha test, sphere impostors, eye-dome lighting.
  sprites.visible = false;
  const textured = points.add(new PointCloud({positions: [0, 0, 0], material: {size: 32, map: await discTexture(), alphaTest: 0.5}}));
  image = await frame();
  const texturedCoverage = count(image, white), discArea = Math.PI * (0.35 * 32) ** 2;
  assert(Math.abs(texturedCoverage - discArea) < discArea * 0.1 && isBackground(image.at(113, 113)), `Textured point coverage ${texturedCoverage}, expected ${discArea.toFixed(0)}`);
  textured.material.set({map: null, alphaTest: 0, shading: 'sphere'}); image = await frame();
  const centerShade = image.at(128 - 3, 128 - 3)[0], rimShade = image.at(128 + 13, 128 + 4)[0];
  assert(centerShade > rimShade + 40, `Sphere shading has no gradient: ${centerShade} vs ${rimShade}`);
  textured.dispose();
  const layers = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) layers.push(-2 + i * 0.1, -2 + j * 0.1, i < 20 ? 0 : -1.5);
  const steps = points.add(new PointCloud({positions: layers, material: {size: 9}}));
  const flat = await frame();
  steps.material.edl = true;
  const shaded = await frame();
  // First far-layer pixel right of the near layer's last point (x = -0.1, radius 4.5 px).
  const edgeX = Math.floor(project(-0.1, 0, 0)[0] + 4.5);
  let darker = 0, same = 0;
  for (let y = 100; y < 156; y++) {
    if (shaded.at(edgeX, y)[0] < flat.at(edgeX, y)[0] - 30) darker++;
    if (Math.abs(shaded.at(80, y)[0] - flat.at(80, y)[0]) <= 2) same++;
  }
  assert(darker > 20 && same > 50, `EDL should darken the depth step only: ${darker} darker, ${same} unchanged`);
  steps.dispose();
  sprites.visible = true;
  await settle(runtime.gpu);
  report.checks.push('Textured points with alpha test, sphere impostor shading, and eye-dome lighting at depth steps');

  // 8b. Orthographic camera (@margoengine/cameras): world sizes, sphere depth, EDL and picking read the clip matrix.
  {
    sprites.visible = false;
    const projection = new CameraProjection({height: 8}), unit = SIZE / 8, at = (x, y) => [Math.floor(SIZE / 2 + x * unit), Math.floor(SIZE / 2 - y * unit)];
    engine.use(projection);
    const pair = points.add(new PointCloud({positions: [-2, 0, 0, 2, 0, -10], material: {size: 1, sizeUnits: 'world'}}));
    image = await frame();
    const left = bbox({at: (x, y) => x < 128 ? image.at(x, y) : [0, 0, 0]}, white), right = bbox({at: (x, y) => x >= 128 ? image.at(x, y) : [0, 0, 0]}, white);
    assert(Math.abs(left.width - unit) <= 1.5 && Math.abs(right.width - unit) <= 1.5, `Orthographic world sizes ${left.width} / ${right.width}, expected ${unit} at both depths`);
    pair.dispose();
    // Sphere impostor half inside a box: its curved front pokes out at the centre, its rim stays behind the face.
    const cube = engine.createMesh().setGeometry(box(2, 2, 2)).setMaterial(new PbrMaterial({color: '#ff0000', roughness: 1}));
    const boxOnly = await frame();
    const ball = points.add(new PointCloud({positions: [0, 0, 0.5], material: {size: 1.6, sizeUnits: 'world', shading: 'sphere'}}));
    image = await frame();
    const center = image.at(...at(0, 0)), rim = image.at(...at(0.72, 0)), face = boxOnly.at(...at(0.72, 0)), equal = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
    assert(!equal(center, boxOnly.at(...at(0, 0))) && white(center) && equal(rim, face), `Orthographic sphere depth: centre ${center}, rim ${rim} vs box ${face}`);
    ball.dispose(); cube.dispose();
    // Eye-dome lighting darkens the far layer next to the near one, as in perspective.
    const layers = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) layers.push(-2 + i * 0.1, -2 + j * 0.1, i < 20 ? 0 : -1.5);
    const steps = points.add(new PointCloud({positions: layers, material: {size: 9}}));
    const flat = await frame(); steps.material.edl = true; const shaded = await frame();
    const edgeX = Math.floor(SIZE / 2 - 0.1 * unit + 4.5);
    let darker = 0, same = 0;
    for (let y = 100; y < 156; y++) {
      if (shaded.at(edgeX, y)[0] < flat.at(edgeX, y)[0] - 30) darker++;
      if (Math.abs(shaded.at(80, y)[0] - flat.at(80, y)[0]) <= 2) same++;
    }
    assert(darker > 20 && same > 50, `Orthographic EDL: ${darker} darker, ${same} unchanged`);
    steps.dispose();
    // Picking: two points on one line of sight, the nearer wins (clip w is 1 for both).
    const line = points.add(new PointCloud({positions: [1, 1, -3, 1, 1, 2], material: {size: 6}}));
    await frame();
    const hit = points.pick(...at(1, 1).map(v => v + 0.5));
    assert(hit && hit.index === 1 && hit.depth > 0, `Orthographic pick returned ${hit?.index} at depth ${hit?.depth}`);
    line.dispose();
    engine.removePlugin(projection.name);
    sprites.visible = true;
    await settle(runtime.gpu);
    report.orthographic = {worldWidths: [left.width, right.width], expected: unit, sphereCenter: center, sphereRim: rim, edlDarker: darker};
    report.checks.push('Orthographic camera: world sizes ignore depth, sphere impostors write linear depth, EDL shades depth steps, picking prefers the nearer point');
  }

  // 9. Two million points: chunked, culled, and drawn within the point budget.
  const n = 2_000_000, side = Math.ceil(Math.sqrt(n)), positions = new Float32Array(n * 3), colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i % side) / side * 40 - 20, z = Math.floor(i / side) / side * 40 - 20, y = Math.sin(x * 0.4) * Math.cos(z * 0.3) * 1.5;
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    colors[i * 3] = 60 + (y + 1.5) * 60; colors[i * 3 + 1] = 120 + (y + 1.5) * 40; colors[i * 3 + 2] = 200 - (y + 1.5) * 50;
  }
  let t = performance.now();
  const terrain = new PointCloud({positions, colors, material: {size: 2}});
  const chunkMs = performance.now() - t;
  points.add(terrain);
  sprites.visible = false;
  engine.camera.position = [0, 5, 14]; engine.camera.target = [0, 0, 2];
  points.pointBudget = 500_000;
  t = performance.now(); engine.render(); await runtime.gpu.queue.onSubmittedWorkDone(); const uploadFrameMs = performance.now() - t;
  const timings = [];
  for (let i = 0; i < 3; i++) {t = performance.now(); engine.render(); await runtime.gpu.queue.onSubmittedWorkDone(); timings.push(performance.now() - t);}
  const stats = {...points.stats};
  assert(stats.pointsDrawn === Math.min(500_000, stats.pointsVisible) && stats.pointsDrawn === 500_000, `Budget not applied: ${JSON.stringify(stats)}`);
  assert(stats.blocksVisible < stats.blocks && stats.pointsVisible < n, `Culling removed nothing: ${JSON.stringify(stats)}`);
  assert(terrain.stats.pointsDrawn === 500_000, 'Cloud stats disagree');
  image = await capture.read();
  const terrainPixels = count(image, lit);
  assert(terrainPixels > SIZE * SIZE * 0.4, `Terrain covers only ${terrainPixels} pixels`);
  const centerHit = points.pick(128, 160, {radius: 4});
  assert(centerHit && centerHit.cloud === terrain && centerHit.distance <= 4, 'Picking on the 2M cloud failed');
  // Baseline: the same frame with nothing drawn (capture copy and SwiftShader overhead).
  points.pointBudget = 0;
  t = performance.now(); engine.render(); await runtime.gpu.queue.onSubmittedWorkDone(); const emptyMs = performance.now() - t;
  points.pointBudget = n;
  t = performance.now(); engine.render(); await runtime.gpu.queue.onSubmittedWorkDone(); const fullMs = performance.now() - t;
  const fullStats = {...points.stats};
  assert(fullStats.pointsDrawn === fullStats.pointsVisible, 'Full budget should draw every visible point');
  report.twoMillion = {
    chunkMs: Math.round(chunkMs), blocks: stats.blocks, blocksVisible: stats.blocksVisible, pointsVisible: stats.pointsVisible, pointsDrawn: stats.pointsDrawn,
    drawCalls: stats.drawCalls, firstFrameWithUploadMs: Math.round(uploadFrameMs), budgetFrameMs: timings.map(Math.round), fullFrameMs: Math.round(fullMs), emptyFrameMs: Math.round(emptyMs),
    fullPointsDrawn: fullStats.pointsDrawn, terrainPixels, pick: {index: centerHit.index, distance: +centerHit.distance.toFixed(2)},
  };
  terrain.dispose();
  points.pointBudget = 1_000_000;
  engine.camera.position = [0, 0, 10]; engine.camera.target = [0, 0, 0];
  sprites.visible = true;
  await settle(runtime.gpu);
  report.checks.push('2,000,000 points: chunked into blocks, frustum culled, drawn within a 500,000 point budget, picked');

  // 10. Device restoration rebuilds clouds, sprites and uploaded textures.
  sprites.set(0, {uv: atlasRect(1, 2, 2)});
  const square = points.add(new PointCloud({positions: [-3, 0, 0], material: {size: 8}}));
  image = await frame();
  const beforeReboot = [count(image, white), count(image, green)];
  await engine.rebootDevice();
  watch(runtime.gpu);
  image = await frame();
  const afterReboot = [count(image, white), count(image, green)];
  assert(beforeReboot[0] === 64 && afterReboot[0] === 64 && afterReboot[1] === beforeReboot[1] && afterReboot[1] > 500, `Reboot changed the frame: ${beforeReboot} -> ${afterReboot}`);
  await settle(runtime.gpu);
  report.checks.push('engine.rebootDevice() rebuilds point buffers, sprite buffers and textures');

  // 11. Disposal removes the pass and releases GPU resources.
  let destroyed = 0; const destroyBuffer = GPUBuffer.prototype.destroy, destroyTexture = GPUTexture.prototype.destroy;
  GPUBuffer.prototype.destroy = function () {destroyed++; return destroyBuffer.call(this);};
  GPUTexture.prototype.destroy = function () {destroyed++; return destroyTexture.call(this);};
  engine.removePlugin('points');
  GPUBuffer.prototype.destroy = destroyBuffer; GPUTexture.prototype.destroy = destroyTexture;
  let passRemoved = true;
  try {runtime.frameGraph.add({name: 'points:draw', order: 10, execute() {}})();} catch {passRemoved = false;}
  assert(passRemoved && !engine.hasPlugin('points'), 'Points pass still registered after removePlugin');
  assert(destroyed >= 10, `Disposal released only ${destroyed} resources`);
  image = await frame();
  assert(count(image, white) === 0 && count(image, green) === 0, 'Points or sprites still drawn after removePlugin');
  await settle(runtime.gpu);
  report.checks.push('removePlugin disposes the pass, buffers and textures');
  report.resourcesReleased = destroyed;
  square.dispose();
  engine.dispose();
  return report;
};

// Gallery saved as a screenshot by the runner.
window.runGallery = async () => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:640px;height:400px;display:block'; canvas.id = 'gallery'; document.body.append(canvas);
  const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 9, 22], target: [0, 0, 0], fov: 55, near: 0.5, far: 200}});
  const runtime = engineRuntime(engine), errors = [];
  runtime.gpu.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const points = new PointsPlugin({pointBudget: 600_000}); engine.use(points);
  // Terrain with eye-dome lighting.
  const side = 900, n = side * side, positions = new Float32Array(n * 3), colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i % side) / side * 30 - 15, z = Math.floor(i / side) / side * 20 - 14;
    const y = Math.sin(x * 0.5) * Math.cos(z * 0.4) * 1.6 + Math.sin(x * 1.7 + z) * 0.25 - 2;
    positions.set([x, y, z], i * 3);
    const h = (y + 4) / 4;
    colors.set([40 + h * 140, 110 + h * 90, 90 + (1 - h) * 120], i * 3);
  }
  points.add(new PointCloud({positions, colors, material: {size: 2.5, edl: true}}));
  // Sphere impostors and round and textured points.
  const balls = [], ballColors = [];
  for (let i = 0; i < 9; i++) {balls.push(-8 + i * 2, 1, 4); ballColors.push(i * 28, 120, 255 - i * 28);}
  points.add(new PointCloud({positions: balls, colors: new Uint8Array(ballColors), material: {size: 0.9, sizeUnits: 'world', shading: 'sphere'}}));
  const ring = [];
  for (let i = 0; i < 48; i++) ring.push(Math.cos(i / 48 * Math.PI * 2) * 4, 4 + Math.sin(i / 48 * Math.PI * 2) * 1.2, 0);
  points.add(new PointCloud({positions: ring, material: {size: 9, shape: 'round', color: '#ffd166'}}));
  points.add(new PointCloud({positions: [-9, 5, 0, 9, 5, 0], material: {size: 48, map: await discTexture(), alphaTest: 0.5, color: '#ef476f'}}));
  // Atlas sprites.
  const sprites = new SpriteBatch({material: new SpriteMaterial({map: await atlas(), mapFilter: 'nearest'})});
  for (let i = 0; i < 4; i++) sprites.add({position: [-4.5 + i * 3, 7, 0], size: 1.6, uv: atlasRect(i, 2, 2), rotation: i * 0.3});
  points.add(sprites);
  engine.render(); await runtime.gpu.queue.onSubmittedWorkDone();
  engine.render();
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
  const context2d = copy.getContext('2d'); context2d.drawImage(canvas, 0, 0);
  const pixels = context2d.getImageData(0, 0, copy.width, copy.height).data;
  let litPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 60) litPixels++;
  return {errors, lit: litPixels, stats: {...points.stats}};
};
