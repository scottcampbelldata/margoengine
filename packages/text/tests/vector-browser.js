import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { SceneTarget } from '../../shared/msaa.js';
import { Text, TextRenderer } from '@margoengine/text';
import { VectorFont, VectorTextRenderer, vectorCoverage } from '@margoengine/text/vector';

// Failures are collected so the runner can save the whole report before it fails.
let failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
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
  dispose() {
    this.target?.dispose();
    this.depth?.destroy();
    this.texture?.destroy();
    this.buffer?.destroy();
    this.target = this.depth = this.texture = this.buffer = undefined;
  }
  /** Coverage of white ink per pixel (0..1), from the green channel against the cleared background. */
  async coverage() {
    await this.buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(this.buffer.getMappedRange()).slice();
    this.buffer.unmap();
    const srgb = this.format.endsWith('-srgb');
    const linear = (v) => (srgb ? ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) : v / 255);
    const out = new Float32Array(SIZE * SIZE),
      red = new Float32Array(SIZE * SIZE);
    const bg = linear(bytes[1]);
    for (let i = 0; i < SIZE * SIZE; i++) {
      out[i] = (linear(bytes[i * 4 + 1]) - bg) / (1 - bg);
      red[i] = (linear(bytes[i * 4 + (this.format.startsWith('bgra') ? 2 : 0)]) - bg) / (1 - bg);
    }
    return { green: out, red };
  }
}

// Independent reference: nonzero winding of outline segments (lines and quadratics, em units), every root solved
// with the plain quadratic formula and tested against [0, 1). Shares no code with the vector entry.
function winding(segments, x, y) {
  let w = 0;
  for (const s of segments) {
    const [x1, y1] = s,
      [x2, y2] = s.length === 6 ? [s[2], s[3]] : [(s[0] + s[2]) / 2, (s[1] + s[3]) / 2],
      [x3, y3] = s.length === 6 ? [s[4], s[5]] : [s[2], s[3]];
    const a = y1 - 2 * y2 + y3,
      b = 2 * (y2 - y1),
      c = y1 - y;
    const roots = [];
    if (Math.abs(a) < 1e-12) {
      if (b !== 0) roots.push(-c / b);
    } else {
      const d = b * b - 4 * a * c;
      if (d >= 0) roots.push((-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a));
    }
    for (const t of roots) {
      if (!(t >= 0 && t < 1)) continue;
      const u = 1 - t;
      if (u * u * x1 + 2 * t * u * x2 + t * t * x3 <= x) continue;
      const dy = 2 * a * t + b;
      if (dy) w += dy > 0 ? 1 : -1;
    }
  }
  return w;
}

/** Placed glyphs of a text in local units, with outline segments (em) and control-point hulls. */
function placed(text, font) {
  const out = [],
    size = text.fontSize;
  for (const g of text.layout.glyphs) {
    if (g.whitespace) continue;
    let pen = 0;
    for (const char of g.cluster) {
      const id = font.outlines.glyphIndex(char),
        segments = font.outlines.getGlyphSegments(id).flat();
      if (segments.length) {
        const hulls = segments.map((s) => {
          const xs = s.filter((_, i) => i % 2 === 0),
            ys = s.filter((_, i) => i % 2 === 1);
          return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        });
        const box = hulls.reduce((b, h) => [Math.min(b[0], h[0]), Math.min(b[1], h[1]), Math.max(b[2], h[2]), Math.max(b[3], h[3])]);
        out.push({ x: g.x + pen * size, y: g.y, size, segments, hulls, box });
      }
      pen += font.outlines.glyphAdvance(id);
    }
  }
  return out;
}

/**
 * 16 x 16 supersampled coverage of every canvas pixel. `toLocal(sx, sy)` maps a screen point (pixels, y down) to
 * the text's local plane. A pixel whose square no curve hull reaches is wholly inside or outside: its centre decides.
 */
