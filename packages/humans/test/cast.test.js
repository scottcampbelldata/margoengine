// The period cast kit (@margoengine/humans/cast): cloth optics against Sadeghi et al. 2013, bodies against the AIST 2003
// and Army Anthropology 1921 tables, garment sizes against period dimensions, layers that never pass through each
// other at rest, crowd picks, slider rows and the GLB. Every bound names its source.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../dist/cast.js';

const R = Math.PI / 180;
const dir = (theta, phi = 0) => [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tolerance ${tol})`);

test('the measured fabrics carry Table 2 and Table 3 of Sadeghi et al. 2013 as printed', () => {
  const F = C.MEASURED_FABRICS;
  assert.equal(F.linenPlain.eta, 1.46);
  assert.equal(F.silkCrepeDeChine.eta, 1.345);
  assert.equal(F.polyesterSatinCharmeuse.eta, 1.539);
  assert.equal(F.velvet.eta, 1.46);
  const row = (t, a, A, kd, gs, gv) => {
    near(t.a, a, 1e-12, 'area');
    A.forEach((v, i) => near(t.albedo[i], v, 1e-12, 'A'));
    assert.deepEqual([t.kd, t.gammaS, t.gammaV], [kd, gs, gv]);
  };
  row(F.linenPlain.threads[0], 0.33, [0.06, 0.24, 0.3], 0.3, 12, 24);
  row(F.silkCrepeDeChine.threads[0], 0.75, [0.12, 0.114, 0.006], 0.2, 5, 10);
  row(F.silkCrepeDeChine.threads[1], 0.25, [0.16, 0.152, 0.008], 0.3, 18, 32);
  row(F.polyesterSatinCharmeuse.threads[0], 0.9, [0.035, 0.01295, 0.0105], 0.1, 2.5, 5);
  row(F.polyesterSatinCharmeuse.threads[1], 0.1, [0.2, 0.074, 0.06], 0.7, 30, 60);
  row(F.silkShot.threads[0], 0.86, [0.02, 0.2, 0.08], 0.1, 4, 8);
  row(F.silkShot.threads[1], 0.14, [0.6, 0, 0.06], 0.1, 5, 10);
  assert.deepEqual(F.polyesterSatinCharmeuse.threads[0].offsets, [-32, -32, -18, 0, 0, 18, 32, 32]);
  assert.deepEqual(F.velvet.threads[1].lengths, [0.5, 0, 0.5]);
  // The linen row's lost sign: section 3.2.1, linen is orthogonally symmetric.
  assert.deepEqual(F.linenPlain.threads[0].offsets, [-25, 25]);
  // Cotton: Burkinshaw 2016 Table 1.5, n parallel 1.578 and n perpendicular 1.532; wool: keratin 1.55.
  near(C.COTTON_ETA, (1.578 + 1.532) / 2, 1e-12, 'cotton index');
  assert.equal(C.WOOL_ETA, 1.55);
});

test('the fabric BRDF is reciprocal and an isolated thread reflects into its specular cone (Eq. 2 to 13)', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const fabric of Object.values(C.MEASURED_FABRICS))
    for (let k = 0; k < 40; k++) {
      const i = dir(rand() * 1.4, rand() * 6.28),
        r = dir(rand() * 1.4, rand() * 6.28),
        a = C.fabricBRDF(fabric, i, r),
        b = C.fabricBRDF(fabric, r, i);
      for (let c = 0; c < 3; c++) near(a[c], b[c], 1e-12 * Math.max(1, a[c]), `${fabric.name} reciprocity`);
    }
  // A flat silk thread along x: light at theta_i from the normal plane scatters to theta_r = -theta_i (the cone).
  const t = [1, 0, 0],
    n = [0, 0, 1],
    // Surface reflection alone (A = 0): the cone of Eq. 2.
    th = { ...C.MEASURED_FABRICS.silkCrepeDeChine.threads[0], albedo: [0, 0, 0] };
  // The cone: the light at -theta_i stands far above the light 40 degrees either side (20 degrees of theta_h).
  const at = (wi, tr) =>
    C.threadScattering(th, 1.345, t, n, wi, [
      Math.sin(tr * R),
      Math.sin(0.3) * Math.cos(tr * R),
      Math.cos(0.3) * Math.cos(tr * R),
    ])[0];
  for (const ti of [-40, -10, 25, 50]) {
    const wi = [Math.sin(ti * R), 0, Math.cos(ti * R)],
      on = at(wi, -ti);
    for (const off of [-40, 40])
      if (Math.abs(-ti + off) < 85)
        assert.ok(on > 100 * at(wi, -ti + off), `cone at theta_i ${ti}: ${on} against ${at(wi, -ti + off)} at ${off}`);
  }
});

test('linen is orthogonally symmetric and smooth; satin has the sharp highlight the paper measures', () => {
  const linen = C.MEASURED_FABRICS.linenPlain,
    satin = C.MEASURED_FABRICS.polyesterSatinCharmeuse;
  for (const [ti, pi, tr, pr] of [
    [0.3, 0.2, 0.9, 2.1],
    [1.1, 4, 0.4, 1],
  ]) {
    const a = C.fabricBRDF(linen, dir(ti, pi), dir(tr, pr)),
      b = C.fabricBRDF(linen, dir(ti, pi + Math.PI / 2), dir(tr, pr + Math.PI / 2)),
      c = C.fabricBRDF(linen, dir(ti, pi + Math.PI), dir(tr, pr + Math.PI));
    for (let k = 0; k < 3; k++) {
      near(a[k], b[k], 1e-9, 'quarter turn');
      near(a[k], c[k], 1e-9, 'half turn');
    }
  }
  // Section 3.2.1: "linen produces a smooth reflection with no specular peak". Peak over mean in the incidence plane,
  // light 30 degrees off the normal along the warp.
  const peakiness = (f) => {
    const v = [];
    for (let tr = -80; tr <= 80; tr += 2)
      v.push(C.fabricBRDF(f, dir(30 * R), dir(Math.abs(tr) * R, tr < 0 ? 0 : Math.PI))[1]);
    return Math.max(...v) / (v.reduce((s, x) => s + x, 0) / v.length);
  };
  const pl = peakiness(linen),
    ps = peakiness(satin);
  assert.ok(pl < 2.5, `linen has no specular peak: peak / mean ${pl.toFixed(2)}`);
  assert.ok(ps > 2 * pl, `satin's highlight stands out: ${ps.toFixed(2)} against linen ${pl.toFixed(2)}`);
});

