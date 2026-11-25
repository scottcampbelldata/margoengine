// Checks examples/cabin-hearth in a real browser by its pixels: the page loads without errors; in the hearth view the
// fire (@margoengine/vfx/fire) draws flames over the logs and lights the hearthstone a saturated firelight orange
// that falls off toward the room, and the left jamb's inner face; from outside, the moonlit log wall is not black and
// the lantern lays a warm patch on the snow under the window, as bright and as coloured as a kerosene hurricane lantern
// makes white snow (KB-CABIN-LANTERN1: predicted from physics, measured on the linear HDR frame); the patch's right edge
// is as soft as the lantern's 22 mm flame makes it (KB-CABIN-GROUNDEDGE1), both through clear glazing (`glazing=clear`);
// through the scene's frosted window no beam reaches the snow, the window glows with the light its frost lets through,
// and the patch's edge is as soft as the whole pane, as a diffuse emitter, makes it (KB-CABIN-EDGE-SOFT2); the frost
// itself, close up, glows as tau_d E(x) / pi predicts point by point, brightest beside the mullion under the lantern and
// dimmest in the far corner, and its glazing bars read dark against it (KB-CABIN-FROST2); and the
// room's light leaving through the window lights the snow under it as its radiance and form factor say
// (KB-CABIN-WINDOWGLOW1). Every number is read
// from the frame (display sRGB, a 7 x 7 px mean around each world point projected with the page's camera), never from
// the page's source; only the lantern's flicker phase is read from the page.
// `npm run test:cabin-hearth` (WebGPU; MARGO_COMPAT=1 for the WebGL2 compatibility layer). Frames are written to
// test-results/cabin-hearth-*.png.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { snowDepthAt } from '../packages/weather/dist/snow.js';
import { invertMatrix } from '../packages/math/dist/mat4.js';
import { bounceIrradiance, setBounceScales } from '../packages/clustered/dist/bounce.js';
import { weatheredWood } from '../packages/materials/dist/presets.js';

const port = 5197,
  ctx = await openBrowser({ startPath: '/examples/cabin-hearth/index.html?ui=0', port });
const errors = [];
ctx.page.on('pageerror', (e) => errors.push(e.message));
ctx.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
mkdirSync('test-results', { recursive: true });
const tag = process.env.MARGO_COMPAT === '1' ? 'compat' : 'native';
/**
 * Loads `query`, lets the temporal passes settle for 120 frames, and returns the frame, the camera matrix, the fire's
 * light points and every light's intensity on the first and the last of those frames (`intensities`). `linear` shows
 * the scene's linear radiance (the tonemap's linear curve, no exposure, grade or vignette); `lamp: false` removes the
 * lantern's light; `lamp: 'steady'` holds it at its time-averaged intensity, the kit's times the candle flicker's mean,
 * 0.9; `fire: 'steady'` holds the fire's points at theirs, the kit's times the fire flicker's mean, 0.75 (both means
 * measured in packages/sky/test/scene-kits.test.js), so TAA's history and the flickers' phases do not enter the
 * measurement. The lantern's flame (its emitter, `flameEmission` of @margoengine/clustered/flicker) is held at its mean
 * with the lamp whenever the lamp is not left flickering, or off with `flame: 0`. A frame taken while the lights flicker depends on the phase each flicker has reached when it is read,
 * which follows the frame times: the rug's fire-lit to unlit ratio read 3.05 to 3.93 on the WebGL2 layer and 3.35 to 3.90
 * on WebGPU over three runs each, and failed its bound once (KB-CABIN-RUG-RATIO1); held steady it reads 3.60 on both.
 * `hdr` (world points) also reads the frame in float there (`hdrRead`).
 */