function reference(glyphs, toLocal) {
  const out = new Float32Array(SIZE * SIZE),
    S = 16;
  const inside = (sx, sy) => {
    const [lx, ly] = toLocal(sx, sy);
    for (const g of glyphs) {
      const ex = (lx - g.x) / g.size,
        ey = (ly - g.y) / g.size;
      if (ex < g.box[0] || ex > g.box[2] || ey < g.box[1] || ey > g.box[3]) continue;
      if (winding(g.segments, ex, ey)) return true;
    }
    return false;
  };
  for (let py = 0; py < SIZE; py++)
    for (let px = 0; px < SIZE; px++) {
      const corners = [
        toLocal(px, py),
        toLocal(px + 1, py),
        toLocal(px, py + 1),
        toLocal(px + 1, py + 1),
      ];
      let edge = false,
        any = false;
      for (const g of glyphs) {
        const e = corners.map(([lx, ly]) => [(lx - g.x) / g.size, (ly - g.y) / g.size]);
        const lo = [Math.min(...e.map((p) => p[0])), Math.min(...e.map((p) => p[1]))],
          hi = [Math.max(...e.map((p) => p[0])), Math.max(...e.map((p) => p[1]))];
        if (hi[0] < g.box[0] || lo[0] > g.box[2] || hi[1] < g.box[1] || lo[1] > g.box[3]) continue;
        any = true;
        if (g.hulls.some((h) => h[2] >= lo[0] && h[0] <= hi[0] && h[3] >= lo[1] && h[1] <= hi[1])) {
          edge = true;
          break;
        }
      }
      if (!any) continue;
      if (!edge) {
        out[py * SIZE + px] = inside(px + 0.5, py + 0.5) ? 1 : 0;
        continue;
      }
      let n = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) if (inside(px + (i + 0.5) / S, py + (j + 0.5) / S)) n++;
      out[py * SIZE + px] = n / (S * S);
    }
  return out;
}

/**
 * Mean and max absolute error over the text's pixel box (the screen rectangle around its glyph boxes plus one pixel,
 * clipped to the canvas), and the mean over the pixels where either image has ink.
 */
function compare(gpu, ref, rect) {
  let sum = 0,
    count = 0,
    inkSum = 0,
    ink = 0,
    max = 0,
    at = -1;
  for (let py = Math.max(0, rect[1]); py < Math.min(SIZE, rect[3]); py++)
    for (let px = Math.max(0, rect[0]); px < Math.min(SIZE, rect[2]); px++) {
      const i = py * SIZE + px,
        e = Math.abs(gpu[i] - ref[i]);
      sum += e;
      count++;
      if (gpu[i] > 0.002 || ref[i] > 0) {
        inkSum += e;
        ink++;
      }
      if (e > max) {
        max = e;
        at = i;
      }
    }
  return { mean: sum / Math.max(1, count), inkMean: inkSum / Math.max(1, ink), max, pixels: count, at: [at % SIZE, Math.floor(at / SIZE)] };
}

/** Screen rectangle [x0, y0, x1, y1) around placed glyph boxes, one pixel of margin. */
function screenRect(glyphs, toScreen) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const g of glyphs)
    for (const [ex, ey] of [
      [g.box[0], g.box[1]],
      [g.box[2], g.box[1]],
      [g.box[0], g.box[3]],
      [g.box[2], g.box[3]],
    ]) {
      const [sx, sy] = toScreen(g.x + ex * g.size, g.y + ey * g.size);
      x0 = Math.min(x0, sx);
      y0 = Math.min(y0, sy);
      x1 = Math.max(x1, sx);
      y1 = Math.max(y1, sy);
    }
  return [Math.floor(x0) - 1, Math.floor(y0) - 1, Math.ceil(x1) + 1, Math.ceil(y1) + 1];
}

const screenToWorld = (sx, sy) => [(sx - SIZE / 2) / PX, (SIZE / 2 - sy) / PX];

