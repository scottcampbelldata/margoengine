// Original deterministic gradient fixtures. The CPU oracle samples their quantized texels independently.
export async function presetChecks() {
  const { Engine } = await import('../../core/dist/extension.js');
  const { transitionPresets, createLivePresetTransition, createPresetTransition } = await import('../dist/presets.js');
  const { fullscreen, render } = await import('../../shared/gpu.js');
  const assert = (ok, m) => {
    if (!ok) throw new Error(m);
  };
  const W = 12,
    H = 12;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const mix = (a, b, w) => a.map((v, i) => v * (1 - w) + b[i] * w);
  let pixels = 0;
  for (const samples of [1, 4]) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const engine = await Engine.create(canvas, samples === 1 ? { exactSize: true } : {});
    const errors = [];
    engine.onError = (e) => errors.push(e.message);
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const a = engine.createScene(),
      b = engine.createScene();
    for (const [scene, blue] of [
      [a, false],
      [b, true],
    ])
      scene.use({
        name: 'gradient',
        setup() {},
        registerPasses(graph) {
          let pipeline;
          graph.add({
            name: 'gradient',
            order: 40,
            execute(c) {
              pipeline ??= render(
                c.device,
                fullscreen +
                  `@fragment fn fragment(i:Vertex)->@location(0) vec4f {let uv=i.position.xy/vec2f(${W},${H});return vec4f(${blue ? '0,uv.y,uv.x' : 'uv.x,uv.y,0'},1);}`,
                c.format,
                { multisample: c.descriptor.multisample },
              );
              const pass = c.encoder.beginRenderPass({
                colorAttachments: [{ view: c.color, loadOp: 'clear', storeOp: 'store' }],
              });
              pass.setPipeline(pipeline);
              pass.draw(3);
              pass.end();
            },
          });
        },
      });
    const target = engine.gpu.createTexture({
      size: [W, H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const read = async () => {
      const buffer = engine.gpu.createBuffer({
        size: 256 * H,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = engine.gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [W, H]);
        engine.gpu.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        return new Uint8Array(buffer.getMappedRange()).slice();
      } finally {
        buffer.destroy();
      }
    };
    const texel = (blue, u, v) => {
      const x = Math.max(0, Math.min(W - 1, Math.floor(u * W))),
        y = Math.max(0, Math.min(H - 1, Math.floor(v * H)));
      const r = Math.round(((x + 0.5) / W) * 255) / 255,
        g = Math.round(((y + 0.5) / H) * 255) / 255;
      return blue ? [0, g, r, 1] : [r, g, 0, 1];
    };
    try {
      for (const direction of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        for (const kind of transitionPresets) {
          const opts = {
            direction,
            softness: 0.015,
            color: [0.2, 0.3, 0.1, 1],
            center: [0.4, 0.6],
            strength: 1.25,
            easing: 'ease-in',
          };
          const effect = await createLivePresetTransition(engine, a, b, kind, opts);
          try {
            for (const time of [0, 0.5, 1]) {
              effect.start();
              effect.render({ delta: time, target });
              const data = await read();
              const p = time * time;
              for (let y = 0; y < H; y++)
                for (let x = 0; x < W; x++) {
                  const u = (x + 0.5) / W,
                    v = (y + 0.5) / H,
                    dx = direction[0],
                    dy = direction[1];
                  const q = [(u - 0.5) * dx + (v - 0.5) * dy + 0.5, -(u - 0.5) * dy + (v - 0.5) * dx + 0.5];
                  const world = ([s, t]) => [
                    0.5 + dx * (s - 0.5) - dy * (t - 0.5),
                    0.5 + dy * (s - 0.5) + dx * (t - 0.5),
                  ];
                  const sample = (blue, q) => texel(blue, ...world(q));
                  const coverage = ([s, t]) => smooth(-opts.softness, opts.softness, Math.min(s, t, 1 - s, 1 - t));
                  let expected;
                  if (time === 0 || time === 1) expected = texel(time === 1, u, v);
                  else
                    switch (kind) {
                      case 'slide': {
                        const next = [q[0] - 1 + p, q[1]];
                        expected = mix(texel(false, u, v), sample(true, next), coverage(next));
                        break;
                      }
                      case 'push':
                        expected = mix(
                          sample(false, [q[0] + p, q[1]]),
                          sample(true, [q[0] - 1 + p, q[1]]),
                          smooth(1 - p - opts.softness, 1 - p + opts.softness, q[0]),
                        );
                        break;
                      case 'zoom':
                        expected = mix(
                          texel(false, 0.4 + (u - 0.4) / (1 + p * 1.25), 0.6 + (v - 0.6) / (1 + p * 1.25)),
                          texel(true, 0.4 + (u - 0.4) * (1 + (1 - p) * 1.25), 0.6 + (v - 0.6) * (1 + (1 - p) * 1.25)),
                          p,
                        );
                        break;
                      case 'iris': {
                        const radius =
                          p *
                          Math.max(
                            ...[
                              [0, 0],
                              [1, 0],
                              [0, 1],
                              [1, 1],
                            ].map(([s, t]) => Math.hypot(s - 0.4, t - 0.6)),
                          );
                        expected = mix(
                          texel(false, u, v),
                          texel(true, u, v),
                          1 - smooth(radius - opts.softness, radius + opts.softness, Math.hypot(u - 0.4, v - 0.6)),
                        );
                        break;
                      }
                      case 'swirl': {
                        const rx = u - 0.4,
                          ry = v - 0.6,
                          angle =
                            Math.sin(p * Math.PI) *
                            Math.PI *
                            2 *
                            1.25 *
                            Math.max(0, 1 - Math.hypot(rx, ry) / 0.70710678);
                        const s = 0.4 + Math.cos(angle) * rx - Math.sin(angle) * ry,
                          t = 0.6 + Math.sin(angle) * rx + Math.cos(angle) * ry;
                        expected = mix(texel(false, s, t), texel(true, s, t), p);
                        break;
                      }
                      case 'fade-through-color':
                        expected =
                          p < 0.5
                            ? mix(texel(false, u, v), opts.color, p * 2)
                            : mix(opts.color, texel(true, u, v), p * 2 - 1);
                        break;
                      case 'cube': {
                        const angle = (p * Math.PI) / 2,
                          cs = Math.cos(angle),
                          sn = Math.sin(angle),
                          ro = [-3 * sn, 0, 3 * cs],
                          rd = [cs * (q[0] * 2 - 1) + 2 * sn, 1 - q[1] * 2, sn * (q[0] * 2 - 1) - 2 * cs];
                        expected = opts.color;
                        let closest = Infinity;
                        for (const [axis, plane, blue] of [
                          [2, 1, false],
                          [0, -1, true],
                        ]) {
                          const time = (plane - ro[axis]) / rd[axis],
                            hit = ro.map((r, i) => r + rd[i] * time),
                            s = blue ? hit[2] : hit[0];
                          if (time > 0 && time < closest && Math.abs(s) <= 1 && Math.abs(hit[1]) <= 1) {
                            closest = time;
                            const uv = [(s + 1) / 2, (1 - hit[1]) / 2];
                            expected = mix(opts.color, sample(blue, uv), coverage(uv));
                          }
                        }
                        break;
                      }
                      case 'page-curl': {
                        const radius = 0.15,
                          edge = 1 - p * (1 + Math.PI * radius),
                          offset = q[0] - edge;
                        expected = texel(true, u, v);
                        if (offset <= 0) expected = texel(false, u, v);
                        else if (offset <= radius) {
                          const angle = Math.asin(clamp(offset / radius)),
                            back = edge + radius * (Math.PI - angle),
                            front = edge + radius * angle;
                          if (back <= 1) {
                            const folded = sample(false, [back, q[1]]),
                              shade = 0.65 + 0.35 * Math.cos(angle);
                            const paper = folded.map((c, i) => (i === 3 ? c : (c * 0.8 + 0.2) * shade));
                            expected = mix(expected, paper, coverage([back, q[1]]));
                          } else if (front <= 1) expected = sample(false, [front, q[1]]);
                        }
                        break;
                      }
                    }
                  for (let c = 0; c < 4; c++)
                    assert(
                      Math.abs(data[y * 256 + x * 4 + c] - Math.round(expected[c] * 255)) <= 1,
                      `preset ${kind} ${samples}x dir=${direction} t=${time} ${x},${y},${c}: ${data[y * 256 + x * 4 + c]} != ${expected[c] * 255}`,
                    );
                  pixels++;
                }
            }
          } finally {
            effect.dispose();
          }
        }
      // Frozen presets validate and attach using the same function contract.
      for (const kind of transitionPresets) {
        const frozen = await createPresetTransition(engine, kind, { softness: 0, easing: 'ease-out' });
        engine.render();
        frozen.start('wipe', 1);
        engine.render({ delta: 0.5 });
        frozen.dispose();
      }
      assert(errors.length === 0, errors.join('\n'));
    } finally {
      target.destroy();
      engine.dispose();
    }
  }
  return { presetPixels: pixels, presetKinds: 8 };
}
