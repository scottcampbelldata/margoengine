import {Engine, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {
  Lines, Line, GridHelper, PolarGridHelper, AxesHelper, Box3Helper, BoxHelper, ArrowHelper, CameraHelper, PlaneHelper, VertexNormalsHelper,
} from '@margoengine/lines';
import {Camera} from '@margoengine/core';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const SIZE = 256;

// Test-only plugin: redirects the frame into a copyable texture, then copies it to a mappable buffer.
class Capture {
  name = 'capture';
  setup(engine) {this.device = engine.gpu; this.texture = undefined;}
  registerPasses(graph) {
    graph.add({name: 'capture:redirect', order: -100, execute: context => {
      if (!this.texture) {
        this.format = context.format;
        this.texture = this.device.createTexture({size: [context.width, context.height], format: context.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
        this.buffer = this.device.createBuffer({size: context.width * context.height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        this.view = this.texture.createView();
      }
      context.color = this.view;
    }});
    graph.add({name: 'capture:copy', order: 900, execute: context => {
      context.encoder.copyTextureToBuffer({texture: this.texture}, {buffer: this.buffer, bytesPerRow: context.width * 4}, [context.width, context.height]);
    }});
  }
  onDeviceRestored(engine) {this.dispose(); this.setup(engine);}
  dispose() {this.texture?.destroy(); this.buffer?.destroy(); this.texture = this.buffer = undefined;}
  async read() {
    await this.buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(this.buffer.getMappedRange()).slice(); this.buffer.unmap();
    if (this.format.startsWith('bgra')) for (let i = 0; i < bytes.length; i += 4) {const b = bytes[i]; bytes[i] = bytes[i + 2]; bytes[i + 2] = b;}
    return {bytes, at: (x, y) => [...bytes.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)]};
  }
}

window.runLineTests = async () => {
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
  const capture = new Capture(), lines = new Lines();
  engine.use(capture).use(lines);
  const frame = async () => {engine.render(); return capture.read();};
  const bright = ([r, g, b]) => r + g + b > 300;
  const column = (image, x, test = bright) => {let n = 0; for (let y = 0; y < SIZE; y++) if (test(image.at(x, y))) n++; return n;};

  // 1. Pixel widths: a horizontal white line covers exactly `width` rows in a column.
  const line = lines.add(new Line({positions: [-3, 0, 0, 3, 0, 0], width: 10, cap: 'butt'}));
  let image = await frame();
  await settle(runtime.gpu);
  report.firstFrame = {stats: {...lines.stats}, center: image.at(128, 127)};
  const widths = {};
  // Coverage summed down the column equals the width. Blending happens on the sRGB-encoded unorm target,
  // so coverage is recovered linearly from the encoded value against the background.
  const coverage = image => {const bg = image.at(128, 0)[1]; let sum = 0; for (let y = 0; y < SIZE; y++) sum += Math.max(0, image.at(128, y)[1] - bg) / (255 - bg); return sum;};
  for (const width of [10, 4, 2.5, 1, 0.5]) {
    line.material.width = width; image = await frame();
    widths[width] = {rows: column(image, 128, ([r, g, b]) => r + g + b > 3 * 128), coverage: Math.round(coverage(image) * 100) / 100};
    assert(Math.abs(widths[width].coverage - width) < 0.3, `Pixel width ${width} covers ${widths[width].coverage}`);
  }
  assert(widths[10].rows === 10 && widths[4].rows === 4, `Pixel widths wrong: ${JSON.stringify(widths)}`);
  line.material.set({width: 1, worldUnits: true}); image = await frame();
  const expectedWorld = 0.5 * SIZE / Math.tan(Math.PI / 6) / 10;
  widths.world = column(image, 128, ([r, g, b]) => r + g + b > 3 * 128);
  assert(Math.abs(widths.world - expectedWorld) <= 1.5, `World-unit width ${widths.world}, expected about ${expectedWorld.toFixed(1)}`);
  report.widths = widths;
  // Antialiased edges: the rows just outside a 10 px line are partially covered, never full.
  line.material.set({worldUnits: false, width: 9}); image = await frame();
  const edge = image.at(128, 123)[0], inner = image.at(128, 127)[0];
  assert(edge > 20 && edge < 235 && inner > 250, `Antialiased edge ramp missing: edge ${edge}, inner ${inner}`);
  line.material.antialias = false; image = await frame();
  const hard = image.at(128, 123)[0];
  assert(hard < 20 || hard > 235, `Non-antialiased edge should be hard: ${hard}`);
  line.material.antialias = true;
  report.checks.push('Pixel and world-unit widths, antialiased edge ramp');

  // 2. Per-vertex colors: red at the left end, blue at the right end.
  line.material.set({width: 10}); line.setColors([1, 0, 0, 0, 0, 1]); image = await frame();
  const left = image.at(64, 127), right = image.at(192, 127), middle = image.at(128, 127);
  assert(left[0] > 200 && left[2] < 100 && right[2] > 200 && right[0] < 100 && left[1] < 10, `Vertex colors misplaced: ${left} / ${right}`);
  assert(middle[0] > 120 && middle[2] > 120, `Vertex colors not interpolated: ${middle}`);
  line.setColors(null);
  line.material.setColor('#00ff00'); line.material.opacity = 0.5; image = await frame();
  const half = image.at(128, 127);
  assert(half[1] > 120 && half[1] < 140, `Opacity blend wrong: ${half}`);
  line.material.opacity = 1;
  report.checks.push('Per-vertex colors, uniform color and opacity');

  // 3. Depth test against a core mesh (reversed-Z), and onTop.
  const mesh = engine.createMesh().setGeometry(box(2, 2, 2)).setMaterial(new PbrMaterial({color: '#ff0000', roughness: 1}));
  const green = ([r, g]) => g > 200 && r < 100;
  line.setPositions([-3, 0, -2, 3, 0, -2]); image = await frame();
  assert(!green(image.at(128, 127)) && green(image.at(85, 127)), `Line behind the mesh is not hidden: center ${image.at(128, 127)}, side ${image.at(85, 127)}`);
  line.setPositions([-3, 0, 2, 3, 0, 2]); image = await frame();
  assert(green(image.at(128, 127)), `Line in front of the mesh is hidden: ${image.at(128, 127)}`);
  line.setPositions([-3, 0, -2, 3, 0, -2]); line.material.onTop = true; image = await frame();
  assert(green(image.at(128, 127)), `onTop line is hidden: ${image.at(128, 127)}`);
  line.material.onTop = false;
  report.checks.push('Depth test with greater-equal against a core mesh, onTop override');

  // 4. Attached to a mesh: follows its world matrix.
  mesh.visible = false;
  const anchor = engine.createMesh(); anchor.setPosition([0, 2, 0]);
  line.setPositions([-3, 0, 0, 3, 0, 0]).attach(anchor); image = await frame();
  const lifted = 127 - Math.round(2 / (10 * Math.tan(Math.PI / 6)) * 128);
  assert(green(image.at(128, lifted)) && !green(image.at(128, 127)), 'Attached line did not follow the mesh');
  anchor.visible = false; image = await frame();
  assert(!green(image.at(128, lifted)), 'Line attached to a hidden mesh still draws');
  anchor.visible = true; line.attach(null);
  report.checks.push('Lines attached to a mesh follow its world matrix and visibility');

  // 5. Dashes produce gaps: 0.5 on, 0.5 off over 6 world units gives 6 dashes.
  line.material.set({dashed: true, dashSize: 0.5, gapSize: 0.5, cap: 'butt'}); image = await frame();
  let runs = 0, gaps = 0, previous = false;
  for (let x = 60; x < 196; x++) {const on = green(image.at(x, 127)); if (on && !previous) runs++; if (!on && previous) gaps++; previous = on;}
  assert(runs === 6 && gaps >= 5, `Dashes wrong: ${runs} dashes, ${gaps} gaps`);
  line.material.dashOffset = 0.5; const shifted = await frame();
  assert(green(shifted.at(70, 127)) !== green(image.at(70, 127)), 'dashOffset did not move the dashes');
  report.dashes = runs;
  line.material.set({dashed: false, dashOffset: 0});
  report.checks.push('Dashes with gaps and offset, measured in world space');

  // 6. Dynamic updates of the same size do not allocate.
  line.setColors([1, 1, 1, 1, 1, 1]); await frame();
  let allocations = 0; const createBuffer = runtime.gpu.createBuffer;
  runtime.gpu.createBuffer = function (...args) {allocations++; return createBuffer.apply(this, args);};
  for (let i = 0; i < 5; i++) {line.setPositions([-3, i * 0.1, 0, 3, i * 0.1, 0]); line.setColors([1, 1, 1, 1, 1, 1]); await frame();}
  runtime.gpu.createBuffer = createBuffer;
  assert(allocations === 0, `Same-size updates allocated ${allocations} buffers`);
  line.setColors(null);
  report.checks.push('Same-size dynamic updates reuse GPU buffers');

  // 7. Joins and caps on a polyline, then helpers, all without validation errors.
  const zigzag = lines.add(new Line({positions: [-3, -2, 0, -1, 1, 0, 1, -2, 0, 3, 1, 0], width: 12, join: 'round', cap: 'round', color: '#ffffff'}));
  for (const join of ['miter', 'bevel', 'round']) for (const cap of ['butt', 'square', 'round']) {zigzag.material.set({join, cap}); await frame();}
  const loop = lines.add(new Line({mode: 'loop', positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], width: 3, join: 'miter'}));
  zigzag.dispose(); loop.dispose();
  const other = new Camera({position: [3, 2, 4], target: [0, 0, 0], near: 0.5, far: 4});
  const helpers = [
    new GridHelper({size: 8, divisions: 8}), new PolarGridHelper({radius: 3}), new AxesHelper({size: 2, width: 2}),
    new Box3Helper([-1, -1, -1], [1, 1, 1]), new BoxHelper(mesh, {width: 2}), new ArrowHelper({direction: [1, 1, 0], length: 2}),
    new CameraHelper(other), new PlaneHelper({size: 3}), new VertexNormalsHelper(mesh, {size: 0.5}),
  ];
  mesh.visible = true; line.visible = false;
  const before = await frame();
  for (const helper of helpers) lines.add(helper);
  engine.camera.position = [6, 5, 9];
  image = await frame();
  let changed = 0; for (let i = 0; i < image.bytes.length; i += 4) if (Math.abs(image.bytes[i] - before.bytes[i]) + Math.abs(image.bytes[i + 1] - before.bytes[i + 1]) > 30) changed++;
  assert(changed > 2000, `Helpers drew too little: ${changed} pixels`);
  mesh.setPosition([1, 0, 0]); await frame();
  assert(Math.abs(helpers[4].points[0] - 0) < 1e-5 || Math.abs(helpers[4].points[0] - 2) < 1e-5, 'BoxHelper did not follow the mesh');
  report.helperPixels = changed; report.drawCalls = lines.stats.drawCalls;
  await settle(runtime.gpu);
  for (const helper of helpers) helper.dispose();
  engine.camera.position = [0, 0, 10]; mesh.setPosition([0, 0, 0]); mesh.visible = false; line.visible = true;
  report.checks.push('Joins (miter, bevel, round), caps (butt, square, round), loop and all nine helpers render without validation errors');

  // 8. Device restoration keeps lines rendering.
  line.setPositions([-3, 0, 0, 3, 0, 0]); line.material.set({width: 10});
  image = await frame(); const beforeReboot = column(image, 128, green);
  await engine.rebootDevice();
  watch(runtime.gpu);
  image = await frame(); const afterReboot = column(image, 128, green);
  assert(beforeReboot === 10 && afterReboot === 10, `Rebooted device lost lines: ${beforeReboot} -> ${afterReboot}`);
  await settle(runtime.gpu);
  report.checks.push('engine.rebootDevice() rebuilds line resources');

  // 9. Disposal removes the pass and releases buffers.
  let destroyed = 0; const destroy = GPUBuffer.prototype.destroy;
  GPUBuffer.prototype.destroy = function () {destroyed++; return destroy.call(this);};
  engine.removePlugin('lines');
  GPUBuffer.prototype.destroy = destroy;
  // FrameGraph rejects duplicate names, so adding 'lines:draw' succeeds only once the plugin's pass is gone.
  let passRemoved = true;
  try {runtime.frameGraph.add({name: 'lines:draw', order: 20, execute() {}})();} catch {passRemoved = false;}
  assert(passRemoved && !engine.hasPlugin('lines'), 'Line pass still registered after removePlugin');
  assert(destroyed >= 4, `Disposal released only ${destroyed} buffers`);
  image = await frame();
  assert(column(image, 128, green) === 0, 'Lines still drawn after removePlugin');
  await settle(runtime.gpu);
  report.checks.push('removePlugin disposes the pass and GPU buffers');
  report.buffersReleased = destroyed;
  engine.dispose();
  return report;
};

// Visual gallery saved as a screenshot by the runner, plus a near-plane clipping check.
window.runGallery = async () => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:480px;height:300px;display:block'; canvas.id = 'gallery'; document.body.append(canvas);
  const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: [0, 0, 12], target: [0, 0, 0], fov: 60, near: 0.5, far: 100}});
  const runtime = engineRuntime(engine), errors = [];
  runtime.gpu.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const lines = new Lines(); engine.use(lines);
  const joins = ['miter', 'bevel', 'round'], caps = ['butt', 'square', 'round'];
  for (let i = 0; i < 3; i++) {
    const x = -7 + i * 4.8, y = 2.2;
    lines.add(new Line({positions: [x, y, 0, x + 1, y + 1.6, 0, x + 2, y, 0, x + 3.4, y + 1.2, 0], width: 14, join: joins[i], cap: caps[i], color: '#e8e8e8', opacity: 0.6}));
    lines.add(new Line({positions: [x, y, 0, x + 1, y + 1.6, 0, x + 2, y, 0, x + 3.4, y + 1.2, 0], width: 1, color: '#ff3030', onTop: true}));
  }
  lines.add(new Line({positions: [-7, 0, 0, 7, 0, 0], width: 8, dashed: true, dashSize: 0.6, gapSize: 0.3, color: '#40c0ff'}));
  lines.add(new Line({mode: 'loop', positions: [-6, -1.5, 0, -2, -1.5, 0, -2, -4, 0, -6, -4, 0], width: 0.4, worldUnits: true, join: 'miter', colors: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]}));
  // A line that passes behind the camera must be clipped at the near plane, not mirrored.
  lines.add(new Line({positions: [3, -2, 30, 3, -2, -30], width: 6, color: '#30ff30'}));
  engine.render(); await runtime.gpu.queue.onSubmittedWorkDone();
  const result = {errors};
  engine.render();
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
  const context2d = copy.getContext('2d'); context2d.drawImage(canvas, 0, 0);
  const pixels = context2d.getImageData(0, 0, copy.width, copy.height).data;
  let mirrored = 0, clipped = 0;
  for (let y = 0; y < copy.height; y++) for (let x = 0; x < copy.width; x++) {
    const i = (y * copy.width + x) * 4, isGreen = pixels[i + 1] > 200 && pixels[i] < 100 && pixels[i + 2] < 100;
    if (!isGreen) continue;
    if (x < copy.width / 2 && y < copy.height / 2) mirrored++; else clipped++;
  }
  result.nearPlane = {mirrored, clipped};
  return result;
};