async function frame(
  query,
  name,
  {
    linear = false,
    exposure = 0,
    lamp = true,
    fire = true,
    windowLight = true,
    flame = 'steady',
    bloom = true,
    camera,
    hdr,
  } = {},
) {
  await ctx.page.goto(`http://127.0.0.1:${port}/examples/cabin-hearth/index.html?ui=0&${query}`);
  await ctx.page.waitForSelector('#viewport[data-ready="true"]', { timeout: 180000 });
  await ctx.page.addStyleTag({ content: 'h1,#hint,nav,#status,#error{visibility:hidden!important}' });
  const intensities = await ctx.page.evaluate(
    ({ linear, exposure, lamp, fire, windowLight, flame, bloom, camera }) =>
      new Promise((done) => {
        const page = window.cabinHearth;
        if (!windowLight) page.windowLight.setLights([]);
        if (!bloom) page.bloom.options.strength = 0;
        if (camera) Object.assign(page.engine.camera, { position: [...camera.position], target: [...camera.target] });
        if (linear)
          Object.assign(page.tonemap.options, {
            curve: 'linear',
            exposure,
            contrast: 1,
            temperature: 6500,
            vignette: 0,
          });
        if (lamp !== true) {
          const group = page.groups.group('lamp'),
            light = group.lights[0];
          group.dispose();
          if (lamp === 'steady')
            page.groups.group('lamp-steady').setLights([{ ...light, intensity: page.kit.hearth.lamp.intensity * 0.9 }]);
          // The flicker stopped with its group; the flame's emitter holds the lamp's mean radiance, I / (pi r^2) x 0.9.
          const { intensity, radius } = page.kit.hearth.lamp;
          page.flame.emissiveIntensity = flame === 'steady' ? (intensity / (Math.PI * radius ** 2)) * 0.9 : flame;
        }
        if (fire === 'steady' && page.fire) {
          page.groups.group('fire').dispose();
          page.groups
            .group('fire-steady')
            .setLights(page.fire.lights.map((l) => ({ ...l, intensity: l.intensity * 0.75 })));
        }
        const read = () =>
          page.groups.names.flatMap((group) => page.groups.group(group).lights.map((l) => l.intensity));
        let n = 0,
          first;
        const tick = () => {
          if (++n === 1) first = read();
          n >= 120 ? done({ first, last: read() }) : requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { linear, exposure, lamp, fire, windowLight, flame, bloom, camera },
  );
  const matrix = await ctx.page.evaluate(() => [...window.cabinHearth.engine.camera.matrix]),
    firePoints = await ctx.page.evaluate(() => window.cabinHearth.fire?.lights.map((l) => [...l.position]) ?? []);
  const image = await decodePNG(
    await ctx.page.locator('canvas').screenshot({ path: `test-results/cabin-hearth-${name}-${tag}.png` }),
  );
  return { image, matrix, firePoints, intensities, hdr: hdr && (await hdrRead(matrix, hdr, image)) };
}
/**
 * KB-BOUNCE-FRAMETWIN1: the frame's linear radiance at each world point in float, from the HDR scene capture the
 * post stack draws into (`sceneTexture`, rgba16float), averaged over 8 frames, TAA's whole Halton jitter cycle. For each
 * point a 5 x 5 texel block round its pixel: `at`, the block interpolated bilinearly at the point's own projection
 * (texel centres at i + 0.5), and `box`, the mean of the 3 x 3 texels `colour(..., 1)` reads, for comparison with that
 * 8-bit read. A box is not the point: at the log crest the bounce changes about 5% per pixel down the log.
 */
async function hdrRead(matrix, points, image) {
  const read = await ctx.page.evaluate(
    async ({ m, points }) => {
      const { engine } = window.cabinHearth,
        device = engine.gpu,
        stack = engine.plugins.get('post:stack'),
        { format, width, height } = stack.sceneTexture,
        at = points.map(([x, y, z]) => {
          const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
            cy = m[1] * x + m[5] * y + m[9] * z + m[13],
            cw = m[3] * x + m[7] * y + m[11] * z + m[15],
            X = (cx / cw / 2 + 0.5) * width,
            Y = (0.5 - cy / cw / 2) * height;
          return { X, Y, u: Math.floor(X) - 2, v: Math.floor(Y) - 2 };
        }),
        copies = [];
      if (format !== 'rgba16float') return { format };
      // fixed-wait: 8 deliberate frames whose blocks are averaged, so the lantern's flicker reads as its mean.
      for (let f = 0; f < 8; f++) {
        if (f) await new Promise((done) => requestAnimationFrame(done));
        const encoder = device.createCommandEncoder();
        for (const { u, v } of at) {
          const buffer = device.createBuffer({
            size: 256 * 5,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          encoder.copyTextureToBuffer(
            { texture: stack.sceneTexture, origin: [u, v] },
            { buffer, bytesPerRow: 256, rowsPerImage: 5 },
            [5, 5],
          );
          copies.push(buffer);
        }
        device.queue.submit([encoder.finish()]);
      }
      const half = (h) => {
          const e = (h >> 10) & 31,
            f = h & 1023;
          return (h & 32768 ? -1 : 1) * (e ? 2 ** (e - 15) * (1 + f / 1024) : 2 ** -14 * (f / 1024));
        },
        blocks = at.map(() => new Array(75).fill(0));
      for (let i = 0; i < copies.length; i++) {
        await copies[i].mapAsync(GPUMapMode.READ);
        const h = new Uint16Array(copies[i].getMappedRange());
        for (let t = 0; t < 25; t++)
          for (let k = 0; k < 3; k++)
            blocks[i % at.length][t * 3 + k] += half(h[Math.floor(t / 5) * 128 + (t % 5) * 4 + k]) / 8;
        copies[i].unmap();
        copies[i].destroy();
      }
      return { format, width, height, at: at.map((a, i) => ({ X: a.X, Y: a.Y, block: blocks[i] })) };
    },
    { m: [...matrix], points },
  );
  assert.equal(read.format, 'rgba16float', 'the post stack captures the scene in half floats');
  assert.deepEqual([read.width, read.height], [image.width, image.height], "the HDR capture is the frame's size");
  return read.at.map(({ X, Y, block }) => {
    const texel = (i, j) => block.slice((j * 5 + i) * 3, (j * 5 + i) * 3 + 3),
      gx = X - 0.5 - (Math.floor(X) - 2),
      gy = Y - 0.5 - (Math.floor(Y) - 2),
      i0 = Math.floor(gx),
      j0 = Math.floor(gy),
      tx = gx - i0,
      ty = gy - j0,
      at = [0, 1, 2].map(
        (k) =>
          (1 - ty) * ((1 - tx) * texel(i0, j0)[k] + tx * texel(i0 + 1, j0)[k]) +
          ty * ((1 - tx) * texel(i0, j0 + 1)[k] + tx * texel(i0 + 1, j0 + 1)[k]),
      ),
      // colour()'s box is centred on the pixel round(X), round(Y): block index 2 or 3.
      bi = Math.round(X) - (Math.floor(X) - 2),
      bj = Math.round(Y) - (Math.floor(Y) - 2),
      box = [0, 1, 2].map((k) => {
        let sum = 0;
        for (let j = bj - 1; j <= bj + 1; j++) for (let i = bi - 1; i <= bi + 1; i++) sum += texel(i, j)[k];
        return sum / 9;
      });
    return { at, box };
  });
}
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Mean display colour (0 to 1) of 7 x 7 px around each world point, with its HSV, and the mean linear colour `lin`. */
function colour({ image, matrix: m }, points, r = 3) {
  const sum = [0, 0, 0],
    lin = [0, 0, 0];
  let n = 0;
  for (const [x, y, z] of points) {
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
      cy = m[1] * x + m[5] * y + m[9] * z + m[13],
      cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    assert.ok(cw > 0, `[${x}, ${y}, ${z}] is in front of the camera`);
    const u = Math.round((cx / cw / 2 + 0.5) * image.width),
      v = Math.round((0.5 - cy / cw / 2) * image.height);
    assert.ok(u >= 3 && v >= 3 && u < image.width - 3 && v < image.height - 3, `[${x}, ${y}, ${z}] is on screen`);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const i = ((v + dy) * image.width + u + dx) * 4;
        for (let k = 0; k < 3; k++) {
          sum[k] += image.data[i + k] / 255;
          lin[k] += toLinear(image.data[i + k] / 255);
        }
        n++;
      }
  }
  const c = sum.map((s) => s / n),
    max = Math.max(...c),
    span = max - Math.min(...c),
    hue = !span
      ? 0
      : max === c[0]
        ? ((c[1] - c[2]) / span + 6) % 6
        : max === c[1]
          ? (c[2] - c[0]) / span + 2
          : (c[0] - c[1]) / span + 4;
  return {
    lin: lin.map((s) => s / n),
    hue: hue * 60,
    sat: max ? span / max : 0,
    value: max,
    Y: 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]),
  };
}
/**
 * KB-CABIN-LANTERN1: the radiance a kerosene hurricane lantern gives white snow, from physics alone, for every pixel of
 * `colour`'s 7 x 7 px boxes round `points` in frame `f` (the frame's mean is over those pixels, so the prediction is
 * too: one ray per box centre read 2% over the box mean, KB-LANTERN-SHADOW-DIM1). The lantern: a 1,900 K flame (the
 * blackbody's linear sRGB from Kim et al.'s Planckian locus fit, J. Korean Phys. Soc. 41(6), 2002, and the IEC 61966-2-1
 * matrix) of 82 lm (Mills, LBNL 2003, the brightest hurricane lantern on a goniophotometer), 82 / 4 pi = 6.5 cd averaged
 * over its flicker (the page holds it steady at that mean), at the page's lantern point, by the inverse square law
 * times the kit's range window (1 - (d / 18)^4)^2 (packages/sky LANTERN_RANGE; 0.997 at these 3.5 m).
 * The snow: `@margoengine/weather/snow`'s colour and roughness, lifted by its depth at the vertices of the ground's 1 m
 * grid (planeGeometry's triangles, split from (x, z + 1) to (x + 1, z) once turned flat), shaded with the flat ground's
 * up normal (the lift moves vertices, not normals; the snow's grain tilts them, which moved this patch by 0.05%); each
 * pixel's camera ray (through its centre, from the inverse of the page's view projection) is marched to that surface.
 * The reflection: the glTF 2.0 Appendix B dielectric, diffuse (1 - F) albedo / pi and specular F D V, with D GGX
 * (Walter et al., EGSR 2007), V the height-correlated Smith term (Heitz, JCGT 3(2), 2014) and F Schlick's (1994) with F0
 * 0.04. The shadow: the lantern's light reaches a pixel's snow only if the segment from it to the lantern misses the
 * window's cross bar, mullion and sill (examples/cabin-hearth/main.ts); `lit` is the share of the light that does.
 */
function lanternOnSnow({ matrix, image }, points) {
  const T = 1900,
    x = -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.17991,
    y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683,
    [X, Z] = [x / y, (1 - x - y) / y],
    rgb = [
      3.2404542 * X - 1.5371385 - 0.4985314 * Z,
      -0.969266 * X + 1.8760108 + 0.041556 * Z,
      0.0556434 * X - 0.2040259 + 1.0572252 * Z,
    ].map((c) => Math.max(0, c)),
    candela = 82 / (4 * Math.PI),
    flame = rgb.map((c) => (c * candela) / (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2])),
    lantern = [1.2, 1.875, 1.95],
    cam = [5.2, 1.7, 13.5],
    snow = [0.9, 0.92, 0.95],
    roughness = 0.85,
    // The window's cross bar, mullion (generateWindowPane's bars, 45 mm by 50 mm, centred on the glass at z 2.45) and
    // sill, [min, max] corners.
    bars = [
      [
        [0.6, 1.4775, 2.425],
        [1.8, 1.5225, 2.475],
      ],
      [
        [1.1775, 0.95, 2.425],
        [1.2225, 2.05, 2.475],
      ],
      [
        [0.52, 0.89, 2.34],
        [1.88, 0.97, 2.76],
      ],
    ],
    vertex = (vx, vz) => snowDepthAt(vx, vz, 1, 1, { depth: 0.12, variation: 0.5, drift: 3 }),
    height = (px, pz) => {
      const ix = Math.floor(px),
        iz = Math.floor(pz),
        u = px - ix,
        w = pz - iz,
        [h00, h10, h01, h11] = [vertex(ix, iz), vertex(ix + 1, iz), vertex(ix, iz + 1), vertex(ix + 1, iz + 1)];
      return u + w <= 1 ? h00 + u * (h10 - h00) + w * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - w) * (h10 - h11);
    },
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    unit = (a) => a.map((c) => c / Math.hypot(...a)),
    inverse = invertMatrix(matrix),
    unproject = (nx, ny, nz) => {
      const h = [0, 1, 2, 3].map((r) => inverse[r] * nx + inverse[4 + r] * ny + inverse[8 + r] * nz + inverse[12 + r]);
      return h.slice(0, 3).map((c) => c / h[3]);
    },
    blocked = (p) =>
      bars.some(([lo, hi]) => {
        let t0 = 0,
          t1 = 1;
        for (let k = 0; k < 3; k++) {
          let a = (lo[k] - p[k]) / (lantern[k] - p[k]),
            b = (hi[k] - p[k]) / (lantern[k] - p[k]);
          if (a > b) [a, b] = [b, a];
          t0 = Math.max(t0, a);
          t1 = Math.min(t1, b);
        }
        return t0 <= t1;
      }),
    sum = [0, 0, 0],
    open = [0, 0, 0];
  let n = 0;
  for (const [px, py, pz] of points) {
    const cx = matrix[0] * px + matrix[4] * py + matrix[8] * pz + matrix[12],
      cy = matrix[1] * px + matrix[5] * py + matrix[9] * pz + matrix[13],
      cw = matrix[3] * px + matrix[7] * py + matrix[11] * pz + matrix[15],
      u0 = Math.round((cx / cw / 2 + 0.5) * image.width),
      v0 = Math.round((0.5 - cy / cw / 2) * image.height);
    for (let dv = -3; dv <= 3; dv++)
      for (let du = -3; du <= 3; du++) {
        // Reversed depth: NDC z 0.9 is nearer the camera than 0.2.
        const nx = ((u0 + du + 0.5) / image.width) * 2 - 1,
          ny = 1 - ((v0 + dv + 0.5) / image.height) * 2,
          near = unproject(nx, ny, 0.9),
          ray = unit(unproject(nx, ny, 0.2).map((c, i) => c - near[i]));
        let t = 0;
        while (t < 60 && cam[1] + ray[1] * t > height(cam[0] + ray[0] * t, cam[2] + ray[2] * t)) t += 0.002;
        const p = cam.map((c, i) => c + ray[i] * t),
          up = [0, 1, 0],
          toLamp = lantern.map((c, i) => c - p[i]),
          d2 = dot(toLamp, toLamp),
          l = unit(toLamp),
          v = ray.map((c) => -c),
          h = unit(l.map((c, i) => c + v[i])),
          NL = Math.max(dot(up, l), 0),
          NV = Math.max(dot(up, v), 1e-4),
          NH = dot(up, h),
          a2 = roughness ** 4,
          F = 0.04 + 0.96 * (1 - Math.max(dot(v, h), 0)) ** 5,
          D = a2 / (Math.PI * (NH * NH * (a2 - 1) + 1) ** 2),
          V = 0.5 / (NL * Math.sqrt(NV * NV * (1 - a2) + a2) + NV * Math.sqrt(NL * NL * (1 - a2) + a2)),
          window = Math.max(0, 1 - d2 ** 2 / 18 ** 4) ** 2,
          visible = blocked(p) ? 0 : 1;
        for (let k = 0; k < 3; k++) {
          const L = ((flame[k] * NL * window) / d2) * ((snow[k] * (1 - F)) / Math.PI + F * D * V);
          open[k] += L;
          sum[k] += L * visible;
        }
        n++;
      }
  }
  return { radiance: sum.map((c) => c / n), lit: open[0] ? sum[0] / open[0] : 1 };
}
// The window's geometry outside its glass: the cross bar, the mullion and the sill (main.ts), as boxes [lo, hi].
const windowBars = [
    [
      [0.6, 1.4775, 2.425],
      [1.8, 1.5225, 2.475],
    ],
    [
      [1.1775, 0.95, 2.425],
      [1.2225, 2.05, 2.475],
    ],
    [
      [0.52, 0.89, 2.34],
      [1.88, 0.97, 2.76],
    ],
  ],
  windowSill = windowBars[2],
  // The opening light's rectangle at z 2.452 (1.2 x 1.1 m), 840 patches of equal area.
  panePatches = [];
for (let a = 0; a < 30; a++)
  for (let b = 0; b < 28; b++) panePatches.push([0.6 + ((a + 0.5) * 1.2) / 30, 0.95 + ((b + 0.5) * 1.1) / 28, 2.452]);