test('no measured fabric reflects more light than it receives', () => {
  for (const fabric of Object.values(C.MEASURED_FABRICS))
    for (const ti of [0, 30, 60, 80]) {
      const a = C.fabricAlbedo(fabric, ti * R, 0.4, 32);
      assert.ok(Math.max(...a) <= 1, `${fabric.name} at ${ti} degrees: ${a.map((x) => x.toFixed(3))}`);
    }
});

test('a period fabric reflects its dye colour at normal incidence and the GPU lobes keep that colour', () => {
  for (const kind of C.FABRIC_KINDS) {
    const color = [0.6, 0.25, 0.08],
      a = C.fabricAlbedo(C.periodFabric(kind, color), 0);
    for (let c = 0; c < 3; c++) near(a[c], color[c], 2e-3, `${kind} albedo`);
    const l = C.periodLobes(kind, color),
      e0 = C.sheenAlbedo(1, l.sheenRoughness),
      scale = 1 - Math.max(...l.sheenColor) * e0;
    // Drawn albedo at normal incidence: scale (base + dielectric) + sheen e0, the dielectric part read off the fit.
    const drawn = [0, 1, 2].map((c) => scale * l.baseColor[c] + l.sheenColor[c] * e0);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(drawn[c] - color[c]) < 0.06, `${kind} drawn ${drawn} against ${color}`);
    // The shape the lobes cannot follow (thread masking darkens grazing light) stays bounded: measured 0.22 to 0.47.
    assert.ok(l.fitError < 0.5, `${kind} fit error ${l.fitError}`);
  }
  assert.throws(() => C.periodFabric('nylon', [0.5, 0.5, 0.5]), RangeError);
  assert.throws(() => C.periodFabric('silk', [2, 0, 0]), RangeError);
});

