import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { SceneTarget } from '../../shared/msaa.js';
import { TextRenderer, Text, Font } from '@margoengine/text';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const SIZE = 256,
  DISTANCE = 10,
  UNITS = DISTANCE * Math.tan(Math.PI / 6),
  PX = SIZE / 2 / UNITS; // pixels per world unit at z = 0

// Test-only plugin: redirects the frame into a copyable texture, then copies it to a mappable buffer.
class Capture {
  name = 'capture';
  setup(engine) {
    this.device = engine.gpu;
    this.texture = undefined;
  }
  registerPasses(graph) {
    graph.add({
      name: 'capture:redirect',
      order: -100,
      execute: (context) => {
        if (!this.texture) {
          this.format = context.format;
          this.texture = this.device.createTexture({
            size: [context.width, context.height],
            format: context.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.depth = this.device.createTexture({
            size: [context.width, context.height],
            format: context.descriptor.depthStencil.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.target = new SceneTarget(this.device, this.texture, this.depth, context.descriptor.multisample.count);
          this.buffer = this.device.createBuffer({
            size: context.width * context.height * 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
        }
        this.target.begin(context);
      },
    });
    graph.add({
      name: 'capture:copy',
      order: 900,
      execute: (context) => {
        this.target.present(context);
        context.encoder.copyTextureToBuffer(
          { texture: this.texture },
          { buffer: this.buffer, bytesPerRow: context.width * 4 },
          [context.width, context.height],
        );
      },
    });
  }
  onDeviceRestored(engine) {
    this.dispose();
    this.setup(engine);
  }
  dispose() {
    this.target?.dispose();
    this.depth?.destroy();
    this.texture?.destroy();
    this.buffer?.destroy();
    this.target = this.depth = this.texture = this.buffer = undefined;
  }
  async read() {
    await this.buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(this.buffer.getMappedRange()).slice();
    this.buffer.unmap();
    if (this.format.startsWith('bgra'))
      for (let i = 0; i < bytes.length; i += 4) {
        const b = bytes[i];
        bytes[i] = bytes[i + 2];
        bytes[i + 2] = b;
      }
    return { bytes, at: (x, y) => [...bytes.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)] };
  }
}

const white = ([r, g, b]) => r > 128 && g > 128 && b > 128;
function ink(image, test = white) {
  const background = Math.min(...image.at(0, 0).slice(0, 3));
  let count = 0,
    coverage = 0,
    minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const p = image.at(x, y);
      // Antialiased coverage, independent of where glyph edges fall inside a pixel.
      coverage += Math.max(0, Math.min(p[0], p[1], p[2]) - background) / (255 - background);
      if (test(p)) {
        count++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  return { count, coverage, minX, minY, maxX, maxY };
}
// Expected ink rectangle in screen pixels for an unrotated text at the origin, from the layout and glyph bitmaps.
function expectedInk(text) {
  const layout = text.layout,
    font = text.font,
    s = text.fontSize / font.size,
    pad = font.buffer + 1;
  let left = Infinity,
    right = -Infinity,
    top = -Infinity,
    bottom = Infinity;
  for (const g of layout.glyphs) {
    const bm = font.glyph(g.cluster);
    if (!bm) continue;
    left = Math.min(left, g.x + (bm.left + pad) * s);
    right = Math.max(right, g.x + (bm.left + bm.width - pad) * s);
    top = Math.max(top, g.y + (bm.top - pad) * s);
    bottom = Math.min(bottom, g.y + (bm.top - bm.height + pad) * s);
  }
  return {
    minX: SIZE / 2 + left * PX,
    maxX: SIZE / 2 + right * PX,
    minY: SIZE / 2 - top * PX,
    maxY: SIZE / 2 - bottom * PX,
  };
}

window.runTextTests = async () => {
  const canvas = document.querySelector('#view');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, DISTANCE], target: [0, 0, 0], fov: 60, near: 0.1, far: 100 },
  });
  const runtime = engineRuntime(engine),
    report = { checks: [], backend: engine.backend };
  const errors = [],
    modules = [];
  const watch = (device) => {
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    device.pushErrorScope('validation');
    const create = device.createShaderModule.bind(device);
    device.createShaderModule = (descriptor) => {
      const module = create(descriptor);
      modules.push(module);
      return module;
    };
  };
  const settle = async (device) => {
    const diagnostics = (await Promise.all(modules.splice(0).map((m) => m.getCompilationInfo())))
      .flatMap((info) => info.messages)
      .filter((m) => m.type === 'error');
    const validation = await device.popErrorScope();
    assert(
      !diagnostics.length && !validation && !errors.length,
      `GPU errors: ${JSON.stringify(diagnostics.map((d) => d.message))} ${validation?.message ?? ''} ${errors.join('; ')}`,
    );
    device.pushErrorScope('validation');
  };
  watch(runtime.gpu);
  const capture = new Capture(),
    renderer = new TextRenderer();
  engine.use(capture).use(renderer);
  const frame = async () => {
    engine.render();
    report.samples = capture.target.samples;
    return capture.read();
  };
  const font = new Font({ family: 'sans-serif' });

  // 1. Each anchor puts the ink where the layout says, with the same area.
  const label = renderer.add(new Text({ text: 'Hello', font, fontSize: 1.2 }));
  let image = await frame();
  await settle(runtime.gpu);
  const anchors = {};
  for (const anchorX of ['left', 'center', 'right'])
    for (const anchorY of ['top', 'middle', 'bottom', 'baseline']) {
      label.set({ anchorX, anchorY });
      image = await frame();
      const got = ink(image),
        want = expectedInk(label),
        key = `${anchorX}/${anchorY}`;
      anchors[key] = {
        count: got.count,
        coverage: Math.round(got.coverage * 10) / 10,
        box: [got.minX, got.minY, got.maxX, got.maxY],
        expected: [want.minX, want.minY, want.maxX, want.maxY].map((v) => Math.round(v * 10) / 10),
      };
      for (const [a, b] of [
        [got.minX, want.minX],
        [got.maxX, want.maxX],
        [got.minY, want.minY],
        [got.maxY, want.maxY],
      ])
        assert(
          Math.abs(a - b) <= 2.5,
          `Anchor ${key}: ink ${JSON.stringify(anchors[key].box)} vs expected ${JSON.stringify(anchors[key].expected)}`,
        );
    }
  // Thresholded pixel counts swing with sub-pixel glyph phase (more so with some system fonts), so compare antialiased coverage.
  const counts = Object.values(anchors).map((a) => a.count),
    coverage = Object.values(anchors).map((a) => a.coverage);
  assert(
    Math.min(...counts) > 250 && Math.max(...coverage) - Math.min(...coverage) <= Math.max(...coverage) * 0.06,
    `Ink coverage varies across anchors: ${coverage} (pixel counts ${counts})`,
  );
  const left = anchors['left/baseline'],
    right = anchors['right/baseline'];
  assert(
    left.box[0] >= 127 && left.box[0] <= 132 && right.box[2] >= 124 && right.box[2] <= 129,
    'left/right anchors do not meet the origin',
  );
  report.anchors = anchors;
  report.checks.push('All 12 anchor combinations place the ink within 2.5 px of the layout prediction with equal area');

  // 2. Fill, outline and shadow colors.
  label.set({
    text: 'Wg',
    fontSize: 2.5,
    anchorX: 'center',
    anchorY: 'middle',
    color: '#ff0000',
    outlineWidth: 0.12,
    outlineColor: '#00ff00',
  });
  image = await frame();
  const red = ([r, g, b]) => r > 200 && g < 60 && b < 60,
    green = ([r, g, b]) => g > 200 && r < 60 && b < 60,
    blue = ([r, g, b]) => b > 200 && r < 60 && g < 60;
  const colors = { red: ink(image, red).count, green: ink(image, green).count };
  assert(colors.red > 500 && colors.green > 300, `Fill or outline color missing: ${JSON.stringify(colors)}`);
  label.set({
    outlineWidth: 0,
    shadowOpacity: 1,
    shadowColor: '#0000ff',
    shadowOffset: [0.15, -0.15],
    shadowBlur: 0.02,
  });
  image = await frame();
  colors.shadow = ink(image, blue).count;
  colors.redWithShadow = ink(image, red).count;
  colors.greenWithoutOutline = ink(image, green).count;
  assert(
    colors.shadow > 150 && colors.greenWithoutOutline === 0,
    `Shadow missing or outline left over: ${JSON.stringify(colors)}`,
  );
  label.set({ opacity: 0.5, shadowOpacity: 0 });
  image = await frame();
  const halfRed = ink(image, ([r, g, b]) => r > 100 && r < 160 && g < 30).count;
  assert(halfRed > 300, `Opacity 0.5 did not blend: ${halfRed}`);
  // Overlapping glyph quads: every outline layer is drawn before every fill, so tight text keeps its full fill.
  label.set({ text: 'mwm', opacity: 1, letterSpacing: -0.1, outlineWidth: 0, shadowOpacity: 0 });
  image = await frame();
  const plainFill = ink(image, red).count;
  label.set({ outlineWidth: 0.14 });
  image = await frame();
  const outlinedFill = ink(image, red).count;
  assert(outlinedFill >= plainFill * 0.97, `Outlines covered neighbouring fills: ${outlinedFill} vs ${plainFill}`);
  colors.overlap = { plainFill, outlinedFill };
  label.set({ opacity: 1, color: '#ffffff', shadowOffset: [0.05, -0.05], letterSpacing: 0, outlineWidth: 0 });
  report.colors = colors;
  report.checks.push('Fill, outline and drop shadow colors render; opacity blends');

  // 3. Depth test against a core mesh with reversed-Z, and onTop.
  const mesh = engine
    .createMesh()
    .setGeometry(box(3, 3, 2))
    .setMaterial(new PbrMaterial({ color: '#ff0000', roughness: 1 }));
  label.set({ text: 'Hi', fontSize: 1 });
  label.setPosition([0, 0, -2]);
  image = await frame();
  const hidden = ink(image).count;
  label.onTop = true;
  image = await frame();
  const onTop = ink(image).count;
  label.onTop = false;
  label.setPosition([0, 0, 2]);
  image = await frame();
  const inFront = ink(image).count;
  assert(
    hidden === 0 && onTop > 50 && inFront > 100,
    `Depth test wrong: behind ${hidden}, onTop ${onTop}, in front ${inFront}`,
  );
  mesh.visible = false;
  label.setPosition([0, 0, 0]);
  report.depth = { hidden, onTop, inFront };
  report.checks.push('Text behind a mesh is hidden (greater-equal), onTop and text in front show');

  // 4. Billboard text faces the camera after orbiting; world-oriented text turns edge-on.
  label.set({ text: 'Hello', fontSize: 1.2, anchorX: 'left', anchorY: 'middle' });
  const frontal = ink(await frame());
  engine.camera.position = [DISTANCE, 0, 0.0001];
  image = await frame();
  const edgeOn = ink(image).count;
  label.billboard = true;
  image = await frame();
  const billboard = ink(image);
  engine.camera.position = [6, 4, 7];
  image = await frame();
  const oblique = ink(image);
  assert(edgeOn < 30, `World-oriented text should be edge-on: ${edgeOn}`);
  for (const [name, view] of [
    ['side', billboard],
    ['oblique', oblique],
  ]) {
    assert(
      Math.abs(view.count - frontal.count) < frontal.count * 0.12,
      `Billboard ${name} area ${view.count} vs frontal ${frontal.count}`,
    );
    assert(
      view.minX >= 126 && view.minX <= 133 && Math.abs(view.maxX - frontal.maxX) <= 4,
      `Billboard ${name} is mirrored or misplaced: ${JSON.stringify(view)}`,
    );
  }
  engine.camera.position = [0, 0, DISTANCE];
  label.billboard = false;
  report.billboard = { frontal: frontal.count, edgeOn, side: billboard.count, oblique: oblique.count };
  report.checks.push('Billboard text faces the camera from the side and an oblique orbit, not mirrored');

  // 5. Attached to a mesh: follows its world matrix and visibility.
  const anchor = engine.createMesh();
  anchor.setPosition([0, 2, 0]);
  label.attach(anchor);
  image = await frame();
  const lifted = ink(image),
    shift = (frontal.minY + frontal.maxY) / 2 - (lifted.minY + lifted.maxY) / 2;
  assert(Math.abs(shift - 2 * PX) <= 1.5, `Attached text moved ${shift} px, expected ${2 * PX}`);
  anchor.visible = false;
  image = await frame();
  assert(ink(image).count === 0, 'Text attached to a hidden mesh still draws');
  anchor.visible = true;
  const parent = engine.createMesh();
  anchor.setParent(parent);
  parent.visible = false;
  image = await frame();
  assert(ink(image).count === 0, 'Text attached below a hidden ancestor still draws');
  parent.visible = true;
  image = await frame();
  assert(ink(image).count > 0, 'Text did not return when its ancestor became visible');
  label.attach(null);
  report.checks.push('Text attached to a mesh follows its world matrix and hides with it');

  // 6. String updates of similar length reuse the GPU buffers; one draw call per block.
  label.text = 'Hello';
  await frame();
  let allocations = 0;
  const createBuffer = runtime.gpu.createBuffer;
  runtime.gpu.createBuffer = function (...args) {
    allocations++;
    return createBuffer.apply(this, args);
  };
  for (const word of ['World', 'Margo Engine', 'Text!', 'abc', 'Hello']) {
    label.text = word;
    await frame();
  }
  runtime.gpu.createBuffer = createBuffer;
  assert(allocations === 0, `String updates allocated ${allocations} buffers`);
  assert(
    renderer.stats.drawCalls === 1 && renderer.stats.texts === 1,
    `Expected one draw call: ${JSON.stringify(renderer.stats)}`,
  );
  report.checks.push('String updates reuse GPU buffers; one draw call per text block');
  await settle(runtime.gpu);

  // 7. Emoji render as color bitmaps.
  label.set({ text: '\u{1F600}\u{1F680}', fontSize: 2, anchorX: 'center', anchorY: 'middle' });
  image = await frame();
  const yellow = ink(image, ([r, g, b]) => r > 180 && g > 130 && b < 90).count;
  report.emoji = { colorGlyphs: renderer.atlas.colorGlyphs, yellowPixels: yellow };
  assert(renderer.atlas.colorGlyphs >= 1 && yellow > 100, `Emoji not drawn in color: ${JSON.stringify(report.emoji)}`);
  report.checks.push('Emoji are rasterized as color bitmaps');

  // 8. Atlas growth with many distinct glyphs; earlier glyphs survive the growth unchanged.
  label.set({ text: 'Hello', fontSize: 1.2, anchorX: 'left', anchorY: 'middle' });
  const before = await frame(),
    beforeInk = ink(before);
  const cjkFont = new Font({
    family: '"Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", sans-serif',
  });
  const probe = cjkFont.glyph('中'),
    hasCjk = probe !== null && Math.abs(cjkFont.advance('中') - 1) < 0.05;
  let chars = '';
  if (hasCjk) for (let i = 0; i < 2000; i++) chars += String.fromCodePoint(0x4e00 + i);
  else
    for (const [start, end] of [
      [0x21, 0x7e],
      [0xa1, 0x17f],
      [0x391, 0x3c9],
      [0x400, 0x4ff],
    ])
      for (let c = start; c <= end; c++) chars += String.fromCodePoint(c);
  const many = renderer.add(
    new Text({
      text: chars,
      font: hasCjk ? cjkFont : font,
      fontSize: 0.1,
      maxWidth: 11,
      anchorX: 'center',
      anchorY: 'middle',
      onTop: true,
    }),
  );
  const started = performance.now();
  image = await frame();
  const growth = {
    cjk: hasCjk,
    characters: [...chars].length,
    ...renderer.atlas,
    milliseconds: Math.round(performance.now() - started),
  };
  assert(
    growth.sdfPages >= (hasCjk ? 4 : 2) && growth.glyphs >= growth.characters * 0.95,
    `Atlas did not grow: ${JSON.stringify(growth)}`,
  );
  assert(ink(image).count > 2000, 'Many-glyph text drew too little');
  many.visible = false;
  const after = await frame(),
    afterInk = ink(after);
  let differing = 0;
  for (let i = 0; i < before.bytes.length; i += 4) if (Math.abs(before.bytes[i] - after.bytes[i]) > 2) differing++;
  assert(
    differing === 0 && afterInk.count === beforeInk.count,
    `Glyphs changed after atlas growth: ${differing} pixels differ`,
  );
  await settle(runtime.gpu);
  report.atlasGrowth = growth;
  report.checks.push(
    `Atlas grows to ${growth.sdfPages} pages for ${growth.characters} distinct ${hasCjk ? 'CJK' : 'Latin, Greek and Cyrillic'} glyphs; existing glyphs render identically afterwards`,
  );
  many.dispose();

  // 9. Device restoration rebuilds the atlas and buffers.
  image = await frame();
  const beforeReboot = ink(image).count;
  await engine.rebootDevice();
  watch(runtime.gpu);
  image = await frame();
  const afterReboot = ink(image).count;
  assert(
    beforeReboot > 300 && afterReboot === beforeReboot,
    `Rebooted device lost text: ${beforeReboot} -> ${afterReboot}`,
  );
  await settle(runtime.gpu);
  report.checks.push('engine.rebootDevice() re-uploads the atlas and rebuilds text buffers');

  // 10. Disposal removes the pass and releases buffers and atlas textures.
  let buffers = 0,
    textures = 0;
  const destroyBuffer = GPUBuffer.prototype.destroy,
    destroyTexture = GPUTexture.prototype.destroy;
  GPUBuffer.prototype.destroy = function () {
    buffers++;
    return destroyBuffer.call(this);
  };
  GPUTexture.prototype.destroy = function () {
    textures++;
    return destroyTexture.call(this);
  };
  engine.removePlugin('text');
  GPUBuffer.prototype.destroy = destroyBuffer;
  GPUTexture.prototype.destroy = destroyTexture;
  let passRemoved = true;
  try {
    runtime.frameGraph.add({ name: 'text:draw', order: 22, execute() {} })();
  } catch {
    passRemoved = false;
  }
  assert(passRemoved && !engine.hasPlugin('text'), 'Text pass still registered after removePlugin');
  assert(buffers >= 3 && textures >= 2, `Disposal released only ${buffers} buffers and ${textures} textures`);
  image = await frame();
  assert(ink(image).count === 0, 'Text still drawn after removePlugin');
  await settle(runtime.gpu);
  report.checks.push('removePlugin disposes the pass, buffers and atlas textures');
  report.released = { buffers, textures };
  engine.dispose();

  // 11. WebGL2 backend: a documented no-op that warns once.
  const glCanvas = document.createElement('canvas');
  glCanvas.width = glCanvas.height = 64;
  document.body.append(glCanvas);
  const warnings = [],
    warn = console.warn;
  console.warn = (...args) => warnings.push(String(args[0]));
  try {
    const gl = await Engine.create(glCanvas, { backend: 'webgl2' }),
      glText = new TextRenderer({ name: 'gl-text' });
    gl.use(glText);
    glText.add(new Text({ text: 'noop', font }));
    gl.render();
    gl.render();
    gl.use(new TextRenderer({ name: 'gl-text-2' }));
    gl.render();
    assert(gl.backend === 'webgl2' && glText.stats.drawCalls === 0, 'WebGL2 text should not draw');
    gl.dispose();
  } finally {
    console.warn = warn;
    glCanvas.remove();
  }
  assert(
    warnings.filter((w) => w.includes('@margoengine/text')).length === 1,
    `Expected one WebGL2 warning: ${JSON.stringify(warnings)}`,
  );
  report.checks.push('WebGL2 backend is a no-op that warns once');
  return report;
};

// Visual gallery saved as a screenshot by the runner.
window.runGallery = async () => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:880px;height:560px;display:block';
  canvas.id = 'gallery';
  document.body.append(canvas);
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 12], target: [0, 0, 0], fov: 50, near: 0.5, far: 100 },
  });
  const runtime = engineRuntime(engine),
    errors = [];
  runtime.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const renderer = new TextRenderer();
  engine.use(renderer);
  const sans = new Font({ family: 'sans-serif' }),
    serif = new Font({ family: 'serif', style: 'italic' }),
    bold = new Font({ family: 'sans-serif', weight: 700 });
  const cube = engine
    .createMesh()
    .setGeometry(box(1.6, 1.6, 1.6))
    .setMaterial(new PbrMaterial({ color: '#3060c0', roughness: 0.6 }));
  cube.setPosition([6.2, -2.6, 0]).setRotation([0.5, 0.7, 0]);
  renderer.add(
    new Text({
      text: 'Margo Engine SDF Text',
      font: bold,
      fontSize: 1.3,
      position: [-8.6, 4.6, 0],
      color: '#ffd84a',
      outlineWidth: 0.05,
      outlineColor: '#202020',
      shadowOpacity: 0.7,
      shadowBlur: 0.08,
      shadowOffset: [0.08, -0.08],
    }),
  );
  renderer.add(
    new Text({
      text: 'Crisp at any size: 12 px, 18 px and 64 px glyphs from one 48 px field',
      font: sans,
      fontSize: 0.3,
      position: [-8.6, 2.9, 0],
      color: '#e0e0e0',
    }),
  );
  renderer.add(
    new Text({
      text: 'Small print stays legible.',
      font: sans,
      fontSize: 0.2,
      position: [-8.6, 2.4, 0],
      color: '#c8c8c8',
    }),
  );
  renderer.add(
    new Text({
      text: 'Ελληνικά · Кириллица · עברית (שלום) · 日本語テキスト · é · \u{1F600}\u{1F680}',
      font: new Font({ family: 'sans-serif' }),
      fontSize: 0.42,
      position: [-8.6, 1.8, 0],
      color: '#9fe8ff',
    }),
  );
  renderer.add(
    new Text({
      text: 'Justified paragraph text wraps at a maximum width, breaking on spaces and splitting extraordinarilylongwordsthatdonotfit. Kerning pairs like AV, To and Wa are measured with the canvas.',
      font: serif,
      fontSize: 0.36,
      maxWidth: 8.2,
      textAlign: 'justify',
      lineHeight: 1.25,
      position: [-8.6, 0.6, 0],
      color: '#f4f4f4',
    }),
  );
  renderer.add(
    new Text({
      text: 'centered\nright-aligned\nlines',
      font: sans,
      fontSize: 0.38,
      textAlign: 'center',
      anchorX: 'center',
      position: [2.6, 0.6, 0],
      color: '#a0ffa0',
      outlineWidth: 0.03,
      outlineColor: '#003000',
    }),
  );
  renderer.add(
    new Text({
      text: 'Billboard label',
      font: bold,
      fontSize: 0.36,
      anchorX: 'center',
      anchorY: 'bottom',
      billboard: true,
      position: [0, 1.2, 0],
      mesh: cube,
      color: '#ffffff',
      outlineWidth: 0.04,
      outlineColor: '#000000',
    }),
  );
  renderer.add(
    new Text({
      text: 'Tilted in perspective',
      font: sans,
      fontSize: 0.6,
      anchorX: 'center',
      position: [3.4, -4.4, 0],
      rotation: [-0.9, 0.3, 0],
      color: '#ff9a6a',
    }),
  );
  renderer.add(
    new Text({
      text: 'Ag',
      font: serif,
      fontSize: 3.2,
      position: [-3.6, -0.9, 0],
      color: '#ffffff',
      outlineWidth: 0.04,
      outlineColor: '#ff3080',
    }),
  );
  renderer.add(
    new Text({
      text: 'Outline',
      font: bold,
      fontSize: 1.0,
      position: [-8.6, -2.6, 0],
      color: '#000000',
      outlineWidth: 0.08,
      outlineColor: '#ffffff',
    }),
  );
  engine.render();
  await runtime.gpu.queue.onSubmittedWorkDone();
  engine.render();
  await runtime.gpu.queue.onSubmittedWorkDone();
  return { errors, stats: { ...renderer.stats }, atlas: renderer.atlas };
};