/** Whether the segment from p to q crosses the box [lo, hi] (the slab test). */
function crossesBox(p, q, [lo, hi]) {
  let t0 = 0,
    t1 = 1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(q[k] - p[k]) < 1e-12) {
      if (p[k] < lo[k] || p[k] > hi[k]) return false;
      continue;
    }
    let a = (lo[k] - p[k]) / (q[k] - p[k]),
      b = (hi[k] - p[k]) / (q[k] - p[k]);
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  return t0 <= t1;
}
/** Whether the segment from snow point p to q (inside) passes the window's opening (x 0.6 to 1.8, y 0.97 to 2.05) at depth z. */
function inOpening(p, q, z) {
  const t = (z - p[2]) / (q[2] - p[2]),
    x = p[0] + t * (q[0] - p[0]),
    y = p[1] + t * (q[1] - p[1]);
  return x >= 0.6 && x <= 1.8 && y >= 0.97 && y <= 2.05;
}
/**
 * The window's form factor from a point outside (unit normal `n`), sum cos_p cos_q dA / (pi r^2) over the pane's 840
 * patches by midpoint quadrature: `shaded` (default) lets a patch count only where the segment to it leaves through the
 * opening's outer face (the frame, z 2.67) and passes over the sill, as physics does; without it every patch in front of
 * the receiver counts, the bare rectangle (Lambert's polygon form). KB-BOUNCE-REVEAL1: the opening light clips its
 * rectangle the same way (`recess`, `sill`), so what it lights outside is held to this.
 */
function paneFormFactor(p, n, { shaded = true } = {}) {
  let sum = 0;
  for (const q of panePatches) {
    const d = q.map((c, k) => c - p[k]),
      d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2],
      l = Math.sqrt(d2),
      cosP = (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / l,
      cosQ = -d[2] / l;
    if (cosP <= 0 || cosQ <= 0) continue;
    if (shaded && (!inOpening(p, q, 2.67) || crossesBox(p, q, windowSill))) continue;
    sum += (cosP * cosQ * ((1.2 * 1.1) / panePatches.length)) / d2;
  }
  return sum / Math.PI;
}
/**
 * KB-CABIN-SNOWBOUNCE1: the one bounce off the snow onto the outward crest of the log at (0.3, 1.35, 2.65), normal +z,
 * per unit of the source, by midpoint quadrature over the snow surface of `lanternOnSnow` (the ground's 1 m grid lifted
 * by `snowDepthAt`, up normal, diffuse albedo 0.9 / 0.92 / 0.95): E = sum albedo E_in cos_s cos_c dA / (pi r^2), each
 * element lit by E_in and seen by the crest (no surface between them: the crest's tangent plane has the wall behind it).
 * 'lantern': a point at the lantern of unit intensity, by the inverse square law, the range window (1 - (d / 18)^4)^2
 * and the cosine, through the window's opening (x 0.6 to 1.8, y 0.97 to 2.05 from its inner face at z 2.33 to its outer
 * face at z 2.67) past the cross bar, mullion and sill of `lanternOnSnow`; 2 cm elements.
 * 'pane': the window's opening at z 2.452 (1.2 x 1.1 m) of unit radiance, E_in = pi `paneFormFactor`; `shaded`
 * (default) lets the pane light a snow element only through the opening's outer face and past the sill, as physics
 * does; without it, as the bare rectangle does; 4 cm elements. `centre` (a point, with `shaded: false`) is LightBounce's
 * own model of the frosted scene: the opening's capture looks out from in front of its glazing bars, so the snow it
 * reflects is what that point sees through the opening's outer face and past the sill, and each such element takes the
 * bare rectangle's irradiance (`rectIrradiance`, the opening light's unshadowed light; KB-BOUNCE-CAPEYE1).
 * The plan's 0.096 R for the lantern is this quadrature on the unlifted ground (y = 0): 0.0986 R; the scene's snow
 * lies on drifts lifted by `snowDepthAt`, nearer the lantern and the crest.
 */
function bounceQuadrature(kind, { shaded = true, centre } = {}) {
  const lantern = [1.2, 1.875, 1.95],
    crest = [0.3, 1.35, 2.65],
    albedo = [0.9, 0.92, 0.95],
    vertex = (vx, vz) => snowDepthAt(vx, vz, 1, 1, { depth: 0.12, variation: 0.5, drift: 3 }),
    height = (px, pz) => {
      const ix = Math.floor(px),
        iz = Math.floor(pz),
        u = px - ix,
        w = pz - iz,
        [h00, h10, h01, h11] = [vertex(ix, iz), vertex(ix + 1, iz), vertex(ix, iz + 1), vertex(ix + 1, iz + 1)];
      return u + w <= 1 ? h00 + u * (h10 - h00) + w * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - w) * (h10 - h11);
    };
  const step = kind === 'lantern' ? 0.02 : 0.04,
    e = [0, 0, 0];
  for (let x = -4; x < 7; x += step)
    for (let z = 2.68; z < 20; z += step) {
      const p = [x + step / 2, 0, z + step / 2];
      p[1] = height(p[0], p[2]);
      const w = crest.map((c, k) => c - p[k]),
        r = Math.hypot(...w),
        cosS = w[1] / r,
        cosC = -w[2] / r;
      if (cosS <= 0 || cosC <= 0) continue;
      let lit = 0;
      if (kind === 'lantern') {
        if (
          !inOpening(p, lantern, 2.33) ||
          !inOpening(p, lantern, 2.67) ||
          windowBars.some((b) => crossesBox(p, lantern, b))
        )
          continue;
        const l = lantern.map((c, k) => c - p[k]),
          d = Math.hypot(...l);
        lit = (Math.max(0, 1 - (d / 18) ** 4) ** 2 * (l[1] / d)) / (d * d);
      } else {
        if (p[2] > 12) continue;
        if (centre && (!inOpening(p, centre, 2.67) || crossesBox(p, centre, windowSill))) continue;
        lit = Math.PI * paneFormFactor(p, [0, 1, 0], { shaded });
      }
      for (let k = 0; k < 3; k++) e[k] += (albedo[k] * lit * cosS * cosC * step * step) / (Math.PI * r * r);
    }
  return e;
}
/**
 * The snow surface under every pixel of `colour`'s 7 x 7 px boxes round `points`: each pixel's camera ray marched to the
 * lifted snow, as `lanternOnSnow` does (the ground's 1 m grid lifted by `snowDepthAt` at its vertices).
 */