test('bodies carry the AIST 2003 and Army Anthropology 1921 values and their sections have the measured girths', () => {
  const m = C.BODIES.japan2003Man,
    w = C.BODIES.japan2003Woman,
    us = C.BODIES.us1919Man;
  // AIST/HQL 2003 young male and female means (mm) and AIST head database 2001 (head girth).
  const same = (a, b, what) => a.forEach((v, i) => near(v, b[i], 1e-12, what));
  same(
    [m.stature, m.chestGirth, m.waistGirth, m.hipGirth, m.crotchHeight, m.headGirth],
    [1.6967, 0.8885, 0.7463, 0.9076, 0.7549, 0.5759],
    'AIST man',
  );
  same(
    [w.stature, w.chestGirth, w.waistGirth, w.hipGirth, w.crotchHeight, w.headGirth],
    [1.5783, 0.8687, 0.6727, 0.9002, 0.7012, 0.5511],
    'AIST woman',
  );
  // Army Anthropology Table 117 group 4m and Table 119 group 5m (cm); crotch = stature - sitting height 90.5.
  assert.deepEqual(
    [us.stature, us.chestGirth, us.neckGirth, us.shoulderBreadth, us.waistGirth, us.thighGirth, us.kneeHeight],
    [1.72, 0.876, 0.357, 0.415, 0.77, 0.525, 0.469],
  );
  near(us.crotchHeight, 0.815, 1e-12, 'crotch');
  for (const body of Object.values(C.BODIES)) {
    const s = C.trunkSections(body);
    for (const [k, girth] of [
      [0, body.hipGirth],
      [2, body.waistGirth],
      [3, body.chestGirth],
    ])
      near(C.superellipsePerimeter(s[k].a, s[k].b, s[k].n), girth, girth * 1e-3, `${body.name} section ${k}`);
    for (let k = 1; k < s.length; k++) assert.ok(s[k].y > s[k - 1].y, 'sections rise');
  }
});

test('garment sizes match the period dimensions they are cut to', () => {
  const body = C.BODIES.us1919Man,
    garments = C.dress(body, C.OUTFITS['ranger-1910']),
    hat = garments.find((g) => g.spec.name === 'hat');
  // Tucker and Fitzpatrick: the 1910 ranger Stetson had a 4 inch crown and a 3 inch brim.
  const head = hat.rings.filter((r) => r.part === 'head'),
    crown = Math.max(...head.map((r) => r.at)) - Math.min(...head.map((r) => r.at));
  near(crown, 4 * 0.0254, 1e-9, 'crown');
  let rim = 0;
  const p = hat.geometry.positions;
  for (let i = 0; i < p.length; i += 3) rim = Math.max(rim, Math.hypot(p[i], p[i + 2]));
  near(rim - Math.max(...head[0].outer), 3 * 0.0254, 1e-4, 'brim');
  // Army Anthropology: blouse group 4 is cut for chests of 86 to 89 cm and breeches group 5 for waists of 76 to 79 cm;
  // the garment's inner girth must take the largest body of its group.
  const girth = (g, y) => {
    const ring = g.rings
      .filter((r) => r.part === 'trunk')
      .reduce((a, b) => (Math.abs(b.at - y) < Math.abs(a.at - y) ? b : a));
    let s = 0;
    for (let k = 0; k < C.RING_STEPS; k++) {
      const a = (k / C.RING_STEPS) * 2 * Math.PI,
        b = ((k + 1) / C.RING_STEPS) * 2 * Math.PI,
        r0 = ring.inner[k],
        r1 = ring.inner[(k + 1) % C.RING_STEPS];
      s += Math.hypot(r1 * Math.cos(b) - r0 * Math.cos(a), r1 * Math.sin(b) - r0 * Math.sin(a));
    }
    return s;
  };
  const coat = garments.find((g) => g.spec.name === 'coat'),
    breeches = garments.find((g) => g.spec.name === 'breeches');
  assert.ok(girth(coat, body.chestHeight) >= 0.89, `coat chest ${girth(coat, body.chestHeight)}`);
  assert.ok(girth(breeches, body.waistHeight) >= 0.79, `breeches waist ${girth(breeches, body.waistHeight)}`);
  // Super Cool Biz began on 1 May 2011 (Ministry of the Environment): the March office man keeps his jacket.
  assert.ok(C.OUTFITS['office-worker-2011'].garments.some((g) => g.name === 'jacket' && g.sleeves > 0.9));
});

