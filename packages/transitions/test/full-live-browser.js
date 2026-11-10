// Clean-room deterministic color fixtures. No external images or shader code.
export async function fullLiveChecks() {
  const { Engine } = await import('../../core/dist/extension.js');
  const { LiveTransitions } = await import('../dist/live.js');
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const pcg = (v) => {
    const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
    const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
    return ((w >>> 22) ^ w) >>> 0;
  };
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  let checked = 0;
  for (const samples of [1, 4]) {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 6;
    const engine = await Engine.create(canvas, samples === 1 ? { exactSize: true } : {});
    const before = engine.createScene(),
      after = engine.createScene();
    const errors = [];
    engine.onError = (e) => errors.push(e.message);
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const target = engine.gpu.createTexture({
      size: [8, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const read = async () => {
      const buffer = engine.gpu.createBuffer({
        size: 256 * 6,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = engine.gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [8, 6]);
        engine.gpu.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        return new Uint8Array(buffer.getMappedRange()).slice();
      } finally {
        buffer.destroy();
      }
    };
    try {
      const image = new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1);
      for (const kind of ['wipe', 'dissolve', 'radial', 'chromatic', 'crossfade', 'mask', 'soft-mask', 'custom']) {
        const effect =
          kind === 'custom'
            ? await LiveTransitions.custom(
                engine,
                before,
                after,
                'fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{return mix(sample(a,uv),sample(b,uv),p*p);}',
              )
            : LiveTransitions.attach(
                engine,
                before,
                after,
                kind.includes('mask') ? { mask: image, softness: kind === 'mask' ? 0 : 1 } : { kind },
              );
        try {
          for (const p of [0, 0.25, 0.5, 1]) {
            for (const swapped of [false, true]) {
              before.background = swapped ? '#00ff00' : '#ff0000';
              after.background = swapped ? '#ff0000' : '#0000ff';
              effect.start();
              effect.render({ delta: p, target });
              const bytes = await read();
              for (let y = 0; y < 6; y++)
                for (let x = 0; x < 8; x++) {
                  const u = (x + 0.5) / 8,
                    v = (y + 0.5) / 6;
                  let w = p;
                  if (kind === 'custom') w = p * p;
                  if (kind === 'wipe') w = 1 - smooth(p - 0.01, p + 0.01, u);
                  if (kind === 'dissolve')
                    w = 1 - smooth(p - 0.01, p + 0.01, (pcg((x + pcg(y)) >>> 0) >>> 8) / 16777216);
                  if (kind === 'radial')
                    w = 1 - smooth(p - 0.01, p + 0.01, (Math.atan2(u - 0.5, 0.5 - v) / (2 * Math.PI) + 1) % 1);
                  if (kind === 'mask') w = (x < 4 ? 0 : 1) <= p ? 1 : 0;
                  if (kind === 'soft-mask') w = 1 - smooth(p - 1, p + 1, x < 4 ? 0 : 1);
                  if (p === 0 || p === 1) w = p;
                  const expected = swapped ? [w, 1 - w, 0, 1] : [1 - w, 0, w, 1];
                  for (let c = 0; c < 4; c++)
                    assert(
                      Math.abs(bytes[y * 256 + x * 4 + c] - Math.round(expected[c] * 255)) <= 1,
                      `${samples}x ${kind} p=${p} ${x},${y},${c}: ${bytes[y * 256 + x * 4 + c]} expected ${expected[c] * 255}`,
                    );
                  checked++;
                }
            }
          }
        } finally {
          effect.dispose();
        }
      }
      // Compiler failures and cancellation must not attach or leak a composite scene.
      const count = engine.scenes.size;
      for (const [index, source] of [
        'invalid',
        '@group(1) @binding(0) var extra:texture_2d<f32>; fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{return textureLoad(extra,vec2i(0),0);}',
      ].entries()) {
        const create = engine.gpu.createShaderModule.bind(engine.gpu);
        if (index === 0) engine.gpu.createShaderModule = (d) => create({ ...d, label: 'expect-error:live-invalid' });
        let rejected = false;
        try {
          await LiveTransitions.custom(engine, before, after, source);
        } catch (e) {
          rejected = e.code === 'failed';
        } finally {
          engine.gpu.createShaderModule = create;
        }
        assert(rejected && engine.scenes.size === count, 'invalid custom live shader leaves no scene');
      }
      assert(!errors.length, errors.join('\n'));
    } finally {
      target.destroy();
      engine.dispose();
    }
  }
  return { fullLivePixels: checked, fullLiveKinds: 8 };
}