function snowHits({ matrix, image }, points) {
  const cam = [5.2, 1.7, 13.5],
    vertex = (vx, vz) => snowDepthAt(vx, vz, 1, 1, { depth: 0.12, variation: 0.5, drift: 3 }),
    height = (px, pz) => {
      const ix = Math.floor(px),
        iz = Math.floor(pz),
        u = px - ix,
        w = pz - iz,
        [h00, h10, h01, h11] = [vertex(ix, iz), vertex(ix + 1, iz), vertex(ix, iz + 1), vertex(ix + 1, iz + 1)];
      return u + w <= 1 ? h00 + u * (h10 - h00) + w * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - w) * (h10 - h11);
    },
    inverse = invertMatrix(matrix),
    unproject = (nx, ny, nz) => {
      const h = [0, 1, 2, 3].map((r) => inverse[r] * nx + inverse[4 + r] * ny + inverse[8 + r] * nz + inverse[12 + r]);
      return h.slice(0, 3).map((c) => c / h[3]);
    },
    hits = [];
  for (const [px, py, pz] of points) {
    const cx = matrix[0] * px + matrix[4] * py + matrix[8] * pz + matrix[12],
      cy = matrix[1] * px + matrix[5] * py + matrix[9] * pz + matrix[13],
      cw = matrix[3] * px + matrix[7] * py + matrix[11] * pz + matrix[15],
      u0 = Math.round((cx / cw / 2 + 0.5) * image.width),
      v0 = Math.round((0.5 - cy / cw / 2) * image.height);
    for (let dv = -3; dv <= 3; dv++)
      for (let du = -3; du <= 3; du++) {
        const nx = ((u0 + du + 0.5) / image.width) * 2 - 1,
          ny = 1 - ((v0 + dv + 0.5) / image.height) * 2,
          near = unproject(nx, ny, 0.9),
          far = unproject(nx, ny, 0.2),
          length = Math.hypot(...far.map((c, i) => c - near[i])),
          ray = far.map((c, i) => (c - near[i]) / length);
        let t = 0;
        while (t < 60 && cam[1] + ray[1] * t > height(cam[0] + ray[0] * t, cam[2] + ray[2] * t)) t += 0.002;
        hits.push(cam.map((c, i) => c + ray[i] * t));
      }
  }
  return hits;
}
const show = (s) => `${s.hue.toFixed(0)}/${s.sat.toFixed(2)}/${s.value.toFixed(2)}`;
try {
  await ctx.page.setViewportSize({ width: 1280, height: 720 });
  const lit = await frame('view=hearth&bounce=0', 'hearth', { lamp: 'steady', fire: 'steady' }),
    dark = await frame('view=hearth&fire=0&bounce=0', 'hearth-no-fire', { lamp: 'steady' });
  // Both hearth frames hold the fire and the lantern at their means: no light changed while they settled.
  for (const f of [lit, dark])
    assert.deepEqual(f.intensities.last, f.intensities.first, 'the lights hold still while the frame settles');
  // The hearthstone top (y 0.2), in rows from the firebox's mouth toward the room.
  const row = (z) => [0.55, 0.75, 1.15, 1.35].map((x) => [x, 0.201, z]),
    mouth = colour(lit, row(-1.8)),
    mid = colour(lit, row(-1.6)),
    front = colour(lit, row(-1.43)),
    jamb = colour(lit, [
      [0.281, 0.4, -2.0],
      [0.281, 0.7, -2.0],
      [0.281, 1.0, -2.0],
    ]);
  console.log(JSON.stringify({ mouth: show(mouth), mid: show(mid), front: show(front), jamb: show(jamb) }));
  for (const [name, s] of [
    ['mouth', mouth],
    ['middle', mid],
    ['front', front],
    ['left jamb', jamb],
  ]) {
    assert.ok(s.hue >= 15 && s.hue <= 35, `${name} ${show(s)}: firelight orange`);
    assert.ok(s.sat >= 0.48, `${name} ${show(s)} is saturated, not AgX's desaturated tan`);
  }
  assert.ok(
    mouth.value > mid.value && mid.value > front.value,
    `the stone falls off: ${show(mouth)} ${show(mid)} ${show(front)}`,
  );
  assert.ok(
    front.value / mouth.value <= 0.7,
    `front / mouth ${(front.value / mouth.value).toFixed(2)}: the light falls off toward the room`,
  );
  assert.ok(mouth.value <= 0.74, `mouth ${show(mouth)} is smoke-dark stone, not a flat bright tan`);
  // The fire's own light: without it the same stone is far darker.
  assert.ok(colour(dark, row(-1.8)).Y * 4 < mouth.Y, 'the fire, not the room, lights the hearthstone');
  // Flames over the logs: the frame with the fire is much brighter just over the fuel's top than without it.
  const flames = [
    [0.85, 0.6, -2.15],
    [0.95, 0.65, -2.15],
    [1.05, 0.6, -2.15],
  ];
  assert.ok(colour(lit, flames).value - colour(dark, flames).value >= 0.3, 'the flames draw over the logs');
  // The rug before the hearth is lit by the fire and stays red (it was 0.39 in value on the A6000 with the hand rig).
  // Both frames hold the lights at their means, so the ratio is the light's, not the flickers' phases (KB-CABIN-RUG-RATIO1).
  // At the rug (1.0 to 1.3 m from the fire's two points of 4.5 x 0.568 x 0.75 = 1.9 cd each, 3.6 m from the lantern at
  // cos 0.47) the fire gives 1.10 lux before the hearthstone's lip shades it (the render keeps 0.63 of it, its shadows on
  // against off) and the lantern's 6.5 cd 0.25 lux, against 0.11 lux from the old 4.5 cd lamp in its 6 m window and
  // 0.29 lux from the 12 cd one (c904862f57). Steady, the display ratio is 3.60 on WebGPU and the WebGL2 layer alike
  // (fire-lit 0.0503, unlit 0.0140, RTX A6000), so the lantern's light leaves the bound standing.
  const rugAt = [
      [0.6, 0.167, -1.2],
      [1.2, 0.167, -1.0],
      [1.5, 0.167, -1.3],
    ],
    rug = colour(lit, rugAt),
    rugDark = colour(dark, rugAt);
  console.log(JSON.stringify({ rug: show(rug), rugNoFire: show(rugDark) }));
  assert.ok(rug.hue < 20 || rug.hue > 340, `the rug stays red (${show(rug)})`);
  assert.ok(rug.Y >= 3 * rugDark.Y, `the fire lights the rug (${show(rug)} against ${show(rugDark)} without it)`);
  // The back corner the room views look at (-1.6, floor, -1.0): at least one of the fire's points (read from the page)
  // sees it past the left jamb (x 0.06 to 0.28, y 0.15 to 1.25, z -2.425 to -1.875), so the room is lit by the fire.
  const { firePoints } = lit,
    corner = [-1.6, 0.15, -1.0],
    jambBox = [
      [0.06, 0.15, -2.425],
      [0.28, 1.25, -1.875],
    ],
    seen = firePoints.filter((q) => {
      let t0 = 0,
        t1 = 1;
      for (let k = 0; k < 3; k++) {
        const d = corner[k] - q[k];
        let a = (jambBox[0][k] - q[k]) / d,
          b = (jambBox[1][k] - q[k]) / d;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      return t0 > t1;
    });
  assert.ok(
    firePoints.length >= 2 && seen.length >= 1,
    `a fire point lights the back corner past the jamb (${JSON.stringify(firePoints)})`,
  );

  const outside = await frame('view=outside', 'outside');
  // The moon stands in front of the cabin, 17 to 45 degrees up, and every outside shot looks away from it, so the walls
  // it sees are moonlit, not backlit (they rendered black when the moon stood low behind the cabin).
  const moon = await ctx.page.evaluate(() => [...window.cabinHearth.kit.sky.night.moonDirection]),
    [mx, my, mz] = moon.map((c) => c / Math.hypot(...moon));
  assert.ok(mz > 0.4, `the moon faces the front wall (z ${mz.toFixed(2)})`);
  assert.ok(my > 0.3 && my < 0.7, `the moon stands 17 to 45 degrees up (y ${my.toFixed(2)})`);
  for (const id of [
    'cabin-window-snow',
    'cabin-push-in',
    'cabin-wireframe',
    'cabin-bare',
    'cabin-long-establish',
    'cabin-long-window',
    'cabin-long-wireframe',
    'cabin-long-orbit',
    'cabin-long-chimney',
    'cabin-long-final',
    'cabin-long-layers-all',
  ]) {
    const key = JSON.parse(readFileSync(`tools/shot/shots/${id}.json`, 'utf8')).tracks.find((t) => t.type === 'camera')
        .keys[0],
      look = key.target.map((t, i) => t - key.position[i]);
    assert.ok((look[0] * mx + look[1] * my + look[2] * mz) / Math.hypot(...look) < 0, `${id} looks away from the moon`);
  }
  // The front log wall away from the window, lit by the moon (the logs' weathered wood reflects it).
  const wall = colour(outside, [
    [-2.6, 2.2, 2.65],
    [-2.6, 1.0, 2.65],
    [2.6, 1.0, 2.65],
    [2.6, 2.2, 2.65],
  ]);
  assert.ok(wall.value >= 0.12, `the moonlit log wall ${show(wall)} is not black`);
  // The snow in front of the window is warmer than the snow in front of the bare wall beside it. The lantern (behind
  // the window at x 1.2, y 1.875, z 1.95) lights the snow past the sill's shadow, which ends about 3.6 m out (the ray
  // over the sill's outer edge, y 0.97 at z 2.76), and again past the cross bar's shadow line at about 4.5 m; the
  // mullion's shadow runs out along x 1.2, so the patch is sampled beside it. The points are given on y 0.05, but the
  // camera's low ray through them meets the snow, lifted about 0.15 m, at z 4.7 to 5.1, x 1.8 to 2.3: in the upper
  // pane's light, 0.2 m or more past that line and 3.5 m from the lantern. At these depths x -1.7 to -1.9 is past the opening's reach.
  const patchAt = [
      [1.6, 0.05, 4.2],
      [1.8, 0.05, 4.2],
      [2.0, 0.05, 4.2],
      [1.6, 0.05, 4.3],
      [1.8, 0.05, 4.3],
      [2.0, 0.05, 4.3],
    ],
    patch = colour(outside, patchAt),
    beside = colour(outside, [
      [-1.7, 0.05, 4.0],
      [-1.9, 0.05, 4.0],
      [-1.7, 0.05, 4.1],
      [-1.9, 0.05, 4.1],
    ]);
  console.log(JSON.stringify({ wall: show(wall), patch: show(patch), beside: show(beside) }));
  assert.ok(
    patch.Y > beside.Y * 1.2,
    `the lantern lights the snow before the window: ${show(patch)} (Y ${patch.Y.toFixed(3)}) against ${show(beside)} (Y ${beside.Y.toFixed(3)})`,
  );
  // It is warmer than the moonlit snow beside it (less blue for its red), and reads as firelight orange, not mauve
  // (KB-CABIN-LANTERN1: hue 322 at the kit's 4.5 cd, 3,000 K lamp; 15 at 12 cd; 10 at a hurricane lantern's 6.5 cd,
  // 1,900 K, saturation 0.39, on an RTX A6000). A lower saturation than the blue snow's stood for "warmer" until the
  // patch became a saturated orange.
  assert.ok(
    patch.lin[2] / patch.lin[0] < beside.lin[2] / beside.lin[0] && (patch.hue > 270 || patch.hue < 60),
    `the lantern's light warms the snow: ${show(patch)} against ${show(beside)}`,
  );
  // Through clear glass (the window before it frosted over, `glazing=clear`) the lantern's beam itself lies on that
  // snow and reads as firelight orange. Through the scene's frosted pane the snow there takes the pane's diffuse glow,
  // weaker than the beam it spreads, mixed with the moon's blue: warmer than the snow beside it, as checked above.
  const outsideClear = await frame('view=outside&glazing=clear', 'outside-clear'),
    patchClear = colour(outsideClear, patchAt);
  assert.ok(
    patchClear.hue < 45,
    `the lantern's patch through clear glass reads as firelight orange: ${show(patchClear)}`,
  );
  // The lantern's own light on the snow, in the linear HDR frame (no fog or falling snow in the way): the frame with it
  // less the frame without it, against the physics above, 0.2310, 0.0547, 0 against 0.2319, 0.0546, 0 on an RTX A6000,
  // natively and on the WebGL2 layer (KB-LANTERN-SHADOW-DIM1). The patch lies 0.2 m or more past the cross bar's shadow
  // line (4.5 m out), beyond the reach of the 3x3 filter and the normal offset (about 0.1 m on the snow); with the
  // lantern's shadow map off the patch reads the same to 0.0001. It used to sit 0.65 m nearer, with the top rows of its
  // boxes in that shadow: the geometry blocks 10% of their light there and the render 1.8%, since the normal offset of
  // LocalShadows (1.5 texels at the receiver, 4 cm up at this distance with 256 px faces) moves the shadow's edge 6 cm
  // toward the wall. That loss was read as cube-map filtering darkening a lit point, and the box mean, 2% under one ray
  // through each box centre, as the specular's share. The tolerance is the measurement's own: the lantern-only patch read
  // the same to 0.0001 over two renders of each frame on each backend (eight pairings), three times that, plus half an
  // 8-bit code of each of the two frames at the channel's level, the finest the canvas readback resolves.
  // KB-CABIN-LANTERN1 and KB-CABIN-GROUNDEDGE1 are the lantern's beam through clear glazing (the window before its
  // frost, `glazing=clear`); the scene's own frosted window stops that beam (KB-CABIN-EDGE-SOFT2, below).
  // The right jamb's edge profile's points (KB-CABIN-GROUNDEDGE1, below), read in float with both frames
  // (KB-CABIN-EDGEPHASE1).
  const lampAt = [1.2, 1.95],
    jambCorner = [1.8, 2.67],
    reach = Math.hypot(jambCorner[0] - lampAt[0], jambCorner[1] - lampAt[1]),
    along = [(jambCorner[0] - lampAt[0]) / reach, (jambCorner[1] - lampAt[1]) / reach],
    across = [along[1], -along[0]],
    hr = 6,
    edgeAt = [lampAt[0] + along[0] * hr, lampAt[1] + along[1] * hr],
    snowY = (x, z) => snowDepthAt(x, z, 1, 1, { depth: 0.12, variation: 0.5, drift: 3 }),
    profilePoints = [];
  for (let step = 0; step <= 120; step++) {
    const x = edgeAt[0] + across[0] * (-0.3 + 0.005 * step),
      z = edgeAt[1] + across[1] * (-0.3 + 0.005 * step);
    profilePoints.push([x, snowY(x, z), z]);
  }
  const bare = 'view=outside&fog=0&snow=0&bounce=0',
    clearGlass = `${bare}&glazing=clear`,
    withLantern = await frame(clearGlass, 'outside-linear-clear', { linear: true, lamp: 'steady', hdr: profilePoints }),
    clearOpening = await ctx.page.evaluate(() => window.cabinHearth.windowLight.list[0]),
    withoutLantern = await frame(clearGlass, 'outside-linear-clear-no-lantern', {
      linear: true,
      lamp: false,
      hdr: profilePoints,
    }),
    litPatch = colour(withLantern, patchAt).lin,
    unlitPatch = colour(withoutLantern, patchAt).lin,
    measured = [0, 1, 2].map((k) => litPatch[k] - unlitPatch[k]),
    physics = lanternOnSnow(withLantern, patchAt),
    predicted = physics.radiance,
    halfCode = (c) => {
      const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return (s <= 0.04045 ? 1 / 12.92 : (2.4 * ((s + 0.055) / 1.055) ** 1.4) / 1.055) / 510;
    };
  const fmt = (c) => c.map((v) => v.toFixed(4)).join(', ');
  console.log(
    JSON.stringify({ lantern: { measured: fmt(measured), predicted: fmt(predicted), lit: physics.lit.toFixed(4) } }),
  );
  assert.equal(physics.lit, 1, 'no window bar shadows the patch');
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(measured[k] - predicted[k]) <= 3 * 0.0001 + halfCode(litPatch[k]) + halfCode(unlitPatch[k]),
      `the lantern's light on the snow, linear RGB ${fmt(measured)}, is a kerosene hurricane lantern's ${fmt(predicted)}`,
    );

  // KB-CABIN-GROUNDEDGE1: the window's right jamb (its frame's outer corner at x 1.8, z 2.67, 0.937 m across the
  // ground from the lantern) throws the patch's right edge. The lantern is a flame 22 mm wide (`hurricaneLantern`,
  // radius 0.011 m), so across that vertical edge, on the snow at a ground distance h_r from the lantern, the penumbra
  // is 2 x 0.011 x (h_r - 0.937) / 0.937 wide (similar triangles in plan, the shadow plane being vertical), and for a
  // disc source the lit share runs from 10% to 90% over 0.687 of it (a circular segment holds 10% of the disc at
  // 0.687 of the radius from the centre). Read across the edge 6 m out, in the lantern-only linear frame, 5 mm a step.
  // As a point (radius 0, until 2026-11-16) the edge rose over the shadow filter's 1 to 2 cm.
  //
  // KB-CABIN-EDGEPHASE1: each step is read in float, bilinearly at the point's own projection (`hdrRead`, the frame's
  // HDR capture over the jitter cycle), not as the 8-bit pixel `colour` rounds to, which sits up to a pixel from the
  // point: a 6 m profile 5 mm a step crosses a pixel every few steps, and Math.floor in place of Math.round moved the
  // 10 to 90% rise from 0.0943 to 0.1412 m. The 8-bit pixel profile's rise is printed as `measured8` for comparison.
  const profile = [],
    profile8 = [];
  for (let step = 0; step <= 120; step++) {
    const s = -0.3 + 0.005 * step,
      point = [profilePoints[step]];
    profile.push([s, withLantern.hdr[step].at[0] - withoutLantern.hdr[step].at[0]]);
    profile8.push([s, colour(withLantern, point, 0).lin[0] - colour(withoutLantern, point, 0).lin[0]]);
  }
  // The lit level beside the penumbra falls smoothly across the line (the snow's slope, the lantern's cosine and
  // inverse square: 0.0393 to 0.0343 from s -0.3 to -0.12 m), so the level the edge rises from is that shoulder's
  // straight line, fitted outside the penumbra (its half width, 0.06 m, and a margin) over s <= -0.12 and carried to
  // each step, not its mean over a stretch 0.2 m away: against that mean the 90% crossing sat on the shoulder's slow
  // fall, and the rise read 0.0943, 0.1234 or 0.1412 m with the pixel the 8-bit read picked.
  const risen = (points) => {
      const shoulder = points.filter(([s]) => s <= -0.12),
        n = shoulder.length,
        mx = shoulder.reduce((a, [s]) => a + s / n, 0),
        my = shoulder.reduce((a, [, v]) => a + v / n, 0),
        slope =
          shoulder.reduce((a, [s, v]) => a + (s - mx) * (v - my), 0) /
          shoulder.reduce((a, [s]) => a + (s - mx) ** 2, 0),
        lit = (s) => my + slope * (s - mx),
        crossing = (level) => {
          for (let i = 1; i < points.length; i++) {
            const [s0, v0] = points[i - 1],
              [s1, v1] = points[i],
              f0 = v0 / lit(s0),
              f1 = v1 / lit(s1);
            if (f0 >= level && f1 < level) return s0 + ((f0 - level) / (f0 - f1)) * (s1 - s0);
          }
          return NaN;
        };
      return { plateau: lit(0), rise: crossing(0.1) - crossing(0.9) };
    },
    { plateau, rise } = risen(profile),
    penumbra = (0.687 * 2 * 0.011 * (hr - reach)) / reach;
  console.log(
    JSON.stringify({
      edge: {
        measured: rise.toFixed(4),
        measured8: risen(profile8).rise.toFixed(4),
        predicted: penumbra.toFixed(4),
        plateau: plateau.toFixed(4),
      },
    }),
  );
  // Sub-pixel phase (KB-CABIN-EDGEPHASE1): the same line read at three interleaved sets of every third step, 15 mm
  // apart and 5 mm out of step, is the same edge. The float reads agree to 5 mm; the 8-bit pixel picks spread 0.0623
  // to 0.1017 m with the old mean-of-a-stretch level (the shoulder's line spreads them 0.0063 m).
  const phases = [0, 1, 2].map((o) => risen(profile.filter((_, i) => i % 3 === o)).rise),
    phases8 = [0, 1, 2].map((o) => risen(profile8.filter((_, i) => i % 3 === o)).rise),
    spread = (v) => Math.max(...v) - Math.min(...v);
  console.log(
    JSON.stringify({ edgePhase: { spread: spread(phases).toFixed(4), spread8: spread(phases8).toFixed(4) } }),
  );
  assert.ok(
    spread(phases) < 0.005,
    `the edge's rise does not depend on the pixel phase (${phases.map((v) => v.toFixed(4))})`,
  );
  assert.ok(plateau > 0.02, `the patch is lit before its right edge (${plateau.toFixed(4)})`);
  assert.ok(
    rise >= 0.7 * penumbra && rise <= 1.3 * penumbra,
    `the patch's right edge rises over ${rise.toFixed(4)} m, a 22 mm flame's ${penumbra.toFixed(4)} m`,
  );

  // KB-CABIN-WINDOWGLOW1: the room's light leaves through the window (clustered/area `openingLight`, its radiance the
  // room's integrating-sphere mean, and through the frosted pane also the lamps' light the frost lets through, checked
  // in packages/clustered/test/opening-light.test.js). Its light on the snow just under the window, where the wall and
  // the sill keep the lantern's own light off: the frame with it less the frame without it, against the form factor F
  // from each snow point to the part of the window it sees past the frame and the sill (`paneFormFactor`, traced;
  // KB-BOUNCE-REVEAL1), diffuse albedo x radiance x F; the snow's specular adds under 10% at this roughness. Before,
  // nothing lit that snow but the moon.
  const frostedLit = await frame(bare, 'outside-linear', { linear: true, lamp: 'steady' }),
    frostedUnlit = await frame(bare, 'outside-linear-no-lantern', { linear: true, lamp: false }),
    [opening] = await ctx.page.evaluate(() => window.cabinHearth.windowLight.list),
    noWindow = await frame(bare, 'outside-linear-no-window', { linear: true, lamp: false, windowLight: false }),
    underAt = [
      [0.9, 3.9],
      [1.2, 3.9],
      [1.5, 3.9],
      [0.9, 4.05],
      [1.2, 4.05],
      [1.5, 4.05],
    ].map(([x, z]) => [x, 0.05, z]),
    lift = [0, 1, 2].map((k) => colour(frostedUnlit, underAt).lin[k] - colour(noWindow, underAt).lin[k]),
    formFactor = (p) => paneFormFactor(p, [0, 1, 0]),
    hits = snowHits(noWindow, underAt),
    F = hits.reduce((a, p) => a + formFactor(p) / hits.length, 0),
    expected = [0, 1, 2].map((k) => 0.9 * opening.color[k] * opening.intensity * F);
  console.log(
    JSON.stringify({
      window: { radiance: fmt(opening.color), F: F.toFixed(4), measured: fmt(lift), predicted: fmt(expected) },
    }),
  );
  assert.ok(
    lift[0] >= 0.8 * expected[0] - halfCode(0.013) && lift[0] <= 1.25 * expected[0] + halfCode(0.013),
    `the window's room light on the snow under it, ${fmt(lift)}, is its ${fmt(expected)}`,
  );
  assert.ok(expected[0] > 0.002, `the room's light under the window is more than a trace (${fmt(expected)})`);

  // KB-CABIN-EDGE-SOFT2 (Scott 2026-11-16, "Frosted window glass"): the window has frosted over inside. The frosted pane
  // (procedural `generateWindowPane`, a shadow caster) stops the lantern's beam: the lantern's own light on the patch
  // that the clear window lit with 0.23 linear red is now nothing, to the measurement's tolerance above, and with it
  // every line the window's bars drew in that beam.
  const beam = [0, 1, 2].map((k) => colour(frostedLit, patchAt).lin[k] - colour(frostedUnlit, patchAt).lin[k]);
  console.log(JSON.stringify({ frosted: { beam: fmt(beam), radiance: fmt(opening.color) } }));
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(beam[k]) <= 3 * 0.0001 + 2 * halfCode(colour(frostedLit, patchAt).lin[k]),
      `no lantern beam crosses the frosted pane: ${fmt(beam)}`,
    );
  // The frost sends the light out instead, diffusely, as the window's radiance (clustered/area `openingLight` with
  // frosted glazing, tau_d E / pi). The patch on the snow is now that light, and its edge where the clear window's right
  // jamb cut the beam (the line above, 3.5 m out, where clear glass gave a 22 mm flame's 4 cm penumbra) is as soft as a
  // Lambertian rectangle the pane's size makes it. Edge width here is the light over its slope across the line, both
  // from a least-squares line through the profile's 7 x 7 px boxes 2 cm apart over 0.8 m: for a light that falls off
  // smoothly, the distance over which it would fall to nothing. The window's light at each point is the form factor F
  // of the part of the pane it sees past the frame and sill (`paneFormFactor`) times its radiance, so the predicted width is F's over F's slope over the same points; the minimum is
  // half that. The clear window's crisp edge reads a quarter of a metre or less this way.
  const near = 3.5,
    nearAt = [lampAt[0] + along[0] * near, lampAt[1] + along[1] * near],
    line = [];
  for (let s = -0.4; s <= 0.4 + 1e-9; s += 0.02) {
    const x = nearAt[0] + across[0] * s,
      z = nearAt[1] + across[1] * s;
    line.push([s, [x, snowY(x, z), z]]);
  }
  const fit = (pairs) => {
      const n = pairs.length,
        mx = pairs.reduce((a, [x]) => a + x / n, 0),
        my = pairs.reduce((a, [, y]) => a + y / n, 0),
        slope =
          pairs.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / pairs.reduce((a, [x]) => a + (x - mx) ** 2, 0);
      return { mean: my, slope, width: my / Math.abs(slope) };
    },
    glow = fit(line.map(([s, p]) => [s, colour(frostedLit, [p]).lin[0] - colour(noWindow, [p]).lin[0]])),
    form = fit(
      line.map(([s, p]) => [s, snowHits(noWindow, [p]).reduce((a, q, _, all) => a + formFactor(q) / all.length, 0)]),
    ),
    minimum = form.width / 2;
  console.log(
    JSON.stringify({
      frostedEdge: {
        width: glow.width.toFixed(3),
        predicted: form.width.toFixed(3),
        level: glow.mean.toFixed(4),
        predictedLevel: (0.9 * opening.color[0] * form.mean).toFixed(4),
      },
    }),
  );
  assert.ok(glow.mean > 0.005, `the frosted window lights the snow where its beam did (${glow.mean.toFixed(4)})`);
  assert.ok(
    glow.width >= minimum,
    `the frosted window's patch edge is ${glow.width.toFixed(3)} m wide, at least half a diffuse pane's ${form.width.toFixed(3)} m`,
  );
  // KB-CABIN-FROST2: the frosted pane itself, close up from outside (the camera 1.9 m out, in the linear frame 4 stops
  // down, read 16 times up; its peak, 14, is past what 3 stops down holds). Physics alone predicts it: the frost on the glass's room face (z 2.448) sends out
  // L(x) = tau_d E(x) / pi, E(x) the lantern's and the fire's light at x by the inverse square law and the cosine, where
  // the segment to the light misses the glazing bars (the boxes above) and leaves the room through the frame's reveal
  // (the opening extruded back to z 2.33), plus the room's own light (pi times clear glazing's radiance on the glass,
  // read from the page's `glazing=clear` opening, the Goebel 1967 sphere checked in
  // packages/clustered/test/opening-light.test.js). tau_d is FROSTED_GLAZING's 0.637: 3 mm float glass, 0.90 (Rubin
  // 1985), under frost of optical depth 5 and asymmetry 0.89 (Warren 1982), Eddington transmittance 1 / (1 + 3 (1 - g)
  // tau / 4) (Shettle and Weinman 1970). Flame lights count at their flicker means (candle 0.9, fire 0.75), as the frame
  // holds the lantern. Bloom is off in this frame, so each read is the pane's own light.
  const tauD = 0.9 / (1 + (3 * (1 - 0.89) * 5) / 4),
    frostZ = 2.448,
    glassArea = (1.2 - 0.045) * (1.1 - 0.045),
    roomL = clearOpening.color.map((c) => (c * 1.2 * 1.1) / glassArea),
    sources = await ctx.page.evaluate(() => {
      const page = window.cabinHearth,
        lamp = page.kit.hearth.lamp;
      return [
        { position: [1.2, 1.875, 1.95], intensity: lamp.intensity * 0.9, color: [...lamp.color] },
        ...(page.fire?.lights ?? []).map((l) => ({
          position: [...l.position],
          intensity: l.intensity * (l.flicker?.curve === 'fire' ? 0.75 : l.flicker?.curve === 'candle' ? 0.9 : 1),
          color: [...(l.color ?? [1, 1, 1])],
        })),
      ];
    }),
    barBoxes = [
      [
        [0.6, 1.4775, 2.425],
        [1.8, 1.5225, 2.475],
      ],
      [
        [1.1775, 0.95, 2.425],
        [1.2225, 2.05, 2.475],
      ],
    ],
    paneRadiance = (x, y) => {
      const p = [x, y, frostZ],
        L = [0, 0, 0];
      for (const { position, intensity, color } of sources) {
        const d = position.map((c, k) => c - p[k]);
        if (!(d[2] < 0)) continue;
        const crossesBar = barBoxes.some(([lo, hi]) => {
            let t0 = 0,
              t1 = 1;
            for (let k = 0; k < 3; k++) {
              let a = (lo[k] - p[k]) / d[k],
                b = (hi[k] - p[k]) / d[k];
              if (a > b) [a, b] = [b, a];
              t0 = Math.max(t0, a);
              t1 = Math.min(t1, b);
            }
            return t0 < t1;
          }),
          s = Math.min(1, (frostZ - 2.33) / -d[2]),
          q = p.map((c, k) => c + s * d[k]);
        if (crossesBar || Math.abs(q[0] - 1.2) > 0.6 || Math.abs(q[1] - 1.5) > 0.55) continue;
        const r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        for (let k = 0; k < 3; k++) L[k] += (intensity * color[k] * -d[2]) / r2 ** 1.5;
      }
      return L.map((c, k) => tauD * (c / Math.PI + roomL[k]));
    },
    close = { position: [1.35, 1.5, 4.3], target: [1.2, 1.5, 2.45] },
    paneClose = await frame(bare, 'outside-linear-pane', {
      linear: true,
      exposure: -4,
      lamp: 'steady',
      bloom: false,
      camera: close,
    }),
    read = (f, x, y, z = 2.452, r = 3) => colour(f, [[x, y, z]], r).lin.map((c) => 16 * c);
  let peak = [0, 0, 0],
    peakAt;
  for (let x = 0.6; x <= 1.8; x += 0.005)
    for (let y = 0.95; y <= 2.05; y += 0.005)
      if (!(Math.abs(x - 1.2) < 0.0225 || Math.abs(y - 1.5) < 0.0225)) {
        const L = paneRadiance(x, y);
        if (L[0] > peak[0]) [peak, peakAt] = [L, [x, y]];
      }
  // The brightest frost is just beside the mullion at the lantern's height (the mullion's room side, 23 mm proud of the
  // glass, shades the 1 mm next to it); the read 2.75 cm out from the mullion is 98% or more of it, clear of the
  // 7 x 7 px box's reach onto the bar.
  const hotAt = [1.25, 1.875],
    centreAt = [1.27, 1.42],
    cornerAt = [0.66, 1.03],
    [hot, centre, cornerRead] = [hotAt, centreAt, cornerAt].map(([x, y]) => read(paneClose, x, y)),
    [hotP, centreP, cornerP] = [hotAt, centreAt, cornerAt].map(([x, y]) => paneRadiance(x, y)),
    // Allowances, each from the frame or the page: half an 8-bit code of the read (times 16, the exposure); the frost's
    // emissive map holds each texel to half an 8-bit sRGB code of the pane's peak (KB-CABIN-FROST2 map, 2.4 x 0.5 / 255
    // over (code / 255 + 0.055) of the value); and the frost's own reflection of the night outside, at most its
    // reflectance 0.292 over the logs' 0.258 (weatheredWood's red) times the moonlit log wall beside the window in the
    // same frame.
    paneWall = read(paneClose, 0.3, 1.5, 2.65)[0],
    reflection = (0.292 / 0.258) * paneWall,
    codeShare = (v, top) => (2.4 * (0.5 / 255)) / ((v / top) ** (1 / 2.4) + 0.055),
    allow = (measured, predicted) =>
      16 * halfCode(measured / 16) + predicted * codeShare(predicted, peak[0]) + reflection;
  console.log(
    JSON.stringify({
      paneClose: {
        peak: fmt(peak),
        peakAt: peakAt.map((v) => v.toFixed(3)).join(', '),
        hot: fmt(hot),
        hotPredicted: fmt(hotP),
        centre: fmt(centre),
        centrePredicted: fmt(centreP),
        corner: fmt(cornerRead),
        cornerPredicted: fmt(cornerP),
        ratio: (centre[0] / cornerRead[0]).toFixed(3),
        ratioPredicted: (centreP[0] / cornerP[0]).toFixed(3),
        wall: paneWall.toFixed(4),
        mean: fmt(opening.color),
      },
    }),
  );
  assert.ok(hotP[0] >= 0.98 * peak[0], `the read beside the mullion is the pane's brightest, ${hotP[0]} of ${peak[0]}`);
  for (const [name, m, p] of [
    ['brightest', hot, hotP],
    ['centre', centre, centreP],
    ['corner', cornerRead, cornerP],
  ])
    assert.ok(
      m[0] >= p[0] - allow(m[0], p[0]) + reflection && m[0] <= p[0] + allow(m[0], p[0]),
      `the frost's ${name} radiance, ${fmt(m)}, is tau_d E / pi, ${fmt(p)}`,
    );
  // The pane is brightest nearest the lamp and dimmest in its far corner, as the inverse square law and the cosine say;
  // the even card it was until 2026-11-16 read 1 here.
  const ratio = centre[0] / cornerRead[0],
    low = (centreP[0] - allow(centre[0], centreP[0]) + reflection) / (cornerP[0] + allow(cornerRead[0], cornerP[0])),
    high = (centreP[0] + allow(centre[0], centreP[0])) / (cornerP[0] - allow(cornerRead[0], cornerP[0]) + reflection);
  assert.ok(
    ratio >= low && ratio <= high && low > 1.3,
    `the pane's centre over its corner, ${ratio.toFixed(3)}, is ${(centreP[0] / cornerP[0]).toFixed(3)} (${low.toFixed(3)} to ${high.toFixed(3)})`,
  );
  // The bars (KB-CABIN-FROST2): in the glass's plane, dark against the backlit frost, as the scene shows them, bloom on.
  // A bar's outdoor face is the frame's wood (#5a4330, linear red 0.102) lit by the night outside, at most 0.102 / 0.258
  // of the log wall's radiance; the glow spreads at most the kit's bloom strength times the pane's light above the
  // bloom threshold onto it (the glow of a texel of light E sums to strength x E, so no pixel gets more). So the frost beside a bar is at least its predicted radiance over that sum times
  // the bar's light. Read 3 x 3 px at each bar's middle, which the frame shows 9 px wide or more.
  const barsFrame = await frame(bare, 'outside-linear-bars', {
      linear: true,
      exposure: -4,
      lamp: 'steady',
      camera: close,
    }),
    projectBar = (m, p) => {
      const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return [(cx / cw / 2 + 0.5) * barsFrame.image.width, (0.5 - cy / cw / 2) * barsFrame.image.height];
    },
    barPx = Math.abs(
      projectBar(barsFrame.matrix, [1.2225, 1.75, 2.475])[0] - projectBar(barsFrame.matrix, [1.1775, 1.75, 2.475])[0],
    ),
    barWall = read(barsFrame, 0.3, 1.5, 2.65)[0],
    kitBloom = await ctx.page.evaluate(() => ({ ...window.cabinHearth.kit.bloom })),
    bloomGlow = kitBloom.strength * Math.max(0, peak[0] - kitBloom.threshold);
  assert.ok(barPx >= 9, `a bar is ${barPx.toFixed(1)} px wide in the close frame`);
  for (const [bar, beside] of [
    [
      [1.2, 1.75],
      [1.27, 1.75],
    ],
    [
      [0.9, 1.5],
      [0.9, 1.44],
    ],
    [
      [1.5, 1.5],
      [1.5, 1.44],
    ],
  ]) {
    const b = read(barsFrame, ...bar, 2.475, 1)[0],
      f = read(barsFrame, ...beside)[0],
      fP = paneRadiance(...beside)[0],
      barBound = (0.102 / 0.258) * barWall + bloomGlow + 16 * halfCode(b / 16),
      derived = (fP - allow(f, fP) + reflection) / barBound;
    console.log(
      JSON.stringify({
        bar: {
          at: bar.join(', '),
          bar: b.toFixed(4),
          bound: barBound.toFixed(4),
          frost: f.toFixed(4),
          ratio: (f / b).toFixed(2),
          derived: derived.toFixed(2),
          px: barPx.toFixed(1),
        },
      }),
    );
    assert.ok(
      derived > 1.5 && f / b >= derived,
      `the bar at [${bar}] reads ${b.toFixed(4)}, the frost beside it ${f.toFixed(4)}: ${(f / b).toFixed(2)} times, at least ${derived.toFixed(2)}`,
    );
  }

  // KB-CABIN-BLOOM1: the lantern's flame glows. It is an emitter at the lamp's radiance (its 6.5 cd mean over its
  // 11 mm flame's projected area, pi 0.011^2: 17,000 cd/m2), about 2.5 px of the frame, and the kit's Bloom keeps a
  // small steady light's energy (packages/post/test/bloom-energy-browser.mjs). The glow: the frame with the flame less
  // the frame without it, through clear glazing (the frost hides the flame), in a ring 16 to 32 px round the flame, where
  // it lights the window round the lantern (nearer,
  // its red passes 1, the canvas's limit: 6 to 16 px read 0.91 for a predicted 1.70, its green 0.394 for 0.395). The
  // prediction: the flame's light on the image, E = L x A for each channel (A its pi r^2 side area in px^2, from the
  // page's camera), put as a 2 x 2 px source at the flame's pixel into Bloom.encodeImage with the kit's bloom options,
  // the same kernel, read over the same ring. The floor and ceiling are the window check's: 0.8 and 1.25 of it, plus
  // half an 8-bit code of each frame at the ring's level. Before, the flame was a lit cone that did not glow at all.
  const noFlame = await frame(clearGlass, 'outside-linear-clear-no-flame', { linear: true, lamp: 'steady', flame: 0 }),
    lamp = await ctx.page.evaluate(() => ({
      ...window.cabinHearth.kit.hearth.lamp,
      at: [...window.cabinHearth.groups.group('lamp-steady').lights[0].position],
      eye: [...window.cabinHearth.engine.camera.position],
    })),
    flameAt = [lamp.at[0], lamp.at[1] - 0.045, lamp.at[2]],
    project = ({ matrix: m, image }, [x, y, z]) => {
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
        cy = m[1] * x + m[5] * y + m[9] * z + m[13],
        cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [(cx / cw / 2 + 0.5) * image.width, (0.5 - cy / cw / 2) * image.height];
    },
    [fu, fv] = project(withLantern, flameAt),
    // Pixels per metre at the flame: 1 cm square to the camera's ray, level.
    sight = flameAt.map((c, k) => c - lamp.eye[k]),
    square = [-sight[2], 0, sight[0]].map((c) => c / Math.hypot(sight[0], sight[2])),
    [gu, gv] = project(
      withLantern,
      flameAt.map((c, k) => c + 0.01 * square[k]),
    ),
    perMetre = Math.hypot(gu - fu, gv - fv) / 0.01,
    area = Math.PI * lamp.radius ** 2 * perMetre ** 2,
    radiance = lamp.color.map((c) => ((c * lamp.intensity) / (Math.PI * lamp.radius ** 2)) * 0.9),
    energy = radiance.map((r) => r * area),
    ring = (f) => {
      const sum = [0, 0, 0];
      let n = 0;
      for (let v = Math.floor(fv - 32); v <= fv + 32; v++)
        for (let u = Math.floor(fu - 32); u <= fu + 32; u++) {
          const d = Math.hypot(u + 0.5 - fu, v + 0.5 - fv);
          if (d < 16 || d > 32) continue;
          const i = (v * f.image.width + u) * 4;
          for (let k = 0; k < 3; k++) sum[k] += toLinear(f.image.data[i + k] / 255);
          n++;
        }
      return sum.map((s) => s / n);
    },
    flameGlow = [0, 1, 2].map((k) => ring(withLantern)[k] - ring(noFlame)[k]),
    ringPredicted = await ctx.page.evaluate(
      async ({ fu, fv, energy, width, height }) => {
        const { Bloom } = await import('/packages/post/dist/bloom.js'),
          device = window.cabinHearth.engine.gpu,
          f32 = new Float32Array(1),
          u32 = new Uint32Array(f32.buffer),
          half = (x) => {
            f32[0] = x;
            const b = u32[0],
              e = ((b >> 23) & 255) - 112;
            return e <= 0 ? 0 : (e << 10) + (((b & 0x7fffff) + 0x1000) >> 13);
          },
          data = new Uint16Array(width * height * 4),
          u0 = Math.round(fu) - 1,
          v0 = Math.round(fv) - 1;
        for (let v = v0; v < v0 + 2; v++)
          for (let u = u0; u < u0 + 2; u++) data.set([...energy.map((e) => half(e / 4)), half(1)], (v * width + u) * 4);
        const input = device.createTexture({
            size: [width, height],
            format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          }),
          output = device.createTexture({
            size: [width, height],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          }),
          read = device.createBuffer({
            size: width * height * 8,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          }),
          bloom = new Bloom({ ...window.cabinHearth.kit.bloom });
        device.queue.writeTexture({ texture: input }, data, { bytesPerRow: width * 8 }, [width, height]);
        const encoder = device.createCommandEncoder();
        bloom.encodeImage({ device, encoder, width, height }, input.createView(), output.createView());
        encoder.copyTextureToBuffer({ texture: output }, { buffer: read, bytesPerRow: width * 8 }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const out = new Uint16Array(read.getMappedRange().slice(0)),
          float = (h) => {
            const e = (h >> 10) & 31,
              m = h & 1023;
            return e ? 2 ** (e - 15) * (1 + m / 1024) : 2 ** -14 * (m / 1024);
          },
          sum = [0, 0, 0];
        read.unmap();
        let n = 0;
        for (let v = Math.floor(fv - 32); v <= fv + 32; v++)
          for (let u = Math.floor(fu - 32); u <= fu + 32; u++) {
            const d = Math.hypot(u + 0.5 - fu, v + 0.5 - fv);
            if (d < 16 || d > 32) continue;
            for (let k = 0; k < 3; k++) sum[k] += float(out[(v * width + u) * 4 + k]);
            n++;
          }
        bloom.dispose();
        for (const resource of [input, output, read]) resource.destroy();
        return sum.map((s) => s / n);
      },
      { fu, fv, energy, width: withLantern.image.width, height: withLantern.image.height },
    );
  console.log(
    JSON.stringify({
      flame: {
        px: [fu.toFixed(1), fv.toFixed(1)],
        area: area.toFixed(2),
        energy: fmt(energy),
        ring: fmt(flameGlow),
        predicted: fmt(ringPredicted),
      },
    }),
  );
  for (const k of [0, 1])
    assert.ok(
      flameGlow[k] >= 0.8 * ringPredicted[k] - 2 * halfCode(ringPredicted[k]) &&
        flameGlow[k] <= 1.25 * ringPredicted[k] + 2 * halfCode(ringPredicted[k]),
      `the flame's glow round the lantern, ${fmt(flameGlow)}, is its kit bloom's ${fmt(ringPredicted)}`,
    );
  assert.ok(ringPredicted[0] > 0.01, `the flame's glow is more than a trace (${fmt(ringPredicted)})`);
  // KB-CABIN-SNOWBOUNCE1: the snow bounces light onto the logs round the window (@margoengine/clustered/bounce). At
  // the outward crest of the log at (0.3, 1.35, 2.65), facing the snow, fire off, the lantern steady, linear, 3 stops up
  // so the bounce spans many 8-bit codes: bounce on minus bounce off, against `bounceQuadrature` (above) over the
  // snow surface the test's other checks use. The plan's 0.096 R was not reproducible (the lantern alone gives 0.116 R
  // by this quadrature); the window's light was derived for the frosted scene once its glass frosted over
  // (KB-CABIN-EDGE-SOFT2). Clear glazing: the lantern's capture against the lantern's quadrature within 15%, the frame
  // within 2% of the JS twin over the very data the GPU reads, both at the crest itself: the frame read in float there
  // (`hdrRead`; KB-BOUNCE-FRAMETWIN1: the 8-bit 3 x 3 box, still reported as `measured8`, read 2.9% over the twin, for
  // its centre lay half a pixel down the log, where the bounce is 2.4% higher, and one 8-bit code there is about 3% of
  // the bounce); the snow beside the lantern's patch changes by under
  // 0.0005. Frosted (the scene as it is): the lantern's beam stops at the frost, so its bounce outside is under 2% of the
  // window's (the dark room's bound: counted once, by the window's light); the window's light (the pane's tau_d E / pi as the opening's mean radiance) bounces off
  // the snow it lights, and its twin is within 15% of the quadrature with the window's frame and sill shading the snow
  // (physics; KB-BOUNCE-REVEAL1: the opening light's `recess` and `sill` clip its rectangle to what each point sees past
  // them, in AreaLights and in the bounce's capture, which looks out from the frame's mouth). The bare quadrature, what
  // an opening light with no reveal puts on the snow, is reported beside it. Every
  // check above that holds a light to physics runs with `bounce=0`. Before KB-BOUNCE-VPL-BURIED1 the snow's VPLs sat
  // under their own drifts and the crest got 0.0020 R.
  const stops = 3,
    gain = 2 ** stops,
    crest = [0.3, 1.35, 2.65],
    crestNormal = [0, 0, 1],
    // Snow no lit surface sees (KB-BOUNCE-SHADOWSNOW1): an exact ray cast from every VPL against the scene's triangles
    // gives it 0.00003 R. The old point (-1.2, 0.05, 4.0) sees the lit window jamb through the clear opening, 0.0025 R
    // by the same cast, which is physics; the bounce now gives it that (0.0032 R before the scene's triangles were
    // occluders, the rest the room's walls lighting it through the front wall).
    shadowed = [-2.0, 0.05, 3.2],
    // Snow 0.25 to 0.35 m in front of the front wall and 1.3 to 2.2 cm over the cabin's plank floor (y 0.15) behind it:
    // the same cast gives each 0.00003 R. The texels of the back wall's VPLs there held the floor just inside the wall,
    // to one depth sample the snow's own plane, and the bounce took 0.0013 R and 0.0007 R (the twin, albedo 0.9 / pi)
    // through the wall until the texel beside, which holds the wall, was asked too (KB-BOUNCE-SHADOWSNOW1).
    nearWall = [
      [-1.5, 0.163, 3.0],
      [-2.5, 0.172, 2.9],
    ],
    wood = weatheredWood.color.slice(0, 3),
    crestRead = async (glazing) => {
      const query = `view=outside&fog=0&snow=0&fire=0${glazing === 'clear' ? '&glazing=clear' : ''}`,
        on = await frame(query, `outside-linear-bounce-${glazing}`, {
          linear: true,
          exposure: stops,
          lamp: 'steady',
          bloom: false,
          hdr: [crest, shadowed, ...nearWall],
        }),
        data = new Float32Array(await ctx.page.evaluate(() => [...window.cabinHearth.lightBounce.data])),
        stats = await ctx.page.evaluate(() => window.cabinHearth.lightBounce.stats),
        off = await frame(`${query}&bounce=0`, `outside-linear-no-bounce-${glazing}`, {
          linear: true,
          exposure: stops,
          lamp: 'steady',
          bloom: false,
          hdr: [crest, shadowed, ...nearWall],
        }),
        change = (at) => [0, 1, 2].map((k) => (colour(on, at, 1).lin[k] - colour(off, at, 1).lin[k]) / gain),
        float = (key, i = 0) => [0, 1, 2].map((k) => on.hdr[i][key][k] - off.hdr[i][key][k]),
        // The sources in their order: the lantern (the only shadowed light with the fire off), then the window.
        only = (source) => {
          const d = new Float32Array(data),
            scales = [0, 1].map((s) => (s === source ? [...data.slice(4 + 4 * s, 7 + 4 * s)] : [0, 0, 0]));
          setBounceScales(d, scales);
          return bounceIrradiance(d, crest, crestNormal);
        };
      assert.equal(stats.sources, 2, `two bouncing sources, ${JSON.stringify(stats)}`);
      return {
        measured: float('at'),
        box: float('box'),
        measured8: change([crest]),
        twin: bounceIrradiance(data, crest, crestNormal).map((e, k) => (wood[k] / Math.PI) * e),
        lantern: only(0),
        window: only(1),
        scales: [[...data.slice(4, 7)], [...data.slice(8, 11)]],
        shadowChange: float('at', 1),
        shadowChange8: change([shadowed]),
        nearWallChange: nearWall.map((_, i) => float('at', 2 + i)),
        nearWallTwin: nearWall.map((p) => bounceIrradiance(data, p, [0, 1, 0]).map((e) => (0.9 / Math.PI) * e)),
        stats,
      };
    },
    clear = await crestRead('clear'),
    lanternQuad = bounceQuadrature('lantern').map((e, k) => e * clear.scales[0][k]),
    frosted = await crestRead('frosted'),
    paneShaded = bounceQuadrature('pane').map((e, k) => e * frosted.scales[1][k]),
    paneBare = bounceQuadrature('pane', { shaded: false }).map((e, k) => e * frosted.scales[1][k]),
    // Where the opening's capture looks out from (KB-BOUNCE-CAPEYE1): the glass's outdoor face (main.ts
    // `opening.position`, z 2.452) moved out past the bars (0.05 deep, centred on the glass) by half their depth and the
    // capture camera's near plane (0.05 m), z 2.527.
    paneModel = bounceQuadrature('pane', { shaded: false, centre: [1.2, 1.5, 2.527] }).map(
      (e, k) => e * frosted.scales[1][k],
    );
  console.log(
    JSON.stringify({
      crest: {
        clear: {
          measured: fmt(clear.measured),
          box: fmt(clear.box),
          measured8: fmt(clear.measured8),
          twin: fmt(clear.twin),
          twinLantern: fmt(clear.lantern),
          quadrature: fmt(lanternQuad),
          shadowChange: fmt(clear.shadowChange),
          shadowChange8: fmt(clear.shadowChange8),
          nearWallChange: clear.nearWallChange.map(fmt),
          nearWallTwin: clear.nearWallTwin.map(fmt),
          stats: clear.stats,
        },
        frosted: {
          measured: fmt(frosted.measured),
          box: fmt(frosted.box),
          measured8: fmt(frosted.measured8),
          twin: fmt(frosted.twin),
          twinLantern: fmt(frosted.lantern),
          twinWindow: fmt(frosted.window),
          model: fmt(paneModel),
          shaded: fmt(paneShaded),
          bare: fmt(paneBare),
          stats: frosted.stats,
        },
      },
    }),
  );
  for (const k of [0, 1])
    assert.ok(
      Math.abs(clear.lantern[k] / lanternQuad[k] - 1) < 0.15,
      `the twin's lantern bounce at the crest, ${fmt(clear.lantern)}, is the quadrature's ${fmt(lanternQuad)}`,
    );
  for (const r of [clear, frosted]) {
    assert.ok(
      Math.abs(r.measured[0] / r.twin[0] - 1) < 0.02,
      `the frame's bounce at the crest, ${fmt(r.measured)}, is its twin's ${fmt(r.twin)}`,
    );
    assert.ok(r.measured[0] > 0.005, `the snow warms the logs (${fmt(r.measured)})`);
  }
  assert.ok(
    clear.shadowChange.every((c) => Math.abs(c) < 0.0005),
    `the shadowed snow keeps its light (${fmt(clear.shadowChange)})`,
  );
  nearWall.forEach((p, i) =>
    assert.ok(
      clear.nearWallChange[i].every((c) => Math.abs(c) < 0.0005) &&
        clear.nearWallTwin[i].every((c) => Math.abs(c) < 0.0005),
      `the snow at ${p} by the wall keeps its light (frame ${fmt(clear.nearWallChange[i])}, twin ${fmt(clear.nearWallTwin[i])})`,
    ),
  );
  assert.ok(
    frosted.lantern.every((c) => c <= 0.02 * frosted.window[0]),
    `behind the frost the lantern bounces under 2% of the window's light outside (${fmt(frosted.lantern)} of ${fmt(frosted.window)})`,
  );
  // KB-BOUNCE-REVEAL1: the opening light's recess and sill clip what each snow point sees of the window, so the window's
  // bounce at the crest is the shaded quadrature (reveal, sill and bars), not the bare or centre-capture model.
  for (const k of [0, 1])
    assert.ok(
      Math.abs(frosted.window[k] / paneShaded[k] - 1) < 0.15,
      `the window's bounce at the crest, ${fmt(frosted.window)}, is the shaded quadrature's ${fmt(paneShaded)} (bare ${fmt(paneBare)}, centre model ${fmt(paneModel)})`,
    );

  // The hearth view with the fire's and the lantern's bounce, against without (both lights steady): reported, the look
  // change Scott was told of.
  const hearthOn = await frame('view=hearth', 'hearth-bounce', { lamp: 'steady', fire: 'steady' }),
    hearthOff = lit,
    meanY = ({ image }) => {
      let sum = 0;
      for (let i = 0; i < image.data.length; i += 4)
        sum +=
          0.2126 * toLinear(image.data[i] / 255) +
          0.7152 * toLinear(image.data[i + 1] / 255) +
          0.0722 * toLinear(image.data[i + 2] / 255);
      return sum / (image.data.length / 4);
    },
    hearthRead = {
      on: meanY(hearthOn),
      off: meanY(hearthOff),
      rugOn: colour(hearthOn, rugAt).Y,
      rugOff: colour(hearthOff, rugAt).Y,
    };
  console.log(
    JSON.stringify({
      hearth: {
        meanY: [hearthRead.off.toFixed(4), hearthRead.on.toFixed(4)],
        ratio: (hearthRead.on / hearthRead.off).toFixed(3),
        rugY: [hearthRead.rugOff.toFixed(4), hearthRead.rugOn.toFixed(4)],
      },
    }),
  );
  assert.ok(hearthRead.on > hearthRead.off, 'the bounce brightens the hearth view');
  assert.deepEqual(errors, []);
} finally {
  await ctx.close();
}