test('layers never pass through each other or the body at rest, and the meshes sit on their rings', () => {
  const interp = (rings, at, k, key) => {
    const sorted = [...rings].sort((a, b) => a.at - b.at);
    if (at < sorted[0].at - 1e-9 || at > sorted[sorted.length - 1].at + 1e-9) return undefined;
    for (let i = 1; i < sorted.length; i++)
      if (at <= sorted[i].at + 1e-12) {
        const a = sorted[i - 1],
          b = sorted[i],
          f = b.at > a.at ? (at - a.at) / (b.at - a.at) : 0;
        return a[key][k] + (b[key][k] - a[key][k]) * f;
      }
    return sorted[sorted.length - 1][key][k];
  };
  let pairs = 0;
  for (const [name, outfit] of Object.entries(C.OUTFITS)) {
    const body = C.BODIES[outfit.body],
      sections = C.trunkSections(body),
      garments = C.dress(body, outfit);
    for (const g of garments) {
      // On the body: the first trunk layer stays outside the skin by its ease.
      for (const ring of g.rings.filter(
        (r) => r.part === 'trunk' && r.at >= body.crotchHeight && r.at <= body.neckHeight,
      )) {
        const t = C.trunkAt(sections, ring.at);
        for (let k = 0; k < C.RING_STEPS; k++) {
          const skin = C.superellipseRadius(t.a, t.b, t.n, (k / C.RING_STEPS) * 2 * Math.PI);
          assert.ok(ring.inner[k] >= skin + g.spec.ease - 1e-6, `${name} ${g.spec.name} inside the body at ${ring.at}`);
        }
      }
      // Each ring is where the mesh is: trunk vertices at a ring's height lie between its inner and outer radii.
      const p = g.geometry.positions,
        nrm = g.geometry.normals;
      // (Rings at the crotch also meet the leg tubes' first row; those are checked on the legs.)
      for (const ring of g.rings.filter((r) => r.part === 'trunk' && r.at > body.crotchHeight + 1e-4).slice(0, 6)) {
        const lo = Math.min(...ring.inner) - 1e-5,
          hi = Math.max(...ring.outer) + 1e-5;
        let seen = 0;
        for (let i = 0; i < p.length; i += 3)
          // Trunk vertices have radial normals about the trunk's axis (sleeve and leg tubes have their own axes).
          if (
            Math.abs(p[i + 1] - ring.at) < 1e-6 &&
            Math.abs(p[i] * nrm[i + 2] - p[i + 2] * nrm[i]) < 1e-4 * Math.hypot(p[i], p[i + 2]) &&
            Math.abs(nrm[i + 1]) < 1e-6
          ) {
            const r = Math.hypot(p[i], p[i + 2]);
            assert.ok(r >= lo && r <= hi, `${name} ${g.spec.name} vertex ${r} off its ring ${lo}..${hi}`);
            seen++;
          }
        assert.ok(seen >= 2 * C.RING_STEPS, `${name} ${g.spec.name} ring at ${ring.at} has its vertices`);
      }
    }
    for (const inner of garments)
      for (const outer of garments) {
        if (
          outer.spec.layer <= inner.spec.layer &&
          !(outer.spec.layer === inner.spec.layer && garments.indexOf(outer) > garments.indexOf(inner))
        )
          continue;
        for (const part of ['trunk', 'armL', 'armR', 'legL', 'legR']) {
          const a = inner.rings.filter((r) => r.part === part),
            b = outer.rings.filter((r) => r.part === part);
          if (!a.length || !b.length) continue;
          for (const ring of b)
            for (let k = 0; k < C.RING_STEPS; k++) {
              const under = interp(a, ring.at, k, 'outer');
              if (under === undefined) continue;
              pairs++;
              assert.ok(
                ring.inner[k] >= under - 1e-6,
                `${name}: ${outer.spec.name} passes through ${inner.spec.name} (${part} at ${ring.at.toFixed(3)}, ${ring.inner[k]} < ${under})`,
              );
            }
        }
      }
  }
  assert.ok(pairs > 10000, `layer pairs checked: ${pairs}`);
});

