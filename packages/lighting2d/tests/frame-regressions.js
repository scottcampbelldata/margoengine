import { Bloom } from '/packages/post/dist/bloom.js';
import { emissionRegressions } from './emission-regressions.js';
import { HeightLighting2D, heightLightAt } from '/packages/lighting2d/dist/height.js';
import { EmissiveLighting2D, emissiveLightAt } from '/packages/lighting2d/dist/emissive.js';
import { CookieLighting2D, cookieLightAt, createSpotCookie } from '/packages/lighting2d/dist/cookie.js';
import { SoftLighting2D, softLightAt } from '/packages/lighting2d/dist/soft.js';
import { Lighting2D, lightAt, occluderEdges } from '/packages/lighting2d/dist/index.js';

export async function frameRegressions({ instance, engine, texture, read, compare, frame, checks, errors, width, height }) {
  const uploads = [];
  const trackUploads = (device) => {
    const create = device.createTexture.bind(device);
    device.createTexture = (descriptor) => {
      const image = create(descriptor);
      if (descriptor.label === 'lighting2d cookie upload') {
        const record = { destroyed: false };
        const destroy = image.destroy.bind(image);
        image.destroy = () => { record.destroyed = true; destroy(); };
        uploads.push(record);
      }
      return image;
    };
  };
  trackUploads(engine.gpu);
  let bloomFactories = 0, bloomDisposals = 0;
  engine.gpu.pushErrorScope('validation');
  const want = (sample) => {
    const values = new Float64Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      values.set(sample(x + 0.5, y + 0.5).map((v) => Math.min(1, v) * 255), (y * width + x) * 3);
    }
    return values;
  };
  const cases = [
    { Type: HeightLighting2D, label: 'height', add: (p) => p.addLight({ kind: 'directional', elevation: Math.PI / 2, intensity: 0.1 }), sample: (l, x, y) => heightLightAt(l, [], x, y) },
    { Type: EmissiveLighting2D, label: 'emissive', add: (p) => p.addSprite({ radius: 100, intensity: 0.1 }), sample: (l, x, y) => emissiveLightAt(l, x, y) },
    { Type: EmissiveLighting2D, label: 'emissive-bloom', add: (p) => {
      p.bloom = false;
      p.connectBloom(() => {
        bloomFactories++;
        const bloom = new Bloom(), dispose = bloom.dispose.bind(bloom);
        bloom.dispose = () => { bloomDisposals++; dispose(); };
        return bloom;
      });
      return p.addSprite({ radius: 100, intensity: 0.1 });
    }, sample: (l, x, y) => emissiveLightAt(l, x, y) },
    { Type: CookieLighting2D, label: 'cookie', add: (p) => p.addLight({ kind: 'directional', elevation: Math.PI / 2, intensity: 0.1, cookie: createSpotCookie(2, 1, 1), cookieWrap: 'clamp' }), sample: (l, x, y) => cookieLightAt(l, x, y) },
    { Type: SoftLighting2D, label: 'soft', add: (p) => p.addLight({ kind: 'directional', elevation: Math.PI / 2, intensity: 0.1 }), sample: (l, x, y) => softLightAt(l, x, y, []) },
    { Type: Lighting2D, label: 'root', add: (p) => p.addLight({ kind: 'directional', elevation: Math.PI / 2, intensity: 0.1 }), sample: (l, x, y) => lightAt(l, x, y) },
  ];
  const live = [];
  for (const config of cases) {
    let target = texture();
    const options = { name: `regression-${config.label}`, target: () => target };
    const pass = config.Type.attach(instance, options);
    const light = config.add(pass);
    const expected = want((x, y) => config.sample(light, x, y));
    // An earlier producer must finish before the pass. Independent submissions are erased by this clear.
    const producer = {
      name: `producer-${config.label}`,
      setup(runtime) {
        runtime.frameGraph.add({ name: this.name, order: -100, execute(c) {
          c.encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] }).end();
        } });
      },
    };
    engine.use(producer);
    frame();
    checks[`F2 ${config.label} frame command ordering`] = compare(await read(target), expected);
    engine.removePlugin(producer.name);
    frame();
    checks[`F13 ${config.label} second frame is stable`] = compare(await read(target), expected);
    target.destroy();
    target = texture('bgra8unorm');
    frame();
    const bgra = await read(target);
    for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]];
    checks[`F9 ${config.label} changes target format`] = compare(bgra, expected);
    target.destroy();
    target = texture('rgba16float');
    frame(); // Validation scope proves the pipeline also accepts an HDR attachment.
    target.destroy();
    target = texture();
    frame();
    pass.dispose();
    // Name reuse requires removal of the old plugin and its owned callback.
    const replacement = config.Type.attach(instance, options);
    const replacementLight = config.add(replacement);
    frame();
    checks[`F22 ${config.label} dispose then reattach`] = compare(await read(target), want((x, y) => config.sample(replacementLight, x, y)));
    live.push({ config, pass: replacement, light: replacementLight, target, setTarget: (t) => { target = t; } });
  }
  // F1: a queue write is not a snapshot per draw.
  {
    const target = texture(), pass = HeightLighting2D.attach(instance, { target });
    const lights = [pass.addLight({ kind: 'directional', elevation: Math.PI / 2, color: '#ff0000', intensity: 0.1 }), pass.addLight({ kind: 'directional', elevation: Math.PI / 2, color: '#0000ff', intensity: 0.2 })];
    frame();
    checks['F1 distinct uniforms for multiple height lights'] = compare(await read(target), want((x, y) => lights.reduce((s, l) => s.map((v, c) => v + heightLightAt(l, [], x, y)[c]), [0, 0, 0])));
    pass.removeLight(lights[0]);
    pass.removeLight(lights[1]);
    frame();
    checks['F13 removed height lights leave no trails'] = compare(await read(target), want(() => [0, 0, 0]));
    pass.dispose(); target.destroy();
  }
  {
    const target = texture(), pass = EmissiveLighting2D.attach(instance, { target, layer: 1 });
    for (let i = 0; i < 64; i++) pass.addSprite({ layer: 2 });
    const visible = pass.addSprite({ layer: 1, radius: 100, intensity: 0.1 });
    frame();
    checks['F21 visible 65th emissive sprite'] = compare(await read(target), want((x, y) => emissiveLightAt(visible, x, y, 1)));
    pass.removeSprite(visible); frame();
    checks['F13 removed emissive sprites leave no trails'] = compare(await read(target), want(() => [0, 0, 0]));
    pass.dispose(); target.destroy();
  }
  for (const [label, options, occluders] of [
    ['F19 floating box crossing', { x: 10, y: 0, height: 30, radius: 100 }, [{ shape: 'box', width: 10, depth: 10, elevation: 5, height: 5 }]],
    ['F20 light below pixel centre', { x: 4.5, y: 4.5, height: 0, shadows: false }, []],
    ['F21 65th height occluder', { x: 0, y: 0, height: 20, radius: 100 }, [...Array.from({ length: 64 }, () => ({ shape: 'box', offset: [1000, 1000], height: 1 })), { shape: 'box', offset: [6, 6], width: 3, depth: 20, height: 20 }]],
  ]) {
    const target = texture(), elevation = label.startsWith('F20') ? 10 : 0;
    const pass = HeightLighting2D.attach(instance, { target, elevation, occluders });
    const light = pass.addLight(options); frame();
    checks[label] = compare(await read(target), want((x, y) => heightLightAt(light, occluders, x, y, elevation)));
    pass.dispose(); target.destroy();
  }
  for (const [label, lightOptions, wall, camera] of [
    ['F17 receiver within source radius', { x: 8.5, y: 4.5, sourceRadius: 8 }, [{ shape: 'segment', from: [6, -100], to: [6, 100] }], { x: 0, y: 0, zoom: 1 }],
    ['F18 zero radius directional hard shadow', { kind: 'directional', angle: 0, sourceRadius: 0 }, [{ shape: 'segment', from: [0, 0], to: [0, 100] }], { x: 0, y: -0.4995, zoom: 1 }],
  ]) {
    const target = texture(), pass = SoftLighting2D.attach(instance, { target, camera, occluders: wall });
    const light = pass.addLight(lightOptions); frame();
    checks[label] = compare(await read(target), want((x, y) => softLightAt(light, x + camera.x, y + camera.y, occluderEdges(wall))));
    pass.dispose(); target.destroy();
  }
  for (const [entry, Type] of Object.entries({ root: Lighting2D, soft: SoftLighting2D, cookie: CookieLighting2D, height: HeightLighting2D })) {
    const target = texture(), pass = Type.attach(instance, { target, layer: 1 });
    const light = pass.addLight({ kind: 'directional', elevation: Math.PI / 2, intensity: 0.1, layers: 1 });
    const excluded = pass.addLight({ kind: 'directional', elevation: Math.PI / 2, intensity: 0.5, layers: 2 });
    void excluded;
    for (const mask of [
      { kind: 'rect', minX: 8, minY: 4, maxX: 24, maxY: 12 },
      { kind: 'circle', radius: 6 },
      { kind: 'polygon', points: [[100, 100], [110, 100], [110, 110]] },
      { kind: 'polygon', points: [[2, 2], [28, 2], [18, 7], [28, 14], [2, 14], [8, 7]] },
    ]) for (const invert of [false, true]) {
      light.mask = { ...mask, invert }; frame();
      checks[`F11 F14 F15 ${entry} ${mask.kind} invert=${invert} ${mask.points?.[0]?.[0] ?? ''}`] = compare(await read(target), want((x, y) => lightAt(light, x, y, undefined, 1)));
    }
    // Read the same mutable mask next frame, including a buffer growth past the previous polygon.
    light.mask = { kind: 'polygon', points: Array.from({ length: 80 }, (_, i) => [16 + 7 * Math.cos(i * Math.PI / 40), 8 + 7 * Math.sin(i * Math.PI / 40)]) };
    frame(); checks[`F11 ${entry} polygon storage grows`] = compare(await read(target), want((x, y) => lightAt(light, x, y, undefined, 1)));
    for (const zoom of [0, NaN, Infinity]) {
      pass.camera = { x: 0, y: 0, zoom };
      let rejected = false;
      try { frame(); } catch (error) { rejected = error instanceof RangeError; }
      checks[`F23 ${entry} rejects camera zoom ${zoom}`] = { wrong: rejected ? 0 : 1 };
    }
    pass.dispose(); target.destroy();
  }
  for (const color of ['#ffffff', '#ff8000', '#000000']) for (const cookie of [createSpotCookie(2, 1, 1), undefined]) {
    const target = texture(), pass = CookieLighting2D.attach(instance, { target });
    const light = pass.addLight({ kind: 'directional', elevation: Math.PI / 2, intensity: 0.1, cookieMode: 'color', color, cookie, cookieWrap: 'clamp' });
    frame(); checks[`F16 scalar cookie color gain ${color} cookie=${!!cookie}`] = compare(await read(target), want((x, y) => cookieLightAt(light, x, y)));
    light.mask = { kind: 'rect', minX: 100, minY: 100, maxX: 110, maxY: 110 };
    frame(); checks[`F14 cookie color honours masks ${color} cookie=${!!cookie}`] = compare(await read(target), want((x, y) => cookieLightAt(light, x, y)));
    pass.dispose(); target.destroy();
  }
  await emissionRegressions({ instance, engine, texture, read, frame, checks, width, height });
  const validation = await engine.gpu.popErrorScope();
  if (validation) errors.push(validation.message);
  const previous = engine.gpu;
  const beforeRestoreFactories = bloomFactories;
  const oldUploads = uploads.slice();
  previous.destroy(); await previous.lost; await engine.rebootDevice();
  engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  trackUploads(engine.gpu);
  engine.gpu.pushErrorScope('validation');
  checks['F8 cookie uploads destroyed on device restore'] = { wrong: oldUploads.length && oldUploads.every((record) => record.destroyed) ? 0 : 1 };
  for (const item of live) {
    item.target.destroy(); item.target = texture(); item.setTarget(item.target);
  }
  frame();
  for (const item of live) {
    const target = item.target;
    checks[`F8 F9 ${item.config.label} device restore`] = compare(await read(target), want((x, y) => item.config.sample(item.light, x, y)));
    item.pass.dispose(); target.destroy();
  }
  checks['F8 owned cookie uploads destroyed on dispose'] = { wrong: uploads.length > oldUploads.length && uploads.every((record) => record.destroyed) ? 0 : 1 };
  checks['F10 real Bloom factory recreated after restore and disposed'] = { wrong: bloomFactories === beforeRestoreFactories + 1 && bloomDisposals === bloomFactories ? 0 : 1 };
  const restoredValidation = await engine.gpu.popErrorScope();
  if (restoredValidation) errors.push(restoredValidation.message);
}
