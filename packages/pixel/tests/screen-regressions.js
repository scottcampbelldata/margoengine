// Shared real-device regressions for both screen passes. Each harness calls this before its device-loss check.
export async function screenRegressions({ instance, engine, Pass, options, read, readCanvas, texture, canvas }) {
  const checks = {},
    source = texture(1, 1, new Uint8Array([255, 0, 0, 255]));
  let target;
  const pass = Pass.attach(instance, { source, target: () => target, ...options });
  for (const [i, format] of ['rgba8unorm', 'bgra8unorm', 'rgba8unorm', 'bgra8unorm'].entries()) {
    target = engine.gpu.createTexture({
      size: [4, 4],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    instance.render({ delta: 1 / 60 });
    const bytes = await read(target),
      expected = format === 'bgra8unorm' ? [0, 0, 255, 255] : [255, 0, 0, 255];
    checks[`format switch ${i}`] = { wrong: [...bytes].filter((v, k) => v !== expected[k % 4]).length, skipped: 0 };
    target.destroy();
  }
  pass.dispose();

  const oldBackground = engine.scene.background;
  engine.scene.background = '#000000';
  for (const [name, viewport, scissor, rect] of [
    ['half scissor', [0, 0, 1, 1], [0, 0, 0.5, 1], [5, 0, 15, 30]],
    // Core rounds each normalized rectangle endpoint: round(7.5)=8, round(22.5)=23.
    ['offset scissor', [0.25, 0, 0.75, 1], [0.5, 0.25, 0.25, 0.5], [20, 8, 10, 15]],
    ['empty scissor intersection', [0, 0, 0.5, 1], [0.75, 0, 0.25, 1], [0, 0, 0, 0]],
  ]) {
    // Establish the background with a full view first; no previous scissored frame may supply untouched pixels.
    canvas.width = 40;
    instance.render({ delta: 1 / 60 });
    const screen = Pass.attach(instance, { source, ...options });
    instance.render({ delta: 1 / 60, views: [{ id: 'scissored', camera: engine.camera, viewport, scissor }] });
    const bytes = await readCanvas();
    let wrong = 0;
    for (let y = 0; y < 30; y++)
      for (let x = 0; x < 40; x++) {
        const red = x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
        if (bytes[(y * 40 + x) * 4] !== (red ? 255 : 0)) wrong++;
      }
    checks[name] = { wrong, skipped: 0 };
    screen.dispose();
  }
  engine.scene.background = oldBackground;

  // Identical names in two scenes: dispose outside either scene's render and then draw both again.
  const other = instance.createScene('screen-disposal');
  let calls = 0;
  const primary = Pass.attach(instance, { source, name: 'screen-same', ...options }),
    secondary = new Pass({
      source: () => {
        calls++;
        return source;
      },
      name: 'screen-same',
      ...options,
    });
  other.use(secondary);
  const views = [
    { camera: engine.camera, viewport: [0, 0, 0.5, 1] },
    { camera: engine.camera, scene: other, viewport: [0.5, 0, 0.5, 1] },
  ];
  instance.render({ delta: 1 / 60, views });
  const before = calls;
  secondary.dispose();
  secondary.dispose();
  instance.render({ delta: 1 / 60, views });
  checks['owning scene disposal'] = {
    wrong:
      Number(engine.scene.plugins.get(primary.name) !== primary) +
      Number(other.plugins.has(secondary.name)) +
      Number(calls !== before),
    skipped: 0,
  };
  primary.dispose();
  other.dispose();
  source.destroy();
  return checks;
}