test('garments carry seams: side seams and the open front sit a seam depth in from the cloth beside them', () => {
  const coat = C.dress(C.BODIES.us1919Man, C.OUTFITS['ranger-1910']).find((g) => g.spec.name === 'coat');
  assert.equal(coat.seams.length, 3 + 2 + 2, 'two side seams and the front on the body and two seams on each sleeve');
  const p = coat.geometry.positions,
    radius = (i) => Math.hypot(p[3 * i], p[3 * i + 2]);
  const front = coat.seams[2],
    mid = front[Math.floor(front.length / 2)];
  assert.ok(radius(mid + 1) - radius(mid) > 0.0005, 'the front seam dips into the cloth');
});

test('castCrowd follows the role shares, the life jacket chance and the dye spread, deterministically', () => {
  const roles = { 'ranger-1910': 1, 'miner-1910': 3 },
    a = C.castCrowd(4000, { roles, seed: 3 }),
    b = C.castCrowd(4000, { roles, seed: 3 });
  assert.deepEqual(a, b);
  const rangers = a.filter((m) => m.outfit === 'ranger-1910').length,
    sd = Math.sqrt(4000 * 0.25 * 0.75);
  assert.ok(Math.abs(rangers - 1000) < 4 * sd, `rangers ${rangers}`);
  const fishers = C.castCrowd(4000, { roles: { 'fisherman-2011': 1 }, seed: 5 }),
    vests = fishers.filter((m) => m.dressed.garments.some((g) => g.name === 'life jacket')).length;
  // Fisheries Agency: about 3 in 10 fishers wore a life jacket.
  assert.ok(Math.abs(vests - 1200) < 4 * Math.sqrt(4000 * 0.3 * 0.7), `life jackets ${vests}`);
  for (const m of a.slice(0, 50))
    m.dressed.garments.forEach((g, k) => {
      const base = C.OUTFITS[m.outfit].garments[k].color;
      g.color.forEach((c, i) => assert.ok(Math.abs(c - base[i]) <= base[i] * 0.08 + 1e-12, 'dye spread'));
    });
  const v = C.castVariants(roles);
  assert.equal(v.length, 4, 'one region per share of the smallest weight');
  assert.deepEqual(v[1], v[3]);
  assert.throws(() => C.castCrowd(10, { roles: { pirate: 1 } }), RangeError);
});

