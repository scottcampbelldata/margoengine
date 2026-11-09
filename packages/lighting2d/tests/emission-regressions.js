import { webglRenderer } from '/packages/webgl2-compat/dist/preview.js';
import { Bloom } from '/packages/post/dist/bloom.js';
import { EngineKernel } from '/packages/core/dist/index.js';
import { Lighting2D } from '/packages/lighting2d/dist/index.js';
import { SoftLighting2D } from '/packages/lighting2d/dist/soft.js';
import { CookieLighting2D } from '/packages/lighting2d/dist/cookie.js';
import { GILighting2D } from '/packages/lighting2d/dist/gi.js';
import { HeightLighting2D } from '/packages/lighting2d/dist/height.js';
import { EmissiveLighting2D } from '/packages/lighting2d/dist/emissive.js';

export async function readHDR(device, source) {
  const row = Math.ceil((source.width * 8) / 256) * 256;
  const buffer = device.createBuffer({
    size: row * source.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: row }, [source.width, source.height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const values = new Uint16Array(buffer.getMappedRange());
  const output = new Float32Array(source.width * source.height * 4);
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width * 4; x++) {
      const v = values[(y * row) / 2 + x],
        e = (v >> 10) & 31,
        m = v & 1023;
      output[y * source.width * 4 + x] =
        (v & 32768 ? -1 : 1) * (e ? 2 ** (e - 15) * (1 + m / 1024) : (2 ** -14 * m) / 1024);
    }
  buffer.destroy();
  return output;
}

export async function emissionRegressions({ instance, engine, texture, read, frame, checks, width, height }) {
  const target = texture();
  const pass = EmissiveLighting2D.attach(instance, { target, bloomThreshold: 0.8 });
  const sprite = pass.addSprite({ x: 4.5, y: 4.5, radius: 1, glowRadius: 0, color: '#ff0000', intensity: 2 });
  const at = (4 * width + 4) * 4;
  // Contaminating caller content must never enter the isolated HDR image.
  const encoder = engine.gpu.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 1, 0, 1], storeOp: 'store' }],
    })
    .end();
  pass.render(target, encoder);
  engine.gpu.queue.submit([encoder.finish()]);
  let emission = await readHDR(engine.gpu, pass.emissiveTexture);
  let extraction = await readHDR(engine.gpu, pass.bloomTexture);
  checks['F10 isolated linear HDR emission exceeds one'] = {
    wrong:
      pass.emissiveTexture === target ||
      pass.emissiveTexture.format !== 'rgba16float' ||
      Math.abs(emission[at] - 3.2) > 0.003 ||
      emission.some((v, i) => i % 4 === 1 && v !== 0)
        ? 1
        : 0,
  };
  checks['F10 extracted threshold has independent HDR storage'] = {
    wrong: pass.bloomTexture === target || Math.abs(extraction[at] - 1.2) > 0.002 ? 1 : 0,
  };
  pass.bloomThreshold = 2.5;
  frame();
  emission = await readHDR(engine.gpu, pass.emissiveTexture);
  extraction = await readHDR(engine.gpu, pass.bloomTexture);
  checks['F10 global threshold is read live'] = { wrong: emission[at] !== 2 || extraction[at] !== 0 ? 1 : 0 };
  pass.bloomThreshold = 0.8;
  sprite.bloomThreshold = 3;
  frame();
  checks['F10 sprite threshold is read live'] = {
    wrong: (await readHDR(engine.gpu, pass.bloomTexture))[at] !== 0 ? 1 : 0,
  };
  sprite.bloomThreshold = 0.8;
  pass.bloom = false;
  frame();
  checks['F10 bloom off retains direct emission only'] = {
    wrong:
      (await readHDR(engine.gpu, pass.emissiveTexture))[at] !== 2 ||
      (await readHDR(engine.gpu, pass.bloomTexture))[at] !== 0
        ? 1
        : 0,
  };
  sprite.color = '#404040';
  pass.bloom = true;
  frame();
  const dimExtraction = await readHDR(engine.gpu, pass.bloomTexture);
  checks['F10 extraction thresholds actual RGB brightness'] = {
    wrong: dimExtraction[at] === 0 && dimExtraction[at + 1] === 0 && dimExtraction[at + 2] === 0 ? 0 : 1,
  };
  sprite.color = '#ff0000';
  pass.bloom = false;
  const bloomOptions = { strength: 0.8, threshold: 0.8 };
  let factories = 0,
    disposals = 0;
  pass.connectBloom(() => {
    factories++;
    const bloom = new Bloom(bloomOptions),
      dispose = bloom.dispose.bind(bloom);
    bloom.dispose = () => {
      disposals++;
      dispose();
    };
    return bloom;
  });
  frame();
  const reference = texture('rgba16float');
  const bloom = new Bloom(bloomOptions),
    commands = engine.gpu.createCommandEncoder();
  bloom.encodeImage(
    { device: engine.gpu, encoder: commands, width, height },
    pass.emissiveTexture.createView(),
    reference.createView(),
  );
  engine.gpu.queue.submit([commands.finish()]);
  const filtered = await readHDR(engine.gpu, reference),
    actual = await read(target);
  let wrong = 0;
  for (let i = 0; i < actual.length; i++) if (Math.abs(actual[i] - Math.min(1, filtered[i]) * 255) > 1) wrong++;
  checks['F10 real Bloom.encodeImage hookup matches isolated dispatch'] = { wrong };
  checks['F10 real spatial bloom reaches outside sprite'] = {
    wrong:
      filtered[(4 * width + 7) * 4] > 0 && (await readHDR(engine.gpu, pass.emissiveTexture))[(4 * width + 7) * 4] === 0
        ? 0
        : 1,
  };
  bloom.dispose();
  reference.destroy();
  pass.dispose();
  target.destroy();
  checks['F10 owns factory effect lifecycle'] = { wrong: factories === 1 && disposals === 1 ? 0 : 1 };

  const canvas = document.createElement('canvas');
  const webgl = await EngineKernel.create(canvas, { backend: 'webgl2', fallback: webglRenderer, exactSize: [16, 16] });
  for (const [name, Type] of Object.entries({
    root: Lighting2D,
    soft: SoftLighting2D,
    cookie: CookieLighting2D,
    gi: GILighting2D,
    height: HeightLighting2D,
    emissive: EmissiveLighting2D,
  })) {
    let code, help;
    try {
      Type.attach(webgl, { target: () => null });
    } catch (error) {
      code = error.code;
      help = /https?:/.test(error.message);
    }
    checks[`F25 native WebGL2 ${name} coded refusal and help`] = { wrong: code === 'unsupported' && help ? 0 : 1 };
  }
  webgl.dispose();
}
