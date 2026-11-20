// Real-GPU check for clustered directional and area-light shadows (fixture tests/clustered-shadow-browser.ts).
// node scripts/run-with-timeout.mjs -- node scripts/clustered-shadow-gpu-check.js [--baseline]
// --baseline records the shadow-off scenes (images, lit shader text, probe radiance) with the build in dist; a later run
// requires them to be identical. That proof is for a change, against the build from before it, so with no baseline on disk
// the run says so and goes on. It always checks the shadowed scenes against analytic occlusion. Each backend keeps its own
// baseline (baseline.json and its images on WebGPU, baseline-compat.json and -compat images on the WebGL2 layer): the two rasterize and round differently,
// so a WebGPU record compared with a --compat run failed every shadow-off scene by a few hundred bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { compatRun } from './support/compat-shim.js';

const folder = 'test-results/clustered-shadow',
  baseline = process.argv.includes('--baseline'),
  recordFile = `${folder}/baseline${compatRun() ? '-compat' : ''}.json`;
const hash = (text) => createHash('sha256').update(text).digest('hex');
let browser;
try {
  await mkdir(folder, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/clustered-shadow.html', port: 5308 });
  const page = browser.page,
    pageErrors = [],
    checks = [],
    failures = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.clusteredShadowFixture);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const call = (name, ...args) =>
    page.evaluate(({ name, args }) => window.clusteredShadowFixture[name](...args), { name, args });
  function check(name, ok, detail) {
    checks.push({ name, ok, ...detail });
    if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
  }
  async function capture(label) {
    const file = `${folder}/${baseline ? 'baseline-' : ''}${label}${compatRun() ? '-compat' : ''}.png`;
    await page.locator('canvas').screenshot({ path: file });
    return file;
  }
  // Floor and block-top points for the shadow-off scenes.
  const offPoints = [];
  for (let x = -3; x <= 3; x += 0.5) for (let z = -3; z <= 3; z += 1) offPoints.push([x, 0, z, 0, 1, 0]);
  for (let x = -0.4; x <= 0.4; x += 0.2) offPoints.push([x, 1.5, 0, 0, 1, 0]);
  const meshes = ['floor', 'block'],
    point = { position: [2, 3, 1], range: 12, intensity: 3 },
    sun = { direction: [0.3, -1, 0.2], intensity: 0.5 },
    area = { position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 0.6 };
  const offScenes = {
    'off-local': { meshes, points: [{ ...point, castShadow: true }], suns: [sun], areas: [area] },
    'off-none': { meshes, local: false, points: [point], suns: [sun], areas: [area] },
    'off-two-sided': {
      meshes,
      points: [{ ...point, castShadow: true }],
      suns: [sun, { direction: [0, -1, 0] }],
      areas: [area, { ...area, position: [0, 2, 2], direction: [0, 0, -1], twoSided: true }],
    },
  };
  const record = {};
  for (const [label, config] of Object.entries(offScenes)) {
    await call('scene', config);
    const { shader } = await call('render', 2);
    record[label] = {
      shader: hash(shader),
      probe: await call('probe', offPoints),
      image: await capture(label),
    };
  }
  if (baseline) {
    await writeFile(recordFile, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({ baseline: recordFile, scenes: Object.keys(record) }, null, 2));
  } else {
    const saved = await readFile(recordFile, 'utf8').catch(() => null),
      before = saved ? JSON.parse(saved) : {};
    if (!saved) console.log(`No ${recordFile}: the shadow-off scenes were not compared with an earlier build.`);
    for (const [label, now] of saved ? Object.entries(record) : []) {
      const old = before[label];
      check(`${label}: lit shader text unchanged with the new shadows off`, now.shader === old.shader, {
        before: old.shader,
        after: now.shader,
      });
      let max = 0;
      now.probe.forEach((rgb, i) => rgb.forEach((v, c) => (max = Math.max(max, Math.abs(v - old.probe[i][c])))));
      check(`${label}: clusterLighting radiance at ${offPoints.length} points unchanged`, max === 0, {
        maxDifference: max,
      });
      const a = await decodePNG(await readFile(old.image)),
        b = await decodePNG(await readFile(now.image));
      let changed = 0;
      for (let i = 0; i < a.data.length; i++) changed += +(a.data[i] !== b.data[i]);
      check(
        `${label}: rendered image identical to the pre-change build`,
        changed === 0 && a.data.length === b.data.length,
        {
          changedBytes: changed,
        },
      );
    }
    // Shadow factor = radiance with the shadow / radiance of the same light with castShadow false.
    async function visibility(config, points) {
      const off = structuredClone(config);
      for (const light of [...(off.suns ?? []), ...(off.areas ?? [])]) light.castShadow = false;
      // An unshadowed point or spot light may not keep a shadow object without ClusteredOptions.shadows.
      for (const light of off.points ?? []) {
        light.castShadow = false;
        delete light.shadow;
      }
      await call('scene', off);
      await call('render', 1);
      const open = await call('probe', points);
      await call('scene', config);
      // The first frame's stats count the layers drawn; the second is the cached one probed.
      const rendered = await call('render', 1);
      await call('render', 1);
      const shadowed = await call('probe', points);
      return {
        rendered,
        values: points.map((_, i) => {
          const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
            unshadowed = lum(open[i]);
          return unshadowed > 1e-6 ? lum(shadowed[i]) / unshadowed : NaN;
        }),
      };
    }
    // `expected` gives 0 (occluded), 1 (lit) or undefined (not checked) per point; both kinds must occur unless lit only.
    function expect(name, points, values, expected, litOnly = false) {
      let worst = 0,
        at,
        occluded = 0,
        lit = 0;
      points.forEach((p, i) => {
        const want = expected(p);
        if (want === undefined) return;
        if (want === 0) occluded++;
        else lit++;
        const error = Math.abs(values[i] - want);
        if (!(error <= worst)) {
          worst = error;
          at = { point: p.slice(0, 3), visibility: values[i], expected: want };
        }
      });
      check(name, worst <= 0.05 && lit > 0 && (litOnly || occluded > 0), {
        occluded,
        lit,
        worstError: worst,
        at,
        tolerance: 0.05,
      });
    }
    // Directional: a 1 x 0.5 x 1 block (y 1 to 1.5) above the floor (y 0).
    const line = (z, y = 0, normal = [0, 1, 0], from = -2, to = 2, step = 0.05) => {
      const out = [];
      for (let x = from; x <= to + 1e-9; x += step) out.push([+x.toFixed(4), y, z, ...normal]);
      return out;
    };
    const floor = [...line(0), ...line(0.25), ...line(-0.8)];
    const inside = (lo, hi, margin) => (v) => v > lo + margin && v < hi - margin,
      outside = (lo, hi, margin) => (v) => v < lo - margin || v > hi + margin;
    const shadowExpectation = (x0, x1, margin) => (p) =>
      inside(x0, x1, margin)(p[0]) && inside(-0.5, 0.5, margin)(p[2])
        ? 0
        : outside(x0, x1, margin)(p[0]) || outside(-0.5, 0.5, margin)(p[2])
          ? 1
          : undefined;
    const bounds = { min: [-3, -0.2, -3], max: [3, 2, 3] };
    for (const [label, direction, x0, x1, shadow, margin] of [
      ['directional bounds, straight down', [0, -1, 0], -0.5, 0.5, { bounds }, 0.06],
      ['directional bounds, slanted', [1, -2, 0], 0, 1.25, { bounds }, 0.06],
      ['directional camera-fitted cascades, slanted', [1, -2, 0], 0, 1.25, { cascades: 3, distance: 30 }, 0.3],
    ]) {
      const config = { meshes, suns: [{ direction, intensity: 3, castShadow: true, shadow }] },
        { values, rendered } = await visibility(config, floor);
      expect(`${label}: occluded floor points 0, lit points 1`, floor, values, shadowExpectation(x0, x1, margin));
      const top = line(0, 1.5, [0, 1, 0], -0.4, 0.4, 0.1),
        topValues = (await visibility(config, top)).values;
      expect(`${label}: the lit block top casts no acne on itself`, top, topValues, () => 1, true);
      await capture(label.replace(/[^a-z]+/g, '-'));
      const again = await call('render', 1);
      check(`${label}: a static frame re-renders no shadow layer`, again.stats.layers === 0, {
        layersFirstFrame: rendered.stats.layers,
        layersAgain: again.stats.layers,
      });
      if (!shadow.bounds) {
        await call('camera', [1, 8, 8]);
        const moved = await call('render', 1);
        check(`${label}: a camera move re-fits and re-renders the cascades`, moved.stats.layers === 3, {
          layers: moved.stats.layers,
        });
        await call('camera', [0, 8, 8]);
      }
      const compiled = await call('compile');
      check(
        `${label}: WGSL compiles without errors or warnings`,
        !compiled.core.length && !compiled.probe.length,
        compiled,
      );
    }
    // Area: a W-wide light at y 3 facing down, a bar 1 wide (x -0.5 to 0.5) at y 1.5, the floor at y 0. Each floor
    // point x sees the light through |x + xL| >= 2B (B = 0.5): umbra |x| < 2B - W/2, fully lit |x| > 2B + W/2, and a
    // penumbra of width W (W (d_receiver - d_blocker) / d_blocker with d 3 and 1.5) between.
    const ramp = line(0, 0, [0, 1, 0], 0, 2.4, 0.02),
      widths = {};
    for (const W of [0.4, 1.2]) {
      const config = {
          meshes: ['floor', 'bar'],
          areas: [
            {
              position: [0, 3, 0],
              direction: [0, -1, 0],
              width: W,
              height: 0.4,
              intensity: 5,
              castShadow: true,
              shadow: { far: 20 },
            },
          ],
        },
        { values, rendered } = await visibility(config, ramp),
        umbra = 1 - W / 2,
        lit = 1 + W / 2;
      expect(`area ${W} wide: umbra floor points 0, fully lit points 1`, ramp, values, (p) =>
        p[0] < umbra - 0.1 ? 0 : p[0] > lit + 0.1 ? 1 : undefined,
      );
      const cross = (level) => ramp.find((p, i) => values[i] >= level)?.[0];
      widths[W] = { from10: cross(0.1), to90: cross(0.9), analytic: [umbra, lit] };
      widths[W].measured = widths[W].to90 - widths[W].from10;
      await capture(`area-${W}`);
      const again = await call('render', 1);
      check(`area ${W} wide: a static frame re-renders no shadow layer`, again.stats.layers === 0, {
        layersFirstFrame: rendered.stats.layers,
        layersAgain: again.stats.layers,
      });
      check(`area ${W} wide: one-sided lights render five cube faces`, rendered.stats.layers === 5, rendered.stats);
      const compiled = await call('compile');
      check(
        `area ${W} wide: WGSL compiles without errors or warnings`,
        !compiled.core.length && !compiled.probe.length,
        compiled,
      );
    }
    // The 10-90% rise of a disk-filtered edge spans 1.37 R = 0.69 W, of the exact (uniform) light 0.8 W.
    check(
      'area penumbra widens with the light: 1.2 wide vs 0.4 wide',
      widths[1.2].measured > 2 * widths[0.4].measured,
      {
        widths,
      },
    );
    for (const W of [0.4, 1.2]) {
      const ratio = widths[W].measured / (0.8 * W);
      check(`area ${W} wide: 10-90% penumbra within 0.5-1.5x of the analytic 0.8 W`, ratio > 0.5 && ratio < 1.5, {
        measured: widths[W].measured,
        analytic: 0.8 * W,
        ratio,
      });
    }
    // Point and spot lights with a shadow radius R (PCSS): a sphere light at height H over the same bar (y 1.5, x -0.5
    // to 0.5) and floor. The hard edge falls at x = 0.5 H / (H - 1.5). Blocker depth H - 1.5, receiver depth H, so the
    // penumbra's half width on the floor is R s with s = 1.5 / (H - 1.5), and a disc light's 10-90% rise (the visible
    // share past offset t of a disc is (acos(t / R) - (t / R) sqrt(1 - (t / R)^2)) / pi) is 1.374 R s wide.
    // KB-LOCALSHADOW-OFFSET1: hard point and spot shadow edges stay on their casters. A light at height 2 over the bar
    // (top face y 1.525, x -0.5 to 0.5) casts the bar's far top edge onto the floor about 3.8 m away at 58 degrees from
    // the floor's normal, with 256 px maps as the Cabin Hearth's lantern. The edge falls where the ray over the corner
    // (0.5, 1.525) meets the floor. Across it the receiver's visibility rises from 0 to 1, and its 50% crossing is the
    // filtered edge. A rasterized edge lands on texel centres, so one crossing is off the true edge by up to half a texel
    // on the floor whichever bias is used: the light steps 16 times over 4 cm of x (the edge moves about 2.3 texels
    // through every rounding phase), and the mean of the crossings is the biases' own shift. A normal offset of k
    // texels moves an edge k tan(theta) texels toward the light (the depth offsets move none), so the default 0.25
    // puts it 0.4 texel (1.2 cm) out; the mean must sit within a quarter texel of that. The old offsets (1 texel toward
    // the light and 1.5 along the normal) put it 2.8 texels (7.1 cm) out for the point light and 2.4 (3.9 cm) for the spot.
    const hardEdges = {};
    for (const kind of ['point', 'spot']) {
      // The spot keeps one direction, at the first edge, so the edge sweeps across its map as the light moves.
      const shifts = [],
        expected = [],
        texels = [],
        aim = [(0.78 * 2) / 0.475, -2, 0].map((v, _i, a) => v / Math.hypot(...a));
      for (let k = 0; k < 16; k++) {
        const lx = -0.28 + k * 0.0025,
          H = 2,
          edge = lx + ((0.5 - lx) * H) / (H - 1.525),
          ramp3 = line(0, 0, [0, 1, 0], edge - 0.3, edge + 0.3, 0.0025),
          distance = Math.hypot(edge - lx, H),
          light = {
            position: [lx, H, 0],
            range: 20,
            intensity: 5,
            castShadow: true,
            shadow: { far: 20 },
            ...(kind === 'spot' ? { direction: aim, outerAngle: 0.5 } : {}),
          },
          { values } = await visibility({ meshes: ['floor', 'bar'], local: { resolution: 256 }, points: [light] }, ramp3),
          i = values.findIndex((v, j) => j > 0 && values[j - 1] < 0.5 && v >= 0.5),
          x50 = ramp3[i - 1][0] + ((0.5 - values[i - 1]) / (values[i] - values[i - 1])) * 0.0025,
          // The texel size the shader offsets by: a 90-degree cube face, or the spot's cone with its 2-texel margins,
          // over 256 texels per unit distance, times the distance.
          texel = ((kind === 'spot' ? (2 * Math.tan(0.5) * 256) / 252 : 2) / 256) * distance;
        // Positive: the lit side runs past the geometric edge into the shadow (toward the light).
        shifts.push(edge - x50);
        expected.push(0.25 * texel * ((edge - lx) / H));
        texels.push(texel);
      }
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length,
        texel = mean(texels),
        off = mean(shifts) - mean(expected);
      hardEdges[kind] = {
        leakCm: +(mean(shifts) * 100).toFixed(2),
        normalOffsetCm: +(mean(expected) * 100).toFixed(2),
        texelCm: +(texel * 100).toFixed(2),
        crossingsCm: shifts.map((s) => +(s * 100).toFixed(2)),
      };
      check(
        `${kind} 256 px hard edge at 58 degrees: the mean 50% crossing within a quarter texel of the 0.25-texel normal offset's shift`,
        Math.abs(off) < 0.25 * texel,
        hardEdges[kind],
      );
    }
    console.log(JSON.stringify({ hardEdges }));
    // No acne at grazing angles: a light 0.4 above the floor lights it at 80 to 85 degrees from its normal, where a
    // texel's footprint on the floor is 6 to 11 texels long and a depth compare against the receiver's own depth fails
    // half way across it (the old offsets: visibility down to 0.87), and a light 2 above at 49 to 66 degrees. Nothing
    // casts onto the floor, so every point must be fully lit, within float rounding. A shading normal is often off the
    // true surface (normal maps, smooth vertex normals): the floor with normals tilted 10 degrees toward, away from and
    // across the light must stay lit at 49 to 66 degrees with the defaults, and at 80 to 85 degrees with slopeBias 2
    // (with 0 the plane from a normal tilted toward so grazing a light rises a third as fast as the floor: documented
    // in docs/limits.md). A normal turned past the light is skipped.
    const tilt = (10 * Math.PI) / 180,
      tilted = [
        [Math.sin(tilt), Math.cos(tilt), 0],
        [-Math.sin(tilt), Math.cos(tilt), 0],
        [0, Math.cos(tilt), Math.sin(tilt)],
      ],
      floorLine = (normals) => {
        const out = [];
        for (const normal of normals)
          for (let z = -0.6; z <= 0.6 + 1e-9; z += 0.3) out.push(...line(+z.toFixed(2), 0, normal, -1.2, 1.05, 0.0125));
        return out;
      };
    for (const kind of ['point', 'spot'])
      for (const [label, height, normals, options] of [
        ['true normals at 80 to 85 degrees', 0.4, [[0, 1, 0]], {}],
        ['true normals at 49 to 66 degrees', 2, [[0, 1, 0]], {}],
        ['normals tilted 10 degrees at 49 to 66 degrees', 2, tilted, {}],
        ['normals tilted 10 degrees at 80 to 85 degrees, slopeBias 2', 0.4, tilted, { slopeBias: 2 }],
      ]) {
        const grazing = floorLine(normals),
          toward = [3.5, -height, 0].map((v, _i, a) => v / Math.hypot(...a)),
          lamp = {
            position: [-3.5, height, 0],
            range: 20,
            intensity: 5,
            castShadow: true,
            shadow: { far: 20 },
            ...(kind === 'spot' ? { direction: toward, outerAngle: 0.7 } : {}),
          },
          { values } = await visibility(
            { meshes: ['floor'], local: { resolution: 256, ...options }, points: [lamp] },
            grazing,
          );
        let darkest = 1,
          at,
          checked = 0;
        values.forEach((v, i) => {
          if (Number.isNaN(v)) return;
          checked++;
          if (v < darkest) {
            darkest = v;
            at = grazing[i].map((c) => +c.toFixed(3));
          }
        });
        check(`${kind} 256 px: a lit floor has no acne, ${label}`, darkest >= 0.999 && checked > grazing.length / 2, {
          darkest,
          at,
          checked,
          points: grazing.length,
        });
      }
    // No peter-panning: the 0.1-high pebble (x -0.2 to 0.2) on the floor, lit from (-3.5, 2, 0), shades the floor from its
    // far side at x 0.2 to x 0.2 + 0.1 tan(theta), 0.385 at 62 degrees. A depth bias lifted too far toward the light
    // (or a normal offset) lights the floor next to the pebble: the floor from x 0.23 to 0.355 must stay dark.
    const behind = line(0, 0, [0, 1, 0], 0.21, 0.35, 0.005);
    for (const kind of ['point', 'spot']) {
      const lamp = {
          position: [-3.5, 2, 0],
          range: 20,
          intensity: 5,
          castShadow: true,
          shadow: { far: 20 },
          ...(kind === 'spot' ? { direction: [3.7, -2, 0].map((v, _i, a) => v / Math.hypot(...a)), outerAngle: 0.5 } : {}),
        },
        { values } = await visibility({ meshes: ['floor', 'pebble'], local: { resolution: 1024 }, points: [lamp] }, behind),
        brightest = Math.max(...values);
      check(`${kind} 1024 px: the floor behind a 0.1-high pebble stays in its shadow (no peter-panning)`, brightest <= 0.001, {
        brightest,
        at: behind[values.indexOf(brightest)][0],
        values: values.map((v) => +v.toFixed(3)),
      });
    }
    // KB-SUNSHADOW-OFFSET1: directional hard shadow edges stay on their casters too. A sun at 58 degrees from the floor's
    // normal (travelling +x, down) casts the bar's far top corner (0.5, 1.525) onto the floor at 0.5 + 1.525 tan(theta),
    // with a 256 px map over the bounds x -4 to 4, y -0.2 to 2, z -1 to 1: a texel is (8 cos + 2.2 sin) / 252 m, 2.42 cm.
    // The bounds step 16 times along x over two texels' worth of the map's grid (the grid moves cos(theta) per unit x),
    // so the edge lands at every rounding phase, and the mean of the 50% crossings is the biases' own shift: the
    // 0.25-texel normal offset's 0.25 tan(theta) texels, within a quarter texel. The old filter (flat compare, 1.5 texels
    // along the normal) put it 2.4 texels (5.82 cm) out, the leak the KB row measured.
    const sunEdge = { shifts: [], expected: [], texels: [] },
      theta = (58 * Math.PI) / 180,
      sunTexel = (8 * Math.cos(theta) + 2.2 * Math.sin(theta)) / 252,
      sunEdgeX = 0.5 + 1.525 * Math.tan(theta),
      ramp4 = line(0, 0, [0, 1, 0], sunEdgeX - 0.3, sunEdgeX + 0.3, 0.0025);
    for (let k = 0; k < 16; k++) {
      const dx = (k * 2 * sunTexel) / (16 * Math.cos(theta)),
        sunLight = {
          direction: [Math.sin(theta), -Math.cos(theta), 0],
          intensity: 3,
          castShadow: true,
          shadow: { bounds: { min: [-4 + dx, -0.2, -1], max: [4 + dx, 2, 1] } },
        },
        { values } = await visibility({ meshes: ['floor', 'bar'], local: { resolution: 256 }, suns: [sunLight] }, ramp4),
        i = values.findIndex((v, j) => j > 0 && values[j - 1] < 0.5 && v >= 0.5),
        x50 = ramp4[i - 1][0] + ((0.5 - values[i - 1]) / (values[i] - values[i - 1])) * 0.0025;
      sunEdge.shifts.push(sunEdgeX - x50);
      sunEdge.expected.push(0.25 * sunTexel * Math.tan(theta));
      sunEdge.texels.push(sunTexel);
    }
    {
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length,
        texel = mean(sunEdge.texels),
        off = mean(sunEdge.shifts) - mean(sunEdge.expected);
      hardEdges.directional = {
        leakCm: +(mean(sunEdge.shifts) * 100).toFixed(2),
        normalOffsetCm: +(mean(sunEdge.expected) * 100).toFixed(2),
        texelCm: +(texel * 100).toFixed(2),
        crossingsCm: sunEdge.shifts.map((s) => +(s * 100).toFixed(2)),
      };
      check(
        'directional 256 px hard edge at 58 degrees: the mean 50% crossing within a quarter texel of the 0.25-texel normal offset\'s shift',
        Math.abs(off) < 0.25 * texel,
        hardEdges.directional,
      );
      console.log(JSON.stringify({ directionalHardEdge: hardEdges.directional }));
    }
    // Directional acne at grazing angles: a sun at 80 and 85 degrees, and at 49 and 66, from the floor's normal, nothing
    // casting, so every floor point must be fully lit; the floor with normals tilted 10 degrees with the defaults at 49 and
    // 66 degrees, and with slopeBias 2 at 80 and 85 (as for point and spot lights above). The flat compare with 0.25
    // texels along the normal shows acne at all of them.
    for (const [label, angles, normals, options] of [
      ['true normals at 80 and 85 degrees', [80, 85], [[0, 1, 0]], {}],
      ['true normals at 49 and 66 degrees', [49, 66], [[0, 1, 0]], {}],
      ['normals tilted 10 degrees at 49 and 66 degrees', [49, 66], tilted, {}],
      ['normals tilted 10 degrees at 80 and 85 degrees, slopeBias 2', [80, 85], tilted, { slopeBias: 2 }],
    ]) {
      const grazing = floorLine(normals);
      let darkest = 1,
        at,
        checked = 0;
      for (const angle of angles) {
        const a = (angle * Math.PI) / 180,
          { values } = await visibility(
            {
              meshes: ['floor'],
              local: { resolution: 256, ...options },
              suns: [{ direction: [Math.sin(a), -Math.cos(a), 0], intensity: 3, castShadow: true, shadow: { bounds: { min: [-2, -0.2, -1], max: [2, 0.2, 1] } } }],
            },
            grazing,
          );
        values.forEach((v, i) => {
          if (Number.isNaN(v)) return;
          checked++;
          if (v < darkest) {
            darkest = v;
            at = [angle, ...grazing[i].map((c) => +c.toFixed(3))];
          }
        });
      }
      check(`directional 256 px: a lit floor has no acne, ${label}`, darkest >= 0.999 && checked > grazing.length, {
        darkest,
        at,
        checked,
        points: grazing.length * angles.length,
      });
    }
    // Directional peter-panning: a sun at 60 degrees from (-3.5, 2, 0), the 0.1-high pebble shades the floor from x 0.2 to
    // 0.2 + 0.1 tan(theta), 0.375; with a 1024 px map over 2 m the floor from x 0.23 to 0.355 must stay dark.
    {
      const { values } = await visibility(
          {
            meshes: ['floor', 'pebble'],
            local: { resolution: 1024 },
            suns: [{ direction: [3.5, -2, 0], intensity: 3, castShadow: true, shadow: { bounds: { min: [-1, -0.2, -1], max: [1, 0.3, 1] } } }],
          },
          behind,
        ),
        brightest = Math.max(...values);
      check('directional 1024 px: the floor behind a 0.1-high pebble stays in its shadow (no peter-panning)', brightest <= 0.001, {
        brightest,
        at: behind[values.indexOf(brightest)][0],
        values: values.map((v) => +v.toFixed(3)),
      });
    }
    const softWidths = {};
    for (const [kind, R, H] of [
      ['point', 0.2, 3],
      ['point', 0.4, 3],
      ['point', 0.4, 4.5],
      ['spot', 0.4, 3],
    ]) {
      const edge = (0.5 * H) / (H - 1.5),
        scale = 1.5 / (H - 1.5),
        analytic = 1.374 * R * scale,
        ramp2 = line(0, 0, [0, 1, 0], Math.max(0, edge - 1.2), edge + 1.2, 0.02),
        light = {
          position: [0, H, 0],
          range: 20,
          intensity: 5,
          castShadow: true,
          shadow: { radius: R, far: 20 },
          ...(kind === 'spot' ? { direction: [0, -1, 0], outerAngle: 1.1 } : {}),
        },
        label = `${kind} radius ${R} at height ${H}`,
        { values, rendered } = await visibility(
          { meshes: ['floor', 'bar'], local: { resolution: 1024 }, points: [light] },
          ramp2,
        );
      // Umbra and full light: the analytic edges R scale from the hard edge, plus a margin of the filter's spread.
      expect(`${label}: umbra floor points 0, fully lit points 1`, ramp2, values, (p) =>
        p[0] < edge - R * scale - 0.1 ? 0 : p[0] > edge + R * scale + 0.1 ? 1 : undefined,
      );
      const cross = (level) => ramp2.find((p, i) => values[i] >= level)?.[0];
      softWidths[label] = { from10: cross(0.1), to90: cross(0.9), analytic };
      softWidths[label].measured = softWidths[label].to90 - softWidths[label].from10;
      const ratio = softWidths[label].measured / analytic;
      check(
        `${label}: 10-90% penumbra within 0.8-1.2x of the analytic ${analytic.toFixed(3)}`,
        ratio > 0.8 && ratio < 1.2,
        {
          ...softWidths[label],
          ratio,
        },
      );
      check(
        `${label}: ${kind === 'spot' ? 'one layer' : 'six cube faces'} rendered`,
        rendered.stats.layers === (kind === 'spot' ? 1 : 6),
        rendered.stats,
      );
      const compiled = await call('compile');
      check(
        `${label}: WGSL compiles without errors or warnings`,
        !compiled.core.length && !compiled.probe.length,
        compiled,
      );
      await capture(`soft-${kind}-${R}-${H}`);
    }
    check(
      'soft point penumbra widens with the light: radius 0.4 vs 0.2',
      softWidths['point radius 0.4 at height 3'].measured > 1.5 * softWidths['point radius 0.2 at height 3'].measured,
      softWidths,
    );
    check(
      'soft point penumbra widens with the receiver behind its blocker: (H - 1.5) / 1.5 of 1 vs 0.5',
      softWidths['point radius 0.4 at height 3'].measured > 1.5 * softWidths['point radius 0.4 at height 4.5'].measured,
      softWidths,
    );
    // KB-PCSS-BLOCK1: no stair steps inside a penumbra. The bar's straight edge seen from a light of radius rho (on the
    // floor) has visibility 1 - seg((x - edge) / rho), seg(u) = (acos(u) - u sqrt(1 - u^2)) / pi. One tap pattern
    // shared by every pixel drew that ramp as 24 shifted hard shadows: treads at whole multiples of 1/24, each step
    // one shadow texel wide, which a close camera (a texel about 2.5 pixels here) shows as blocks. On a tread the mean
    // over a strip of pixels along the edge (z, 381 rows 1.1 pixels apart) is a whole number of taps, so wherever the
    // curve passes between two multiples the mean is half a tap (1/48) or more off it. With each pixel's spiral turned
    // and its rings moved by its screen noise, the mean follows the curve within 1/48 once shifted by the receiver's
    // bias (fitted, at most 0.02, under three texels): measured 0.053 to 0.058 before, 0.009 to 0.012 after. The step
    // between neighbouring columns is logged, not bounded: per-pixel noise left in a 381-row mean makes it 0.012 to
    // 0.016 either way. The area light's taps fill an ellipse of its half extents, so rho = W / 2.
    await call('camera', [1, 0.75, 0.25], [1, 0, 0]);
    const pixel = (0.79 * Math.tan((25 * Math.PI) / 180)) / 128,
      strip = [];
    for (let k = -190; k <= 190; k++) strip.push(+(k * 1.1 * pixel).toFixed(5));
    const steps = {};
    for (const [label, light, edge, rho] of [
      [
        'point radius 0.4 at height 3',
        {
          points: [
            { position: [0, 3, 0], range: 20, intensity: 5, castShadow: true, shadow: { radius: 0.4, far: 20 } },
          ],
        },
        1,
        0.4,
      ],
      [
        'point radius 0.2 at height 3',
        {
          points: [
            { position: [0, 3, 0], range: 20, intensity: 5, castShadow: true, shadow: { radius: 0.2, far: 20 } },
          ],
        },
        1,
        0.2,
      ],
      [
        'area 1.2 wide',
        {
          areas: [
            {
              position: [0, 3, 0],
              direction: [0, -1, 0],
              width: 1.2,
              height: 0.4,
              intensity: 5,
              castShadow: true,
              shadow: { far: 20 },
            },
          ],
        },
        1,
        0.6,
      ],
    ]) {
      const xs = [];
      for (let x = edge - rho - 0.03; x <= edge + rho + 0.03 + 1e-9; x += pixel) xs.push(+x.toFixed(5));
      const points = xs.flatMap((x) => strip.map((z) => [x, 0, z, 0, 1, 0])),
        { values } = await visibility({ meshes: ['floor', 'bar'], local: { resolution: 1024 }, ...light }, points),
        mean = xs.map((_, i) => strip.reduce((sum, _z, k) => sum + values[i * strip.length + k], 0) / strip.length),
        seg = (u) => (u >= 1 ? 0 : u <= -1 ? 1 : (Math.acos(u) - u * Math.sqrt(1 - u * u)) / Math.PI);
      let step = 0,
        stepAt,
        fit = { distance: Infinity };
      mean.forEach((v, i) => {
        if (i && Math.abs(v - mean[i - 1]) > step) {
          step = Math.abs(v - mean[i - 1]);
          stepAt = xs[i];
        }
      });
      for (let shift = -0.02; shift <= 0.02 + 1e-9; shift += 0.0005) {
        let distance = 0;
        mean.forEach((v, i) => (distance = Math.max(distance, Math.abs(v - (1 - seg((xs[i] - edge - shift) / rho))))));
        if (distance < fit.distance) fit = { distance, shift: +shift.toFixed(4) };
      }
      steps[label] = { largestStep: step, at: stepAt, fit };
      check(
        `${label}: the strip mean follows the exact disc-light penumbra within half a tap (1/48)`,
        fit.distance <= 1 / 48,
        {
          ...fit,
          bound: 1 / 48,
        },
      );
    }
    console.log(JSON.stringify({ penumbraSteps: steps }));
    await call('camera', [0, 8, 8]);
    // twoSided: the back face shadows the ceiling (y 6) through a bar at y 4.5, as the front face shadows the floor.
    const twoSided = {
        meshes: ['floor', 'bar', 'ceiling', 'topBar'],
        areas: [
          {
            position: [0, 3, 0],
            direction: [0, -1, 0],
            width: 0.4,
            height: 0.4,
            intensity: 5,
            twoSided: true,
            castShadow: true,
            shadow: { far: 20 },
          },
        ],
      },
      both = [...line(0, 0, [0, 1, 0], 0, 2.4, 0.1), ...line(0, 6, [0, -1, 0], 0, 2.4, 0.1)],
      { values: bothValues, rendered: bothRendered } = await visibility(twoSided, both);
    expect('two-sided area light: umbra 0 and lit 1 on the floor and on the ceiling', both, bothValues, (p) =>
      p[0] < 0.7 ? 0 : p[0] > 1.3 ? 1 : undefined,
    );
    check('two-sided area light renders six cube faces', bothRendered.stats.layers === 6, bothRendered.stats);
    await capture('area-two-sided');
    // Terrain as a local caster (drawLocalShadow): a ridge 2 high over |x| < 0.5 shadows the ground behind it from a
    // spot and a point light at (-3, 1.5, 0); the line over its near top edge rises, so all of x > 0.5 is in shadow.
    await call('camera', [0.5, 6, 0.5]);
    const ground = [];
    for (let x = -2.5; x <= 3.5; x += 0.25) ground.push([x, 0, 0, 0, 1, 0]);
    const behindRidge = (p) => (p[0] <= -0.9 ? 1 : p[0] >= 0.9 ? 0 : undefined);
    const lamps = {
      spot: { position: [-3, 1.5, 0], direction: [0.958, -0.287, 0], outerAngle: 1.3, range: 12, intensity: 3 },
      point: { position: [-3, 1.5, 0], range: 12, intensity: 3 },
    };
    for (const [kind, lamp] of Object.entries(lamps)) {
      const caster = { meshes: [], terrain: true, points: [{ ...lamp, castShadow: true }] },
        { values, rendered } = await visibility(caster, ground);
      expect(
        `terrain casts into a ${kind} light's map: ground behind the ridge 0, in front 1`,
        ground,
        values,
        behindRidge,
      );
      check(
        `terrain ${kind} caster draws once per layer`,
        rendered.stats.draws === (kind === 'point' ? 6 : 1),
        rendered.stats,
      );
      await capture(`terrain-${kind}`);
    }
    await call('camera', [0, 8, 8]);
    // Everything at once: two shadowed directional lights, two shadowed area lights and a shadowed point light.
    await call('scene', {
      meshes: ['floor', 'block'],
      points: [{ ...point, castShadow: true }],
      suns: [
        { direction: [1, -2, 0], intensity: 2, castShadow: true, shadow: { bounds } },
        {
          direction: [-0.5, -2, 0.3],
          intensity: 1,
          castShadow: true,
          shadow: { cascades: 2, distance: 20, resolution: 256 },
        },
      ],
      areas: [
        { ...area, castShadow: true, shadow: { far: 20 } },
        {
          ...area,
          position: [0, 2, 2],
          direction: [0, 0, -1],
          twoSided: true,
          castShadow: true,
          shadow: { far: 20, resolution: [256, 128] },
        },
      ],
    });
    const all = await call('render', 1),
      compiled = await call('compile');
    await call('render', 1);
    // 6 point faces + 1 bounds map + 2 cascades + 5 + 6 area faces.
    check(
      'all shadow kinds together compile and render without validation errors',
      !compiled.core.length && !compiled.probe.length && all.stats.layers === 20,
      { ...compiled, stats: all.stats },
    );
    await capture('all-kinds');
  }
  {
    // Contact shadows (ContactLights): a 0.1-high pebble on the floor and a low point light to its +x side, no shadow
    // maps. Floor points just past the pebble on the far side march through it (factor 0 at strength 1); points on the
    // light's side, beside it and far away keep the light exactly. Radiance with strength 1 over strength 0.
    await call('camera', [0, 8, 8]);
    const lamp = { position: [1.5, 0.4, 0], range: 10, intensity: 3 },
      shaded = [
        [-0.3, 0, 0, 0, 1, 0],
        [-0.25, 0, 0.1, 0, 1, 0],
        [-0.28, 0, -0.1, 0, 1, 0],
      ],
      open = [
        [0.3, 0, 0, 0, 1, 0],
        [-1.5, 0, 0, 0, 1, 0],
        [-0.3, 0, 1, 0, 1, 0],
        [0, 0.1, 0, 0, 1, 0],
      ],
      sum = (rgb) => rgb[0] + rgb[1] + rgb[2];
    await call('scene', {
      meshes: ['floor', 'pebble'],
      local: false,
      points: [lamp],
      contact: { distance: 0.6, thickness: 0.2, steps: 24, strength: 1 },
    });
    const rendered = await call('render', 2),
      compiled = await call('compile'),
      on = await call('probe', [...shaded, ...open]);
    await capture('contact');
    await call('contactStrengths', [0]);
    await call('render', 1);
    const off = await call('probe', [...shaded, ...open]),
      ratios = on.map((rgb, i) => sum(rgb) / sum(off[i]));
    check(
      'contact shadows compile into the core and probe shaders',
      !compiled.core.length && !compiled.probe.length && rendered.shader.includes('clusterContact('),
      compiled,
    );
    check(
      'contact: floor points behind a 0.1-high pebble lose the light (strength 1)',
      ratios.slice(0, shaded.length).every((r) => r === 0) && off.slice(0, shaded.length).every((rgb) => sum(rgb) > 0),
      { ratios },
    );
    check(
      'contact: points on the light side, beside, far away and on top keep it exactly',
      ratios.slice(shaded.length).every((r) => r === 1),
      { ratios },
    );
  }
  {
    // Raised caps: 1,500 point lights (one page past 1,024) and 100 area lights, all far below the floor but one
    // each over the origin, at index 1,400 and 80. The probe sees exactly those: lights past the old caps are culled,
    // uploaded and shaded.
    await call('camera', [0, 8, 8]);
    const far = (i) => ({ position: [i % 40, -50, Math.floor(i / 40)], range: 1, intensity: 1 }),
      lamp = { position: [0, 1, 0], range: 3, intensity: 3 },
      points = Array.from({ length: 1500 }, (_, i) => (i === 1400 ? lamp : far(i))),
      rect = { direction: [0, -1, 0], width: 0.5, height: 0.5, intensity: 0 },
      areas = Array.from({ length: 100 }, (_, i) =>
        i === 80 ? { ...rect, position: [0, 1, 0], intensity: 2 } : { ...rect, position: [i, -50, 0] },
      ),
      probe = [[0, 0, 0, 0, 1, 0]],
      sum = (rgb) => rgb[0] + rgb[1] + rgb[2],
      lit = async (config) => {
        await call('scene', { meshes: ['floor'], local: false, ...config });
        await call('render', 1);
        return sum((await call('probe', probe))[0]);
      };
    const both = await lit({ maxLights: 1500, areaMaxLights: 100, points, areas }),
      compiled = await call('compile'),
      pointOnly = await lit({ maxLights: 1500, points }),
      areaOnly = await lit({ areaMaxLights: 100, points: [], areas }),
      none = await lit({ maxLights: 1500, points: points.map((p, i) => (i === 1400 ? far(i) : p)) });
    check(
      'raised caps compile: 1,500 point lights, 100 area lights',
      !compiled.core.length && !compiled.probe.length,
      compiled,
    );
    check(
      'raised caps: light 1,400 and area light 80 light the origin, and only they do',
      pointOnly > 0 && areaOnly > 0 && Math.abs(both - pointOnly - areaOnly) <= 1e-4 * both && none < 1e-6,
      { both, pointOnly, areaOnly, none },
    );
    // A cluster lists at most 1,024 lights (the documented cap): 1,100 identical lamps over the origin light it exactly
    // 1,024 times as much as one. Without the cap in the culling shader the cluster wrote 1,100 indices into its 1,024
    // slots and the next cluster's, and the probe shaded 1,100.
    const one = await lit({ maxLights: 1100, points: [lamp] }),
      crowd = await lit({ maxLights: 1100, points: Array.from({ length: 1100 }, () => lamp) });
    check(
      'a cluster reached by 1,100 lights shades the 1,024 it lists',
      one > 0 && Math.abs(crowd / one - 1024) <= 1024 * 1e-4,
      { one, crowd, ratio: crowd / one },
    );
  }
  check('no page errors', pageErrors.length === 0, { pageErrors });
  const fixtureErrors = await page.evaluate(() => window.clusteredShadowFixture.errors);
  check('no GPU validation or engine errors', fixtureErrors.length === 0, { fixtureErrors });
  if (!baseline) {
    await writeFile(
      `${folder}/gpu.json`,
      JSON.stringify({ hardware: browser.hardware, checks, failures }, null, 2) + '\n',
    );
    console.log(
      JSON.stringify(
        {
          hardware: browser.hardware.webgpu,
          checks: checks.length,
          passed: checks.filter((c) => c.ok).length,
          failures,
          report: `${folder}/gpu.json`,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(failures, [], 'Clustered shadow GPU checks failed');
  } else assert.deepEqual(failures, [], 'Baseline run failed');
} finally {
  await browser?.page.evaluate(() => window.clusteredShadowFixture?.dispose()).catch(() => {});
  await browser?.close();
}