test('the slider rows share the settings shape and drive the outfit', () => {
  for (const row of C.CAST_SETTINGS)
    for (const key of ['name', 'group', 'kind', 'default', 'unit', 'about', 'live'])
      assert.ok(key in row, `${row.name} has ${key}`);
  const plain = C.applyCastSettings({});
  assert.deepEqual(plain.outfit, C.OUTFITS[C.CAST_SETTINGS[0].default]);
  const red = C.applyCastSettings({
    outfit: 'miner-1910',
    garment: 1,
    color: [0.4, 0.05, 0.03],
    fabric: 'cotton-duck',
  });
  assert.deepEqual(red.outfit.garments[1].color, [0.4, 0.05, 0.03]);
  assert.equal(red.outfit.garments[1].fabric, 'cotton-duck');
  assert.equal(red.body, C.BODIES.us1919Man);
  assert.throws(() => C.applyCastSettings({ sparkle: 1 }), TypeError);
  assert.throws(() => C.applyCastSettings({ outfit: 'miner-1910', garment: 7 }), RangeError);
});

test('outfitGLB writes a glTF 2.0 binary with a mesh per garment and the cloth sheen', () => {
  const glb = C.outfitGLB(C.OUTFITS['townsman-1910']),
    view = new DataView(glb.buffer, glb.byteOffset);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(8, true), glb.byteLength);
  const length = view.getUint32(12, true),
    doc = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  assert.deepEqual(doc.extensionsUsed, ['KHR_materials_sheen']);
  assert.equal(doc.extensionsRequired, undefined, 'loadGLTF must not be asked to require the extension');
  assert.deepEqual(
    doc.meshes.map((m) => m.name),
    ['shirt', 'boots', 'hat', 'trousers', 'tie', 'vest', 'coat'],
  );
  assert.ok(
    doc.materials.find((m) => m.name === 'hat').extensions.KHR_materials_sheen.sheenColorFactor[0] > 0,
    'felt sheen',
  );
  for (const a of doc.accessors) assert.ok(a.count > 0);
});

// KB-HUMANS-SHEENZERO1: the woven model (threads only) has no grazing rim, so the fit gave wool, cotton and denim no
// sheen at all (old: sheenColor [0, 0, 0] for every grey 0.03 to 0.6). Their loose fibre ends now scatter at grazing
// angles as a thin fibre layer over the weave, napped flannel more than clear-finished worsted; filament silk and
// polyester have none.
test('wool and cotton get a grazing sheen from their fibre ends; filament cloth gets none', () => {
  const sheen = (kind, g) => Math.max(...C.periodLobes(kind, [g, g, g]).sheenColor);
  for (const g of [0.1, 0.3]) {
    assert.ok(sheen('wool-worsted', g) > 0.05, `worsted ${g}: sheen ${sheen('wool-worsted', g)}`);
    assert.ok(
      sheen('wool-flannel', g) > sheen('wool-worsted', g),
      `flannel ${sheen('wool-flannel', g)} over worsted ${sheen('wool-worsted', g)}`,
    );
    assert.ok(sheen('cotton-duck', g) > 0, `duck ${g}: sheen ${sheen('cotton-duck', g)}`);
    assert.equal(sheen('silk', g), 0);
    assert.equal(sheen('polyester-blend', g), 0);
  }
  // The measured model itself: light and view together at 80 degrees from the normal (the rim a fibre layer lights up,
  // its half vector along the cloth) reflect more off worsted with its fibre ends than off the same weave without them.
  const t = (80 * Math.PI) / 180,
    wi = [Math.sin(t), 0, Math.cos(t)],
    wr = [Math.sin(t), 0, Math.cos(t)],
    worsted = C.periodFabric('wool-worsted', [0.1, 0.1, 0.1]),
    { fuzz, ...bare } = worsted;
  assert.ok(fuzz && fuzz.depth > 0, 'worsted has fibre ends');
  assert.ok(
    C.fabricBRDF(worsted, wi, wr)[0] > 1.2 * C.fabricBRDF(bare, wi, wr)[0],
    `grazing ${C.fabricBRDF(worsted, wi, wr)[0]} against ${C.fabricBRDF(bare, wi, wr)[0]}`,
  );
});