window.runVectorTests = async () => {
  failures = [];
  const canvas = document.querySelector('#view');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, DISTANCE], target: [0, 0, 0], fov: 60, near: 0.1, far: 100 },
  });
  const runtime = engineRuntime(engine),
    report = { checks: [], backend: engine.backend, compat: !!globalThis.__margoCompat, cases: {} };
  const errors = [];
  runtime.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const capture = new Capture(),
    vector = new VectorTextRenderer(),
    sdf = new TextRenderer();
  engine.use(capture).use(vector).use(sdf);
  const frame = async () => {
    engine.render();
    report.samples = capture.target.samples;
    report.format = capture.format;
    return capture.coverage();
  };
  const load = async (name) => new Uint8Array(await (await fetch(`/tests/fixtures/fonts/${name}`)).arrayBuffer());
  const latinBytes = await load('SourceSans3-Regular.ttf'),
    cjkBytes = await load('NotoSansSC-subset.ttf');
  const latin = new VectorFont(latinBytes),
    cjk = new VectorFont(cjkBytes);
  await latin.load();
  await cjk.load();

  // 1. Coverage against the 16x16 supersampled outline, Latin and CJK, 4 to 400 px per em.
  const run = async (font, string, ppem, options = {}) => {
    const fontSize = ppem / PX,
      x0 = -SIZE / 2 / PX + (options.left ?? 3) / PX,
      y0 = options.baseline ?? -0.3 * fontSize;
    const text = vector.add(new Text({ text: string, font, fontSize, anchorX: 'left', anchorY: 'baseline', position: [x0, y0, 0] }));
    const angle = options.angle ?? 0;
    if (angle) text.setTransform([x0, y0, 0], [0, 0, angle]);
    const image = await frame();
    const glyphs = placed(text, font),
      c = Math.cos(angle),
      s = Math.sin(angle);
    const ref = reference(glyphs, (sx, sy) => {
      const [wx, wy] = screenToWorld(sx, sy),
        dx = wx - x0,
        dy = wy - y0;
      return [c * dx + s * dy, -s * dx + c * dy];
    });
    const toScreen = (lx, ly) => {
      const wx = x0 + c * lx - s * ly,
        wy = y0 + s * lx + c * ly;
      return [SIZE / 2 + wx * PX, SIZE / 2 - wy * PX];
    };
    const rect = screenRect(glyphs, toScreen),
      result = compare(image.green, ref, rect);
    if (!angle) {
      // The CPU mirror of the shader at the same pixel centres: separates GPU numerics from the method's own error.
      const mirror = new Float32Array(SIZE * SIZE);
      for (let py = 0; py < SIZE; py++)
        for (let px = 0; px < SIZE; px++) {
          const [wx, wy] = screenToWorld(px + 0.5, py + 0.5);
          let cov = 0;
          for (const g of text.layout.glyphs) {
            if (g.whitespace) continue;
            for (const part of font.clusterGlyphs(g.cluster)) {
              if (!part.glyph.bands) continue;
              const ex = (wx - x0 - g.x) / fontSize - part.x,
                ey = (wy - y0 - g.y) / fontSize,
                b = part.glyph.box;
              if (ex < b[0] - 2 / ppem || ex > b[2] + 2 / ppem || ey < b[1] - 2 / ppem || ey > b[3] + 2 / ppem) continue;
              const c = vectorCoverage(font.store, part.glyph, ex, ey, ppem, ppem, { rays: vector.rays });
              cov = cov + c - cov * c;
            }
          }
          mirror[py * SIZE + px] = cov;
        }
      result.mirror = compare(mirror, ref, rect);
      result.gpuVsMirror = compare(image.green, mirror, rect);
      let bias = 0, n = 0;
      for (let i = 0; i < SIZE * SIZE; i++) if (ref[i] > 0 || image.green[i] > 0.002) { bias += image.green[i] - ref[i]; n++; }
      result.bias = bias / n;
    }
    // Steady frame: nothing re-uploaded but the camera block.
    await frame();
    result.steady = { ...vector.stats };
    vector.remove(text);
    return { result, image, ref, text };
  };
  const bars = [];
  for (const [label, font, string] of [
    ['latin', latin, 'Hamburgefonts'],
    ['cjk', cjk, '永字八法龍鬱文'],
  ])
    for (const ppem of [4, 6, 8, 12, 48, 400]) {
      const { result } = await run(font, string, ppem, ppem === 400 ? { baseline: -SIZE / 2 / PX + 8 / PX } : {});
      report.cases[`${label} ${ppem}px`] = result;
      bars.push([`${label} ${ppem}px`, result]);
    }
  {
    const { result } = await run(latin, 'Hamburgefonts', 12, { angle: (17 * Math.PI) / 180, baseline: -1 });
    report.cases['latin 12px rotated 17deg'] = result;
    bars.push(['latin 12px rotated 17deg', result]);
    const zoom = await run(latin, 'Hm', 480, { left: -100, baseline: -SIZE / 2 / PX + 20 / PX });
    report.cases['latin 12px zoomed 40x'] = zoom.result;
    bars.push(['latin 12px zoomed 40x', zoom.result]);
  }
  for (const [name, r] of bars) {
    assert(r.pixels > 20, `${name}: only ${r.pixels} pixels compared`);
    assert(r.mean < 1 / 64, `${name}: mean coverage error ${r.mean.toFixed(4)} is not under 1/64`);
    // f32 against f64: a ray can land on the other side of an edge it passes exactly, so compare means.
    if (r.gpuVsMirror) assert(r.gpuVsMirror.mean < 0.003, `${name}: GPU differs from the CPU mirror by ${r.gpuVsMirror.mean.toFixed(4)} on average`);
    assert(r.max < 0.25, `${name}: max coverage error ${r.max.toFixed(3)} at ${r.at} is not under 0.25`);
    assert(r.steady.drawCalls === 1 && r.steady.bindGroups === 0, `${name}: steady frame ${JSON.stringify(r.steady)}`);
    assert(r.steady.bufferWrites === 1 && r.steady.bytesWritten === 112, `${name}: steady writes ${JSON.stringify(r.steady)}`);
  }
  report.checks.push(
    'Coverage matches a 16x16 supersampled outline (mean under 1/64, max under 0.25): Latin and CJK at 4, 6, 8, 12, 48 and 400 px, 17 degree rotation, 40x zoom',
    'A steady frame draws once per block, makes no bind group and writes only the 112-byte camera block',
  );

  // 2. Thin stems: every stem row of H, m and f keeps its ink (summed over the stem's columns) at 6 and 4 px, as the
  // supersampled outline has it. The SDF TextRenderer draws the same rows for comparison.
  const stems = async (renderer, font, ppem) => {
    const fontSize = ppem / PX,
      x0 = -SIZE / 2 / PX + 3.3 / PX,
      y0 = 0.37 / PX;
    const text = renderer.add(new Text({ text: 'Hmf', font, fontSize, anchorX: 'left', anchorY: 'baseline', position: [x0, y0, 0] }));
    const image = await frame(),
      glyphs = placed(text, latin),
      ref = reference(glyphs, (sx, sy) => {
        const [wx, wy] = screenToWorld(sx, sy);
        return [wx - x0, wy - y0];
      });
    const rows = [];
    for (const g of glyphs) {
      // Stems: inside runs of the outline along em height 0.25, found exactly with the reference winding.
      const runs = [];
      let start = null;
      for (let i = 0; i <= 2000; i++) {
        const ex = g.box[0] + ((g.box[2] - g.box[0]) * i) / 2000,
          ink = winding(g.segments, ex, 0.25) !== 0;
        if (ink && start === null) start = ex;
        if (!ink && start !== null) {
          runs.push([start, ex]);
          start = null;
        }
      }
      for (const [a, b] of runs)
        for (let py = 0; py < SIZE; py++) {
          const [, wy] = screenToWorld(0, py + 0.5),
            ey = (wy - y0 - g.y) / g.size;
          if (ey < 0.08 || ey > 0.4) continue;
          let sum = 0,
            want = 0;
          for (let px = 0; px < SIZE; px++) {
            const [wl] = screenToWorld(px, 0),
              [wr] = screenToWorld(px + 1, 0),
              l = (wl - x0 - g.x) / g.size,
              r = (wr - x0 - g.x) / g.size;
            if (r > a - 0.5 / ppem && l < b + 0.5 / ppem) {
              sum += image.green[py * SIZE + px];
              want += ref[py * SIZE + px];
            }
          }
          rows.push({ stem: (b - a) * ppem, sum, want });
        }
    }
    renderer.remove(text);
    return rows;
  };
  const sdfFont = new VectorFont(latinBytes, { family: 'margo-vector-stem-sdf' });
  await sdfFont.load();
  report.stems = {};
  for (const ppem of [6, 4]) {
    const v = await stems(vector, latin, ppem),
      d = await stems(sdf, sdfFont, ppem);
    const worst = (rows) => Math.max(...rows.map((r) => Math.abs(r.sum - r.want)));
    report.stems[`${ppem}px`] = {
      rows: v.length,
      stemPx: Math.min(...v.map((r) => r.stem)),
      vectorMin: Math.min(...v.map((r) => r.sum)),
      vectorWorstError: worst(v),
      sdfMin: Math.min(...d.map((r) => r.sum)),
      sdfWorstError: worst(d),
    };
    assert(v.length >= 6, `${ppem} px stem rows found: ${v.length}`);
    for (const r of v) {
      if (ppem === 6) assert(r.sum > 0.3, `a 6 px stem row has ink ${r.sum.toFixed(3)}, not above 0.3`);
      assert(Math.abs(r.sum - r.want) < 0.1, `a ${ppem} px stem row has ink ${r.sum.toFixed(3)} where the outline has ${r.want.toFixed(3)}`);
    }
  }
  report.checks.push(
    `Every stem row of H, m and f keeps its ink: above 0.3 px at 6 px, within 0.1 px of the outline at 6 and 4 px (worst ${report.stems['6px'].vectorWorstError.toFixed(3)} and ${report.stems['4px'].vectorWorstError.toFixed(3)}; SDF TextRenderer ${report.stems['6px'].sdfWorstError.toFixed(3)} and ${report.stems['4px'].sdfWorstError.toFixed(3)})`,
  );

  // 3. Dilation makes small text darker without moving it; shadows draw offset in their own colour.
  {
    const fontSize = 6 / PX,
      text = vector.add(new Text({ text: 'Hamburgefonts', font: latin, fontSize, anchorX: 'left', anchorY: 'baseline', position: [-SIZE / 2 / PX + 3 / PX, 0, 0] }));
    const total = (img) => img.green.reduce((a, b) => a + b, 0);
    const plain = total(await frame());
    vector.dilation = 0.25;
    const bold = total(await frame());
    vector.dilation = 0;
    assert(bold > plain * 1.1, `dilation 0.25 px raised ink from ${plain.toFixed(1)} to only ${bold.toFixed(1)}`);
    report.dilation = { plain, bold };
    text.set({ fontSize: 40 / PX, color: '#000000', shadowColor: '#ff0000', shadowOpacity: 1, shadowOffset: [4 / PX, -4 / PX], shadowBlur: 0 });
    const shadow = await frame();
    assert(vector.stats.drawCalls === 1, 'shadow and fill share one draw');
    let redOnly = 0;
    for (let i = 0; i < SIZE * SIZE; i++) if (shadow.red[i] > 0.9 && shadow.green[i] < 0.05) redOnly++;
    assert(redOnly > 50, `shadow pixels ${redOnly}`);
    vector.remove(text);
    report.checks.push('Dilation 0.25 px adds ink at 6 px; a hard shadow draws offset in its colour in the same draw');
  }

  // 4. Scale: 100,000 glyphs in 100 blocks, one draw per block, glyph bands shared per font.
  {
    const line = 'Hamburgefonts '.repeat(80).slice(0, 1076);
    const texts = [];
    for (let i = 0; i < 100; i++)
      texts.push(vector.add(new Text({ text: line, font: latin, fontSize: 3 / PX, maxWidth: SIZE / PX, anchorX: 'center', anchorY: 'middle', position: [0, 0, -i * 0.01] })));
    await frame();
    const first = { ...vector.stats };
    await frame();
    const steady = { ...vector.stats };
    report.scale = { first, steady, storeBytes: latin.store.length * 4 };
    assert(first.glyphs >= 100000, `scale glyphs ${first.glyphs}`);
    assert(steady.drawCalls === 100 && steady.bindGroups === 0 && steady.bufferWrites === 1, `scale steady ${JSON.stringify(steady)}`);
    for (const t of texts) vector.remove(t);
    report.checks.push(`100,000 glyphs in 100 blocks: 100 draws, steady frame ${steady.bufferWrites} write of ${steady.bytesWritten} bytes, ${report.scale.storeBytes} bytes of bands`);
  }

  // 5. Errors: a Text without a VectorFont is refused; dilation and rays are checked.
  {
    let refused = false;
    try {
      vector.add(new Text({ text: 'x' }));
    } catch (error) {
      refused = error instanceof TypeError;
    }
    assert(refused, 'a Text with a canvas Font is refused');
    let range = 0;
    for (const options of [{ dilation: 2 }, { rays: 2 }])
      try {
        new VectorTextRenderer(options);
      } catch (error) {
        if (error instanceof RangeError) range++;
      }
    assert(range === 2, 'dilation and rays are range checked');
    report.checks.push('A Text without a VectorFont, a dilation over 1 px and an even ray count are refused');
  }
  assert(!errors.length, `GPU errors: ${errors.join('; ')}`);
  engine.dispose();
  report.failures = failures;
  return report;
};
