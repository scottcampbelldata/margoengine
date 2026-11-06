// Real-GPU checks of the optional material features (features.html draws, this judges the numbers).
// Run from the repository root after `npm run build:packages`: node packages/materials/test/features-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const only = process.argv[2],
  release = await acquire({ owner: 'materials-features' });
const context = await openBrowser({ startPath: '/packages/materials/test/features.html', port: 5271 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const check = (name, ...args) => page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
const near = (a, b, label, tolerance = 0.02) =>
  a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) <= tolerance, `${label}: ${a} should be ${b}`));
const jobs = {
  async clip() {
    const { fast, plain, differ, outside, crossing } = await check('clip');
    console.log('clip', JSON.stringify({ fast, plain, differ, outside, crossing }));
    assert.deepEqual([...fast.errors, ...plain.errors], []);
    assert.equal(fast.has, true, 'this adapter has clip-distances');
    assert.deepEqual([fast.rasterized, fast.discarded], [true, false], 'cut in the rasterizer, no discard');
    assert.deepEqual([plain.has, plain.rasterized, plain.discarded], [false, false, true], 'the fallback discards');
    // Both cut at the plane and leave the wall showing, so nothing behind the cut wrote depth, to the pixel.
    assert.equal(fast.wrong, 0);
    assert.equal(plain.wrong, 0);
    // The two differ only along the cut: multisampling smooths a rasterized edge and a discard cuts whole pixels.
    assert.ok(differ > 0, 'the rasterizer did the cutting');
    assert.equal(outside, 0, 'nothing differs away from the cut');
    // A surface crossing the kept part meets it on the same pixels: the depth of what stays has not moved.
    assert.equal(crossing.outside, 0, 'depth matches where two surfaces meet');
    const shadow = await check('clipShadow');
    console.log('clip shadow', JSON.stringify(shadow));
    assert.deepEqual([...shadow.fast.errors, ...shadow.plain.errors], []);
    assert.deepEqual([shadow.fast.casterCut, shadow.plain.casterCut], [true, false], 'the caster is cut in the rasterizer');
    for (const { kept, cut, open, edge } of [shadow.fast, shadow.plain]) {
      // The wall is a pixel in 0.023 units, and the shadow's edge falls at the plane's -0.1 within two of those.
      assert.ok(Math.abs(edge + 0.1) < 0.046, `the shadow ends at the plane: ${edge}`);
      // The kept half shades the wall to black, and the wall under the cut half is as lit as open wall.
      assert.ok(kept < 0.01, `the kept half casts: ${kept}`);
      assert.ok(open > 0.1 && Math.abs(cut - open) < 0.01, `the cut half casts nothing: ${cut} ${open}`);
    }
    // Both cut the same triangles at each texel's centre, so the shadows match but for texels on the cut, under two pixels.
    assert.equal(shadow.outside, 0, `the shadows match away from the cut: ${shadow.differ}`);
    const { instanced, eyed, live } = await check('clipPaths');
    console.log('clip paths', JSON.stringify({ instanced, eyed, live }));
    assert.deepEqual([...instanced.errors, ...eyed.errors, ...live.errors], []);
    // An instanced material at location 12 passes its block index at 13 and leaves room for the distances.
    assert.deepEqual([instanced.rasterized, instanced.discarded, instanced.wrong], [true, false, 0]);
    // The eye's outputs reach location 15, with no room for them: discard, on a device that has the feature.
    assert.deepEqual([eyed.rasterized, eyed.discarded], [false, true]);
    assert.ok(eyed.above[0] > 0.02 && eyed.below[0] < eyed.above[0] / 2, `the eye is cut: ${eyed.above} ${eyed.below}`);
    // A wedge is not a union, so it discards; turned off live it recompiles to the rasterizer.
    assert.deepEqual([live.wedge.rasterized, live.wedge.discarded, live.wedge.wrong], [false, true, 0]);
    assert.deepEqual([live.union.rasterized, live.union.wrong], [true, 0]);
  },
  async dithering() {
    const encode = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
      from = 0.004,
      to = 0.02,
      run = (o) => page.evaluate((v) => window.check.dithering(v), o),
      worst = ({ columns }) => {
        let most = 0;
        columns.forEach((v, x) => {
          // The gradient is linear in the columns from edge to edge of the canvas.
          if (x > 2 && x < 253) most = Math.max(most, Math.abs(v - encode(from + ((to - from) * (x + 0.5)) / 256)));
        });
        return most;
      };
    const plain = await run({ from, to, dithering: false }),
      soft = await run({ from, to, dithering: true });
    assert.deepEqual([...plain.errors, ...soft.errors], []);
    console.log('dithering', worst(plain), worst(soft));
    // Rounding to 8 bits leaves a column up to half a step off, and the bands are that error.
    assert.ok(worst(plain) > 0.4, `plain bands: ${worst(plain)}`);
    // Triangular noise of deviation 0.41 steps and rounding of 0.29, averaged over 256 rows: 0.03. 0.15 allows five of those.
    assert.ok(worst(soft) < 0.15, `dithered columns keep the true level: ${worst(soft)}`);
    assert.equal(soft.moved, 0, 'a frame repeats exactly');
    // The noise stays within each channel's distance to 0 and 1.
    const black = await run({ from: 0, to: 0, dithering: true }),
      white = await run({ from: 1, to: 1, dithering: true });
    assert.deepEqual([black.low, black.high, white.low, white.high], [0, 0, 255, 255]);
    // A lit surface goes through the same step.
    const lit = await run({ from, to, dithering: true, lit: true }),
      flat = await run({ from, to, dithering: false, lit: true });
    assert.deepEqual([...lit.errors, ...flat.errors], []);
    assert.ok(worst({ columns: lit.columns.map((v, x) => v - flat.columns[x] + encode(from + ((to - from) * (x + 0.5)) / 256)) }) < 0.6);
    assert.ok(lit.columns.some((v, x) => Math.abs(v - flat.columns[x]) > 0.01), 'the lit colour moved');
  },
  async hair() {
    // Flat quad, strand T = +Y, normal N = +Z, sun along +Z, camera at height d. Each row's lobe follows from the point it
    // sees: h is the half vector there, and along is h on the strand tilted by the shift.
    const d = 3,
      lobe = (shift, width) =>
        Array.from({ length: 256 }, (_, k) => {
          const y = (1 - (k + 0.5) / 128) * d * Math.tan(Math.PI / 6),
            r = Math.hypot(y, d),
            half = [-y / r, d / r + 1],
            length = Math.hypot(...half),
            tilt = Math.hypot(1, shift),
            along = (half[0] / length + (shift * half[1]) / length) / tilt,
            power = 1 / (width * width);
          return Math.sqrt(power / (2 * Math.PI)) * (1 - along * along) ** (power / 2);
        }),
      peak = (values) => {
        const top = Math.max(...values);
        let sum = 0,
          weight = 0;
        values.forEach((v, k) => {
          if (v > top * 0.8) {
            sum += k * v;
            weight += v;
          }
        });
        return { row: sum / weight, top, width: values.filter((v) => v > top / 2).length };
      };
    const shift = 0.1,
      width = 0.1,
      specular = 3,
      got = await page.evaluate((v) => window.check.hair(v), { shift, width });
    assert.deepEqual(got.errors, []);
    // Blue: base blue is 0, so only the white lobe. Red less blue: the flat diffuse, the 0.4 of the base, and the tinted lobe.
    const white = peak(got.rows.map((c) => c[2])),
      tinted = peak(got.rows.map((c) => Math.max(c[0] - c[2] - 0.4, 0))),
      wantWhite = peak(lobe(shift, width)),
      wantTinted = peak(lobe(-1.5 * shift, 2 * width));
    console.log('hair', JSON.stringify({ white, tinted, wantWhite, wantTinted }));
    // The 8-bit steps across a lobe's flat top move its centre by up to two rows.
    assert.ok(Math.abs(white.row - wantWhite.row) < 2, `white highlight at ${white.row}, want ${wantWhite.row}`);
    assert.ok(Math.abs(tinted.row - wantTinted.row) < 2, `tinted highlight at ${tinted.row}, want ${wantTinted.row}`);
    // A half-height edge moves by half an 8-bit step over the lobe's slope there. For white that is 0.0018 at 0.0041 a row.
    assert.ok(Math.abs(white.width - wantWhite.width) <= 2, `white width ${white.width}, want ${wantWhite.width}`);
    // The tinted lobe's one edge in the picture lies under the white peak, so it is read as a difference of red near 0.85 and
    // blue near 0.43: half a step of each, 0.0045, at 0.00054 a row, is 9 rows. With the white lobe's width it would be 55 off.
    assert.ok(Math.abs(tinted.width - wantTinted.width) <= 9, `tinted width ${tinted.width}, want ${wantTinted.width}`);
    // The white lobe's height: Marschner's F / 4 of the 1.55 cuticle, under a sun of pi, within two 8-bit steps at this level.
    const height = wantWhite.top * (0.0465 / 4) * specular * Math.PI;
    assert.ok(Math.abs(white.top - height) < 0.008, `white height ${white.top}, want ${height}`);
    // The white one has no colour of its own: green follows blue.
    got.rows.forEach((c, k) => assert.ok(Math.abs(c[1] - c[2]) < 0.01, `row ${k}: ${c}`));
    const real = await check('hairAvatar');
    console.log('hair on Seed-san', JSON.stringify(real));
    assert.deepEqual(real.errors, []);
    assert.ok(real.drawn > 3000, `the hair covers part of the picture: ${real.drawn}`);
    // Blue is the white lobe alone, the base having none. Its height at the default width is sqrt(p / 2 pi) F / 4 pi, 0.121,
    // at most one 8-bit step over, and a lit strand facing the sun reaches at least half of it.
    assert.ok(real.peak > 0.06 && real.peak < 0.125, `the highlight shows on the real hair mesh: ${real.peak}`);
    // The highlight follows the strands: the same direction would correlate 1, and strands at a right angle only share the
    // surface's shape, so turned 90 degrees it falls elsewhere on the same mesh.
    assert.ok(real.correlation < 0.5, `strand direction moves the highlight: ${real.correlation}`);
  },
  async character() {
    // Every model answers a clustered light as it answers the sun, within the 8-bit step around these colours.
    for (const model of ['hair', 'skin', 'eye']) {
      const run = (light) => page.evaluate((v) => window.check.character(v), { model, light }),
        sun = await run('sun');
      assert.deepEqual(sun.errors, []);
      assert.ok(sun.color[0] > 0.02, `${model} shows: ${sun.color}`);
      for (const light of ['directional', 'point']) {
        const got = await run(light);
        console.log(model, light, sun.color, got.color);
        assert.deepEqual(got.errors, []);
        near(got.color, sun.color, `${model} under a clustered ${light} light`, 0.01);
      }
    }
  },
  async skin() {
    const size = 64,
      read = (table, nl, y, c) => {
        const fx = (nl * 0.5 + 0.5) * size - 0.5,
          fy = y * size - 0.5,
          x = Math.max(0, Math.min(size - 2, Math.floor(fx))),
          r = Math.max(0, Math.min(size - 2, Math.floor(fy))),
          tx = Math.min(1, Math.max(0, fx - x)),
          ty = Math.min(1, Math.max(0, fy - r)),
          at = (a, b) => table[(b * size + a) * 4 + c];
        return (at(x, r) * (1 - tx) + at(x + 1, r) * tx) * (1 - ty) + (at(x, r + 1) * (1 - tx) + at(x + 1, r + 1) * tx) * ty;
      };
    // Past the terminator the only light is the diffusion, (1 - F) D(n.l, 1 / r) times the sun's power over pi, with F the
    // Schlick term of skin's 0.028 at the half vector of the ray and the sun. Eight times the usual sun lifts the dark band
    // clear of the 8-bit floor; samples at or above white are left out.
    const boost = 8,
      decode = (e) => ((e /= 255) <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4),
      encode = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
      compare = (got, row, label) => {
        let seen = 0;
        for (const { nl, ray, color } of got.samples.filter((v) => v.nl < -0.02))
          color.forEach((v, c) => {
            const fresnel = 0.028 + 0.972 * (1 - Math.sqrt((1 - ray) / 2)) ** 5,
              want = boost * (1 - fresnel) * read(got.table, nl, row, c);
            if (want > 0.9) return;
            seen++;
            // One 8-bit step at this level, and one percent: half floats in the table 0.05, the filter's 8-bit weight on
            // neighbouring texels 0.1, and the sphere's facets, whose n.l and curvature are off by about 1e-4, 0.1.
            const e = Math.round(encode(want)),
              bound = decode(e + 1) - decode(e) + 0.01 * want;
            assert.ok(Math.abs(v - want) < bound, `${label} n.l ${nl} channel ${c}: ${v}, want ${want}, within ${bound}`);
          });
        return seen;
      };
    // 2 units at 400 units a metre is a radius of 5 mm: the table's row sqrt(1 / 5).
    const small = await page.evaluate((v) => window.check.skinSphere(v), { unitsPerMeter: 400, power: Math.PI * boost });
    assert.deepEqual(small.errors, []);
    assert.ok(compare(small, Math.sqrt(1 / 5), '5 mm') > 30, 'samples compared');
    // Red reaches furthest, then green, then blue, at every curvature: the profile's widths say so, and the picture shows it.
    const table = small.table;
    for (let row = 0; row < size; row++)
      for (let column = 0; column < size / 2; column++) {
        const at = (row * size + column) * 4;
        assert.ok(table[at] >= table[at + 1] && table[at + 1] >= table[at + 2], `table row ${row} column ${column}`);
      }
    const edge = small.samples.find((v) => v.nl > -0.1);
    console.log('skin 5 mm', edge.nl, edge.color);
    assert.ok(edge.color[0] > edge.color[1] && edge.color[1] > edge.color[2] && edge.color[2] > 0, `red bleeds furthest: ${edge.color}`);
    // 2 units at 1 unit a metre: a radius of 2 m, close to flat, so the terminator stays where n.l says.
    const large = await page.evaluate((v) => window.check.skinSphere(v), { unitsPerMeter: 1, power: Math.PI * boost });
    assert.deepEqual(large.errors, []);
    compare(large, Math.sqrt(1 / 2000), '2 m');
    const real = await check('skinAvatar', { power: Math.PI * boost });
    console.log('skin on Seed-san', JSON.stringify(real));
    assert.deepEqual(real.errors, []);
    // Past the terminator plain shading has nothing at all, but for pixels shared with another surface at an edge, a small
    // share of a head. Where it is black, every row of the table above orders red, green, blue, and one 8-bit step above
    // black is 1 / (255 * 12.92).
    assert.ok(real.black > real.band * 0.8 && real.black > 500, `plain shading stops at the terminator: ${real.black} of ${real.band}`);
    assert.ok(real.soft[0] > real.soft[1] && real.soft[1] >= real.soft[2] && real.soft[2] > 1 / (255 * 12.92), `real head: ${real.soft}`);
  },
  async eye() {
    // The pupil's edges on the middle row, traced here by Snell's law through a unit sphere to the iris plane z = 1 - depth.
    const t = Math.tan(Math.PI / 12),
      trace = ({ angle, ior, pupil, depth = 0.25 }) => {
        const camera = [5 * Math.sin(angle), 5 * Math.cos(angle)],
          hit = (a) => {
            const p = [Math.sin(a), Math.cos(a)],
              l = Math.hypot(camera[0] - p[0], camera[1] - p[1]),
              v = [(camera[0] - p[0]) / l, (camera[1] - p[1]) / l],
              cos = v[0] * p[0] + v[1] * p[1],
              eta = 1 / ior,
              k = Math.sqrt(1 - eta * eta * (1 - cos * cos)),
              r = [-eta * v[0] + (eta * cos - k) * p[0], -eta * v[1] + (eta * cos - k) * p[1]];
            return p[0] + (r[0] * (1 - depth - p[1])) / r[1];
          },
          solve = (x) => {
            let low = -0.55,
              high = 0.55;
            for (let k = 0; k < 60; k++) {
              const mid = (low + high) / 2;
              if (hit(mid) < x) low = mid;
              else high = mid;
            }
            return low;
          },
          // The pixel of a point on the sphere: the camera looks at the origin along -camera.
          pixel = (a) => {
            const p = [Math.sin(a), Math.cos(a)],
              right = [Math.cos(angle), -Math.sin(angle)],
              back = [Math.sin(angle), Math.cos(angle)],
              x = p[0] * right[0] + p[1] * right[1],
              z = 5 - (p[0] * back[0] + p[1] * back[1]);
            return (x / z / t + 1) * 128;
          },
          rho = pupil * 0.49;
        return [pixel(solve(-rho)), pixel(solve(rho))];
      },
      run = async (o) => {
        const got = await page.evaluate((v) => window.check.eyeRun(v), o);
        assert.deepEqual(got.errors, []);
        const want = trace(o),
          middle = Math.round((want[0] + want[1]) / 2),
          edges = [middle, middle + 1];
        while (got.row[edges[0] - 1] < 64) edges[0]--;
        while (got.row[edges[1]] < 64) edges[1]++;
        console.log('eye', JSON.stringify(o), edges, want.map((v) => +v.toFixed(1)));
        // A pixel of rounding each side, and the soft edge of the pupil, a pixel wide.
        edges.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 2.5, `${JSON.stringify(o)}: ${edges}, want ${want}`));
        return edges;
      };
    const ahead = await run({ angle: 0, ior: 1.376, pupil: 0.3 }),
      side = await run({ angle: 0.6, ior: 1.376, pupil: 0.3 }),
      straight = await run({ angle: 0.6, ior: 1.0001, pupil: 0.3 });
    // The cornea moves what is behind it, by more than the bound on the check above.
    assert.ok(Math.abs(side[0] - straight[0]) > 5, `refraction shows: ${side} ${straight}`);
    const wide = await run({ angle: 0, ior: 1.376, pupil: 0.6 });
    assert.ok(wide[1] - wide[0] > (ahead[1] - ahead[0]) * 1.7, 'the pupil opens live');
    await run({ angle: 0.3, ior: 1.376, pupil: 0.3, depth: 0.4 });
    const real = await check('eyeAvatar', { pupil: 0.3 });
    console.log('eye on Seed-san', JSON.stringify(real));
    assert.deepEqual(real.errors, []);
    assert.ok(real.drawn > 1000, 'the plate fills part of the picture');
    assert.equal(real.plain.n, 0, 'no pupil without the feature');
    // A ray along the axis meets the cornea square on and does not bend, so the pupil's centre is the middle of the picture.
    // The plate is about 6 percent off a sphere, which moves the edges, so the bound is the pupil's own radius.
    const reach = Math.sqrt(real.small.n / Math.PI);
    assert.ok(reach > 3, `a pupil shows on the real mesh: ${real.small.n} pixels`);
    assert.ok(Math.hypot(real.small.x - 128, real.small.y - 128) < reach, `the pupil sits on the axis: ${JSON.stringify(real.small)}`);
    // Twice the radius is four times the area on a sphere. The same plate's error applies to both; 3 to 5 leaves it a quarter.
    const opened = real.large.n / real.small.n;
    assert.ok(opened > 3 && opened < 5, `the pupil opens on the real mesh: ${opened}`);
  },
  async stochastic() {
    // A real polyhaven floor texture tiled four times. Independent patches correlate at the repeat by the texture's own
    // autocorrelation at a random shift, whose mean over all shifts is 0 once the mean is taken off; the 75 or so patches
    // on screen leave a sampling error near 1 / sqrt(75) = 0.12, and 0.35 allows three of those. Plain tiling is periodic.
    const repeat = await check('stochastic', 'repeat');
    console.log('stochastic', JSON.stringify(repeat));
    assert.deepEqual(repeat.errors, []);
    assert.ok(repeat.plain.period > 0.99, `plain tiling repeats: ${repeat.plain.period}`);
    assert.ok(Math.abs(repeat.soft.period) < 0.35, `the repeat is gone: ${repeat.soft.period}`);
    // The blend keeps the mean: allow the error of a mean of 75 patches, deviation / sqrt(75), three times over.
    const error = (3 * repeat.plain.deviation) / Math.sqrt(75);
    assert.ok(Math.abs(repeat.soft.mean - repeat.plain.mean) < error, `mean kept: ${repeat.soft.mean} ${repeat.plain.mean}`);
    // Contrast on real wood. Blending three independent reads with these weights keeps 0.88 of the deviation, and the
    // variance-preserving gain brings it back to 1, less what holding the result inside the three reads takes.
    const wood = await check('stochastic', 'contrast');
    console.log('stochastic wood', JSON.stringify(wood));
    assert.deepEqual(wood.errors, []);
    const contrast = wood.soft.deviation / wood.plain.deviation;
    assert.ok(contrast > 0.95 && contrast < 1.05, `contrast kept: ${contrast}`);
    const register = await check('stochastic', 'register');
    assert.deepEqual(register.errors, []);
    assert.ok(register.worst <= 1, `maps on one UV set stay in register: ${register.worst}`);
    // Solid levels: no pixel may differ from the plain read but by rounding.
    const mips = await check('stochastic', 'mips');
    assert.deepEqual(mips.errors, []);
    assert.equal(mips.off, 0, 'a triangle edge chose another mip');
    const layer = await check('stochastic', 'layered');
    console.log('stochastic layer', JSON.stringify(layer));
    assert.deepEqual(layer.errors, []);
    assert.ok(Math.abs(layer.period) < 0.2, `a layer's repeat is gone: ${layer.period}`);
  },
  async lobes() {
    const run = async (o) => {
      const r = await page.evaluate((v) => window.check.lobe(v), o);
      assert.deepEqual(r.errors, [], JSON.stringify(o));
      return r.color;
    };
    const luma = (c) => c[0] + c[1] + c[2];
    // The same light as the sun and as each clustered kind: every lobe answers them alike at the quad's middle, and
    // without the hook it does not, which is the gap this closes.
    for (const surface of ['coat', 'sheen', 'film', 'grain']) {
      const sun = await run({ surface, light: 'sun' });
      assert.ok(luma(sun) > 0.05, `${surface} shows: ${sun}`);
      for (const light of ['directional', 'point', 'spot']) {
        const plain = await run({ surface, light }),
          lit = await run({ surface, light, lobes: true });
        near(lit, sun, `${surface} under a clustered ${light} light`, 0.02);
        const gap = plain.reduce((sum, v, k) => sum + Math.abs(v - sun[k]), 0);
        assert.ok(gap > 0.03, `${surface} under a ${light} light without the hook: ${plain} against ${sun}`);
        console.log(`lobes ${surface} ${light}: sun ${sun}, plain ${plain}, lit ${lit}`);
      }
    }
    // The coat under an area light, against the coat's GGX summed over the panel here, apart from the shader's fitted
    // table. The tone curve takes 0.04 off above 0.08 and is 6.25 x^2 below it; the base under the coat keeps 96%.
    const [dark] = await run({ surface: 'coat', light: 'area' }),
      [coated] = await run({ surface: 'coat', light: 'area', lobes: true }),
      panelCoat = () => {
        const unit = (v) => v.map((x) => x / Math.hypot(...v)),
          dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
          cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
          centre = [0.6, 0.4, 2],
          facing = unit(centre),
          right = unit(cross([0, 1, 0], facing)),
          up = cross(facing, right),
          a2 = 0.3 ** 4,
          steps = 200;
        let sum = 0;
        for (let i = 0; i < steps; i++)
          for (let j = 0; j < steps; j++) {
            const a = (i + 0.5) / steps - 0.5,
              b = (j + 0.5) / steps - 0.5,
              p = centre.map((x, k) => x + a * right[k] + b * up[k]),
              l = unit(p),
              nl = l[2],
              nh = unit([l[0], l[1], l[2] + 1])[2],
              d = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2),
              g = (2 / (1 + 1)) * ((2 * nl) / (nl + Math.sqrt(a2 + (1 - a2) * nl * nl)));
            sum += ((d * g) / 4) * (dot(l, facing) / dot(p, p) / steps ** 2);
          }
        return 0.04 * sum * dot(centre, centre) * 16;
      },
      under = 0.96 * Math.sqrt(dark / 6.25),
      seen = coated + 0.04 - under,
      want = panelCoat();
    assert.ok(Math.abs(seen / want - 1) < 0.1, `coat under an area light: ${seen}, summed ${want}`);
    console.log(`lobes coat area: ${seen} against ${want}`);
    const all = await page.evaluate(() => window.check.lobeAll());
    assert.deepEqual(all.errors, []);
    assert.ok(luma(all.on) > 0.05 && all.on.every(Number.isFinite), `${all.on}`);
    assert.ok(all.on.some((v, k) => Math.abs(v - all.off[k]) > 0.01), `lobes off: ${all.on} -> ${all.off}`);
    near(all.back, all.on, 'lobes back on', 0.001);
    for (const [surface, plainSurface] of [['film', 'plainFilm'], ['grain', 'plainGrain']]) {
      const seen = await page.evaluate((s) => window.check.lobeEnv(s), surface),
        plain = await page.evaluate((s) => window.check.lobeEnv(s), plainSurface);
      assert.deepEqual([...seen.errors, ...plain.errors], []);
      const change = seen.grid.reduce((sum, v, k) => sum + Math.abs(v - plain.grid[k]), 0) / seen.grid.length;
      assert.ok(change > 0.005, `${surface} reads the envMap: ${change}, ${plain.color} -> ${seen.color}`);
      console.log(`lobes ${surface} on an envMap: ${change}, ${plain.color} -> ${seen.color}`);
      // The film tints the map as it tints the sun's highlight: green over blue over red at this thickness.
      if (surface === 'film') assert.ok(seen.color[1] > seen.color[2] && seen.color[2] > seen.color[0], `${seen.color}`);
    }
  },
  async prefilter() {
    const r = await page.evaluate(() => window.check.prefilter());
    assert.deepEqual(r.errors, []);
    assert.ok(Math.abs(r.boxMirror - r.filteredMirror) < 0.02, `mirror: ${r.boxMirror} against ${r.filteredMirror}`);
    // Only +Z is lit, so a box filter stays at 1 while GGX reads the lobe's share on that face, integrated here apart
    // from the shader. With three mips, roughness 0.5 and 1 land exactly on a level.
    const faceShare = (roughness) => {
      const a2 = roughness ** 4;
      let onFace = 0,
        all = 0;
      for (let i = 0; i < 1000; i++)
        for (let j = 0; j < 200; j++) {
          const u = (i + 0.5) / 1000,
            phi = ((j + 0.5) / 200) * 2 * Math.PI,
            c = Math.sqrt((1 - u) / (1 + (a2 - 1) * u)),
            s = Math.sqrt(1 - c * c),
            l = [2 * c * s * Math.cos(phi), 2 * c * s * Math.sin(phi), 2 * c * c - 1];
          if (l[2] <= 0) continue;
          all += l[2];
          if (Math.abs(l[0]) <= l[2] && Math.abs(l[1]) <= l[2]) onFace += l[2];
        }
      return onFace / all;
    };
    for (const [level, roughness, box, filtered] of [[0, 0.5, r.boxHalf, r.filteredHalf], [1, 1, r.boxFull, r.filteredFull]]) {
      const share = faceShare(roughness);
      assert.ok(Math.abs(r.levels[level] - share) < 0.02, `level of roughness ${roughness}: ${r.levels[level]}, GGX share ${share}`);
      // PBR Neutral takes 0.04 off every value in this range before the canvas; the pixels must agree with the level.
      const seen = (filtered + 0.04) / (box + 0.04);
      assert.ok(Math.abs(seen - r.levels[level]) < 0.02, `drawn at roughness ${roughness}: ${seen} against ${r.levels[level]}`);
    }
    assert.ok(Math.abs(r.flatBox - r.flatFiltered) < 0.02, `a flat sky keeps its light: ${r.flatBox} against ${r.flatFiltered}`);
    assert.equal(r.size, 32);
    assert.ok(r.mips >= 2);
    assert.ok(Math.abs(r.restored - r.filteredMirror) < 0.02, `restored: ${r.restored}`);
    // Harmonic rows 1, 2 and 3 are y, z and x, three numbers each: each lit half must land on its own side.
    const row = (sh, k, c) => sh[k * 3 + c];
    assert.ok(row(r.left, 2, 0) > 0, 'the left half of +X lies towards +Z');
    assert.ok(row(r.top, 1, 0) > 0, 'the top half of +Z lies towards +Y');
    assert.ok(row(r.sided, 3, 0) > 0 && row(r.sided, 3, 1) < 0, 'red +X, green -X');
    assert.ok(row(r.sided, 1, 2) > 0 && row(r.sided, 1, 1) < 0, 'blue +Y, yellow -Y');
    console.log(`prefilter: levels hold ${r.levels} of the bright face at roughness 0.5, 1; ${r.mips} mips`);
    const source = (kind) => page.evaluate((k) => window.check.prefilterSource(k), kind);
    // A real sky from one KTX2 file, transcoded to a compressed format; an equirectangular image; float faces over 1.
    const sky = await source('ktx2'),
      ramp = await source('equirect'),
      hdr = await source('float');
    assert.deepEqual([...sky.errors, ...ramp.errors, ...hdr.errors], []);
    assert.notEqual(sky.format, 'rgba8unorm');
    assert.ok(sky.spread > 0.02 && ramp.spread > 0.02, `the views vary: ${sky.spread}, ${ramp.spread}`);
    assert.ok(sky.difference < 0.01, `the KTX2 sky stays itself: ${sky.difference}`);
    assert.ok(ramp.difference < 0.01, `the equirectangular image stays itself: ${ramp.difference}`);
    assert.equal(hdr.red, 4, 'float faces keep values over 1');
    console.log(`prefilter sources: KTX2 ${sky.format} ${sky.difference} of ${sky.spread}, equirect ${ramp.difference} of ${ramp.spread}`);
  },
  async coverage() {
    const run = (o) => page.evaluate((v) => window.check.coverage(v), o);
    for (const kind of ['unlit', 'lit']) {
      const hard = await run({ on: false, kind }),
        soft = await run({ on: true, kind });
      assert.deepEqual([...hard.errors, ...soft.errors], [], kind);
      assert.ok(soft.part > 4 * Math.max(1, hard.part), `${kind}: ${soft.part} part-covered pixels against ${hard.part}`);
      assert.ok(Math.abs(soft.lit - hard.lit) < 0.01, `${kind}: the edge stays put, ${soft.lit} against ${hard.lit}`);
      console.log(`coverage ${kind}: part-covered pixels ${hard.part} -> ${soft.part}, lit ${hard.lit} -> ${soft.lit}`);
    }
    const plain = await run({ on: false, exact: true }),
      flagged = await run({ on: true, exact: true });
    assert.deepEqual([...plain.errors, ...flagged.errors], []);
    assert.equal(flagged.part, plain.part, 'one sample: the plain test');
    assert.equal(flagged.lit, plain.lit, 'one sample: the plain test');
    const blended = await run({ on: true, transparent: true }),
      blendedOff = await run({ on: false, transparent: true });
    assert.deepEqual([...blended.errors, ...blendedOff.errors], []);
    assert.equal(blended.lit, blendedOff.lit, 'a blended material ignores it');
    const live = await page.evaluate(() => window.check.coverageLive());
    assert.deepEqual(live.errors, []);
    assert.ok(live.after > 4 * Math.max(1, live.before), `live: ${live.before} -> ${live.after}`);
  },
  async mips() {
    const run = async (o) => {
      const r = await page.evaluate((v) => window.check.mips(v), o);
      assert.deepEqual(r.errors, [], JSON.stringify(o));
      return r.color;
    };
    const red = [1, 0, 0],
      green = [0, 1, 0],
      blue = [0, 0, 1],
      white = [1, 1, 1];
    // The quad is about 177 pixels across, so 64 texels times `repeats` set the level: 2.8 is level 0.
    near(await run({ repeats: 2, levels: 4 }), red, 'level 0');
    near(await run({ repeats: 5, levels: 4 }), green, 'level 1');
    near(await run({ repeats: 10, levels: 4 }), blue, 'level 2');
    near(await run({ repeats: 20, levels: 4 }), white, 'level 3');
    near(await run({ repeats: 80, levels: 4 }), white, 'past the chain the last level stays');
    near(await run({ repeats: 20, levels: 2 }), green, 'a short chain stops at its last level');
    near(await run({ repeats: 5, levels: 4, canvas: true }), green, 'canvas levels');
    near(await run({ repeats: 5, levels: 4, format: 'rgba16float' }), [0, 0.5, 0], 'half floats');
    console.log('mips: each level shows at its own density, short chains stop, canvases and half floats work');
  },
  async layered() {
    const run = async (kind) => {
      const out = await page.evaluate((k) => window.check.layeredCheck(k), kind);
      for (const r of Array.isArray(out) ? out : [out]) assert.deepEqual(r.errors, [], kind);
      return out;
    };
    const blue = [0, 0, 1],
      red = [1, 0, 0],
      green = [0, 1, 0];
    let r = await run('mask');
    near(r.left, blue, 'mask keeps the material where it is black');
    near(r.right, red, 'mask shows the layer where it is white');
    r = await run('packed');
    near(r.left, blue, 'channel g of a packed mask');
    near(r.right, red, 'channel g of a packed mask');
    r = await run('opacity');
    near(r.left, [0.25, 0, 0.75], 'opacity mixes in linear light');
    r = await run('order');
    near(r.left, red, 'lower layer');
    near(r.right, green, 'upper layer covers the lower one');
    r = await run('vertex');
    assert.ok(r.left[0] < r.right[0], `vertex weight ramps: ${r.left} to ${r.right}`);
    near([r.left[0] + r.left[2], r.right[0] + r.right[2]], [1, 1], 'colours no longer tint: the two layers add to one');
    const [low, mid, high] = await run('height');
    near(low.left, blue, 'height at weight 0');
    near(low.right, blue, 'height at weight 0');
    near(mid.left, blue, 'low ground stays under at weight 0.5');
    near(mid.right, red, 'high ground shows first at weight 0.5');
    near(high.left, red, 'height at weight 1');
    near(high.right, red, 'height at weight 1');
    r = await run('array');
    near(r.left, green, 'layer 1 of the array');
    r = await run('shared');
    assert.equal(r.slots, 1, 'one texture used twice takes one slot');
    near(r.left, blue, 'shared mask');
    near(r.right, [0.5, 0.5, 0], 'shared mask');
    r = await run('tiling');
    assert.equal(r.steps, 7, 'tiling 4 draws four black and white pairs');
    r = await run('detail');
    near(r.grey, [0.5, 0.5, 0.5], 'grey detail leaves the surface', 0.02);
    near(r.dark, [0.25, 0.25, 0.25], 'detail darkens', 0.02);
    near(r.half, [0.375, 0.375, 0.375], 'strength halves it', 0.02);
    r = await run('surface');
    near(r.left, [0.8, 0, 0], 'surface numbers under the mask', 0.01);
    near(r.right, [0.25, 1, 0], 'layer roughness and metalness', 0.01);
    r = await run('normal');
    near(r.left, [0.5, 0.5, 1], 'normal under the mask', 0.02);
    assert.ok(r.right[0] > 0.9 && r.right[2] < 0.6, `layer normal points to +x: ${r.right}`);
    assert.ok(Math.abs(r.detail[1] - 0.5) > 0.3 && r.detail[0] < 0.55, `detail normal tilts along green: ${r.detail}`);
    assert.equal(Math.sign(r.detail[1] - 0.5), Math.sign(r.plain[1] - 0.5), `detail green as a normal map's: ${r.detail}, ${r.plain}`);
    r = await run('live');
    near(r.before, blue, 'live opacity 0');
    near(r.after, red, 'live opacity 1');
    console.log('layered: masks, packed channel, order, vertex, height, array, tiling, detail, surface, normals, live');
  },
  async alphaHash() {
    for (const instanced of [false, true])
      for (const alpha of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const { coverage, errors } = await check('hashCoverage', alpha, instanced);
        console.log(JSON.stringify({ label: 'hash coverage', instanced, alpha, coverage }));
        assert.deepEqual(errors, []);
        // 16,384 pixels: a binomial's standard deviation is 0.004 at most; correlated cells widen it.
        assert.ok(Math.abs(coverage - alpha) < 0.02, `alpha ${alpha} covers ${coverage}`);
      }
    const { same, errors } = await check('hashStable');
    console.log(JSON.stringify({ label: 'hash stays on the surface', same }));
    assert.deepEqual(errors, []);
    assert.ok(same > 0.99, `only ${same} of the pattern moved with the surface`);
    const off = await check('hashTAA', false),
      strict = await check('hashTAA', true),
      on = await check('hashTAA', 'stochastic');
    console.log(JSON.stringify({ label: 'hash and TAA', off, strict, on }));
    assert.deepEqual(off.errors, []);
    assert.deepEqual(on.errors, []);
    assert.ok(Math.abs(on.mean - off.mean) < 0.05, 'TAA keeps the mean');
    assert.ok(on.pixelSpread < off.pixelSpread * 0.7, `TAA leaves grain ${on.pixelSpread} of ${off.pixelSpread}`);
  },
  async ktx2() {
    for (const [name, kind, images] of [
      ['cube-uastc-zstd', 'cube', 6],
      ['array-uastc', 'array', 3],
      ['cube-etc1s', 'cube', 6],
    ]) {
      const got = await check('ktx2', name, kind);
      console.log(JSON.stringify({ label: `ktx2 ${name}`, ...got }));
      assert.deepEqual(got.errors, []);
      assert.equal(got.instance, true);
      assert.equal(got.images, images);
      assert.equal(got.depth, images);
      assert.equal(got.same, true, 'the GPU copy holds the decoded texels of every level');
      assert.equal(got.compressedLayers, images);
      assert.notEqual(got.format.replace('-srgb', ''), 'rgba8unorm');
      // The drawn colour against the four middle texels, mixed (8-bit output, 8-bit interpolation weights).
      for (const { got: shown, want } of got.shown)
        shown.forEach((v, c) => assert.ok(Math.abs(v - want[c]) <= 3, `${name}: drew ${shown}, texels mix to ${want}`));
    }
    const native = await check('ktx2Native');
    console.log(JSON.stringify({ label: 'ktx2 native', ...native }));
    assert.deepEqual(native.errors, []);
    assert.equal(native.instance, true);
    assert.ok(native.centre.some((v) => v > 0), 'the stored file lights the surface');
    assert.match(native.refused, /cube arrays have no material slot/);
  },
  async objectNormal() {
    const s = Math.SQRT1_2,
      wide = Math.hypot(0.5, 1);
    const want = {
      plain: [0, 0, 1],
      turned: [s, 0, s],
      sideways: [1, 0, 0],
      stretched: [0.5 / wide, 0, 1 / wide],
      mirrored: [-s, 0, s],
      instanced: [s, 0, s],
      zUp: [0, s, s],
      halfScale: [s, 0, s],
    };
    for (const [name, normal] of Object.entries(want)) {
      const got = await check('objectNormal', name);
      console.log(JSON.stringify({ label: `object normal ${name}`, ...got, want: normal.map((v) => +v.toFixed(2)) }));
      assert.deepEqual(got.errors, []);
      // 8-bit output: 2 / 255 per step, and an 8-bit map.
      got.normal.forEach((v, k) => assert.ok(Math.abs(v - normal[k]) < 0.03, `${name}: ${got.normal}`));
    }
  },
};
let failed = false;
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const [name, run] of Object.entries(jobs)) {
    if (only && only !== name) continue;
    await run();
    console.log(`ok ${name}`);
  }
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failed = true;
  console.error(error);
  console.error(pageErrors);
} finally {
  await context.close();
  await release();
}
process.exit(failed ? 1 : 0);
