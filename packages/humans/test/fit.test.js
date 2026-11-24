// Garment fitting on a rigged body (@margoengine/humans/fit): a small body built in code (test/rigged-body.js) in a T-pose
// and an A-pose is measured, dressed in every outfit of the cast kit with one call, and posed. Every bound is measured:
// no garment inside the body or through another at rest; in four poses no garment more than 5 mm into the body (the
// thigh lifting into a shirt tail in a stride is the deepest) and no layer through another.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as F from '../dist/fit.js';
import { OUTFITS, garmentMaterial } from '../dist/cast.js';
import { BONES, poseSkin, posesFor, quat, riggedTestBody } from './rigged-body.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tolerance ${tol})`);
const T = riggedTestBody('T'),
  A = riggedTestBody('A');

test('the body is measured where it stands: its rest pose, heights and girths', () => {
  const t = F.fitOutfit(T, 'townsman-1910'),
    a = F.fitOutfit(A, 'townsman-1910');
  assert.equal(t.pose, 'T');
  assert.equal(a.pose, 'A');
  near((t.armAngle * 180) / Math.PI, 90, 0.01, 'T-pose arm angle');
  near((a.armAngle * 180) / Math.PI, 45, 0.01, 'A-pose arm angle');
  assert.equal(t.unit, 1);
  const m = t.measures;
  near(m.stature, 1.72, 0.001, 'stature: the top of the head');
  near(m.armLength, 0.55, 1e-6, 'arm length: shoulder to elbow 0.29 m, elbow to wrist 0.26 m');
  near(m.shoulderBreadth, 0.38, 1e-6, 'shoulder joints 0.19 m either side');
  // The torso is an ellipse of half breadth 0.14 m and half depth 0.10 m at 1.05 m: perimeter by Ramanujan's formula.
  const ellipse = (p, q) => Math.PI * (3 * (p + q) - Math.sqrt((3 * p + q) * (p + 3 * q)));
  assert.ok(m.waistHeight > 1.0 && m.waistHeight < 1.12, `waist found at the narrowest trunk, ${m.waistHeight}`);
  near(m.waistGirth, ellipse(0.14, 0.1), 0.02, 'waist girth');
  near(m.kneeHeight, 0.48, 1e-6, 'knee joint height');
  assert.ok(m.crotchHeight > 0.78 && m.crotchHeight < 0.85, `crotch where the thighs meet, ${m.crotchHeight}`);
  // The same measures in an A-pose.
  near(a.measures.waistGirth, m.waistGirth, 1e-9, 'pose does not change the waist');
});

test('every outfit of the cast kit dresses the body with one call: layered, skinned, nothing through anything at rest', () => {
  for (const [name, outfit] of Object.entries(OUTFITS)) {
    const fit = F.fitOutfit(T, name);
    assert.equal(fit.outfit, outfit);
    assert.equal(fit.garments.length, outfit.garments.length, name);
    for (const g of fit.garments) {
      const n = g.positions.length / 3;
      assert.equal(g.normals.length, n * 3);
      assert.equal(g.joints.length, n * 4);
      assert.equal(g.parts.length, n);
      assert.equal(g.faces.length, g.indices.length / 3);
      assert.ok(g.positions.every(Number.isFinite), `${name} ${g.spec.name} positions are finite`);
      // Every normal is a unit vector: the waistcoat's neckline band once had zero normals, which glTF loaders reject.
      for (let v = 0; v < n; v++)
        near(
          Math.hypot(g.normals[v * 3], g.normals[v * 3 + 1], g.normals[v * 3 + 2]),
          1,
          1e-4,
          `${name} ${g.spec.name} normal ${v}`,
        );
      for (let v = 0; v < n; v++) {
        let sum = 0;
        for (let i = 0; i < 4; i++) {
          assert.ok(g.joints[v * 4 + i] < BONES.length);
          sum += g.weights[v * 4 + i];
        }
        near(sum, 1, 1e-5, `${name} ${g.spec.name} weights sum`);
      }
    }
    const rest = F.fitPenetration(T, fit);
    assert.ok(rest.body === 0, `${name} at rest: ${rest.body} m into the body (${rest.worst.body})`);
    assert.ok(rest.layers === 0, `${name} at rest: ${rest.layers} m through a layer (${rest.worst.layers})`);
  }
});

test('the clothes move with the skeleton: four poses, no garment over 5 mm into the body and no layer through another', () => {
  const cases = [
    ...Object.keys(OUTFITS).map((name) => [T, 'T', name]),
    [A, 'A', 'townsman-1910'],
    [A, 'A', 'ranger-1910'],
    [A, 'A', 'office-worker-2011-woman'],
  ];
  for (const [body, pose, name] of cases) {
    const fit = F.fitOutfit(body, name);
    for (const [label, rotations] of Object.entries(posesFor(pose))) {
      const r = F.fitPenetration(body, fit, label === 'rest' ? undefined : poseSkin(body, rotations));
      assert.ok(
        r.body <= 0.005,
        `${name} (${pose}) ${label}: ${(r.body * 1000).toFixed(2)} mm into the body (${r.worst.body})`,
      );
      assert.ok(
        r.layers <= 0.0001,
        `${name} (${pose}) ${label}: ${(r.layers * 1000).toFixed(2)} mm through a layer (${r.worst.layers})`,
      );
    }
  }
});

// The measure once read a crossing of 46 mm where there was none: a V neckline folds the rows above its cut onto one
// point, and the closest point to the shirt in the coat's V fell on one of those triangles with no area, whose normal
// is undefined. Skinned by the rest pose (identity matrices) the measure must read what it reads at rest.
test('the rest pose skinned reads the same as no pose: triangles with no area are not measured against', () => {
  for (const [body, pose] of [
    [T, 'T'],
    [A, 'A'],
  ]) {
    const identity = poseSkin(body, {});
    for (const name of Object.keys(OUTFITS)) {
      const fit = F.fitOutfit(body, name),
        rest = F.fitPenetration(body, fit),
        skinnedRest = F.fitPenetration(body, fit, identity);
      near(skinnedRest.body, rest.body, 1e-6, `${name} (${pose}) body`);
      near(skinnedRest.layers, rest.layers, 1e-6, `${name} (${pose}) layers (${skinnedRest.worst.layers})`);
    }
  }
});

test('a 20 mm life jacket meets an A-pose arm brought 10 degrees in: the measured press stays under 12.5 mm', () => {
  // The fit skins the clothes; it does not push cloth aside where the body meets it (docs/limits.md).
  const fit = F.fitOutfit(A, 'fisherman-2011'),
    r = F.fitPenetration(A, fit, poseSkin(A, posesFor('A')['arms lowered, elbows bent']));
  assert.equal(r.worst.body, 'life jacket');
  assert.ok(r.body <= 0.0125, `${r.body}`);
  assert.ok(r.layers <= 0.0001, `${r.layers}`);
});

test('skin weights come from the body under each ring: chest cloth follows the chest, sleeves the arm, legs the leg', () => {
  const fit = F.fitOutfit(T, 'townsman-1910'),
    shirt = fit.garments.find((g) => g.spec.name === 'shirt'),
    boneAt = (g, test) => {
      for (let v = 0; v < g.positions.length / 3; v++)
        if (test(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2])) return BONES[g.joints[v * 4]];
      return undefined;
    };
  assert.equal(
    boneAt(shirt, (x, y, z) => Math.abs(x) < 0.01 && Math.abs(y - 1.25) < 0.02 && z > 0.1),
    'chest',
  );
  assert.equal(
    boneAt(shirt, (x, y) => x > 0.6 && Math.abs(y - 1.41) < 0.06),
    'leftLowerArm',
  );
  const trousers = fit.garments.find((g) => g.spec.name === 'trousers');
  assert.equal(
    boneAt(trousers, (x, y) => x < -0.05 && Math.abs(y - 0.3) < 0.02),
    'rightLowerLeg',
  );
  assert.ok(shirt.matched > 0.6, `most of the shirt is matched directly: ${shirt.matched}`);
});

test('a body in centimetres facing -z is fitted the same, and the garments come back in its own space', () => {
  const turned = {
    ...T,
    positions: T.positions.map((v, i) => (i % 3 === 1 ? v * 100 : -v * 100)),
    normals: T.normals.map((v, i) => (i % 3 === 1 ? v : -v)),
    indices: T.indices,
    bones: T.bones.map((b) => ({
      ...b,
      bind: b.bind.map((v, i) => (i === 12 || i === 14 ? -v * 100 : i === 13 ? v * 100 : v)),
    })),
  };
  const a = F.fitOutfit(T, 'miner-1910'),
    b = F.fitOutfit(turned, 'miner-1910');
  assert.equal(b.unit, 0.01);
  assert.equal(b.pose, 'T');
  near(b.measures.waistGirth, a.measures.waistGirth, 1e-6, 'waist girth');
  near(b.measures.stature, a.measures.stature, 1e-6, 'stature');
  // Each garment comes back in the turned body's space: the same box turned and in centimetres (a ring can gain or lose
  // a body vertex that sits exactly on a slice boundary after the unit change, a few millimetres at most).
  a.garments.forEach((g, k) => {
    const h = b.garments[k];
    assert.equal(h.positions.length, g.positions.length, g.spec.name);
    for (let d = 0; d < 3; d++) {
      const box = (pos, sign) => {
        let lo = Infinity,
          hi = -Infinity;
        for (let i = d; i < pos.length; i += 3) {
          lo = Math.min(lo, pos[i] * sign);
          hi = Math.max(hi, pos[i] * sign);
        }
        return [lo, hi];
      };
      const [l0, h0] = box(g.positions, 1),
        [l1, h1] = box(h.positions, d === 1 ? 0.01 : -0.01);
      near(l1, l0, 0.004, `${g.spec.name} box low ${d}`);
      near(h1, h0, 0.004, `${g.spec.name} box high ${d}`);
    }
  });
});

test('the slider rows share the settings shape and loosen or tighten the fit', () => {
  assert.deepEqual(
    F.FIT_SETTINGS.map((r) => r.name),
    ['fit', 'ease', 'layerGap'],
  );
  for (const row of F.FIT_SETTINGS) assert.equal(row.live, false);
  assert.deepEqual(F.fitSettingDefaults(), { fit: 1, ease: 0.003, layerGap: 0.002 });
  assert.deepEqual(F.applyFitSettings({ fit: 2 }), { fit: 2, ease: 0.003, layerGap: 0.002 });
  const reach = (fit) => {
    const coat = fit.garments.find((g) => g.spec.name === 'coat');
    let most = 0;
    for (let v = 0; v < coat.positions.length / 3; v++)
      if (Math.abs(coat.positions[v * 3 + 1] - 1.25) < 0.01) most = Math.max(most, coat.positions[v * 3 + 2]);
    return most;
  };
  const tight = reach(F.fitOutfit(T, 'townsman-1910', F.applyFitSettings({ fit: 0.5 }))),
    loose = reach(F.fitOutfit(T, 'townsman-1910', F.applyFitSettings({ fit: 2, layerGap: 0.006 })));
  assert.ok(loose > tight + 0.01, `the coat front stands further off the chest: ${tight} to ${loose}`);
  assert.throws(() => F.applyFitSettings({ fit: 9 }), RangeError);
});

// Wilbur (Character Creator through FBX) has one skin per body mesh (head, body, arm, leg) and no skin lists his root
// CC_Base_Hip, which carries no weight (his Pelvis does): riggedBody took the first mesh's skin alone and fitOutfit then
// threw that the rig names no hips.
test('riggedBody joins a body split over several skins and finds an unweighted hips bone above them', () => {
  const at = (i) => [T.bones[i].bind[12], T.bones[i].bind[13], T.bones[i].bind[14]],
    hips = BONES.indexOf('hips'),
    names = [...BONES, 'pelvisShare'],
    parentName = (name) =>
      name === 'pelvisShare'
        ? 'hips'
        : T.bones[BONES.indexOf(name)].parent < 0
          ? undefined
          : BONES[T.bones[BONES.indexOf(name)].parent],
    position = (name) => (name === 'pelvisShare' ? at(hips) : at(BONES.indexOf(name))),
    nodes = names.map((name) => {
      const up = parentName(name),
        p = position(name),
        q = up ? position(up) : [0, 0, 0];
      return {
        name,
        translation: [p[0] - q[0], p[1] - q[1], p[2] - q[2]],
        children: names.filter((c) => parentName(c) === name).map((c) => names.indexOf(c)),
      };
    }),
    // Both skins leave hips out; the second lists its joints in reverse.
    first = names.filter((name) => name !== 'hips').map((name) => names.indexOf(name)),
    second = [...first].reverse(),
    ibm = (joints) => {
      const out = new Float32Array(joints.length * 16);
      joints.forEach((node, i) => {
        const p = position(names[node]);
        out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16);
      });
      return out;
    },
    // The body's own bone -> the skin's joint index (hips weights go to pelvisShare).
    jointsFor = (joints) =>
      Float32Array.from(T.joints, (bone) => joints.indexOf(names.indexOf(bone === hips ? 'pelvisShare' : BONES[bone]))),
    n = T.positions.length / 3,
    vertices = new Float32Array(n * 20);
  for (let v = 0; v < n; v++) {
    vertices.set(T.positions.subarray(v * 3, v * 3 + 3), v * 20);
    vertices.set(T.normals.subarray(v * 3, v * 3 + 3), v * 20 + 4);
  }
  const half = Math.floor(T.indices.length / 6) * 3,
    accessors = [ibm(first), jointsFor(first), Float32Array.from(T.weights), ibm(second), jointsFor(second)],
    doc = {
      nodes: [
        ...nodes,
        { name: 'BodyA', mesh: 0, skin: 0 },
        { name: 'BodyB', mesh: 1, skin: 1 },
        { name: 'RootNode', children: [hips, names.length, names.length + 1] },
      ],
      meshes: [{ name: 'a' }, { name: 'b' }],
      skins: [
        { joints: first, inverseBindMatrices: 0 },
        { joints: second, inverseBindMatrices: 3 },
      ],
    },
    primitive = (node, indices, joints) => ({
      material: { name: 'Std_Skin_Body' },
      nodeIndex: node,
      vertices,
      indices,
      definition: { attributes: { JOINTS_0: joints, WEIGHTS_0: 2 } },
    }),
    model = {
      primitives: [
        primitive(names.length, T.indices.subarray(0, half), 1),
        primitive(names.length + 1, T.indices.subarray(half), 4),
      ],
      asset: { doc, accessor: (id) => accessors[id] },
    },
    body = F.riggedBody(model);
  assert.equal(body.positions.length, 2 * T.positions.length, 'both primitives are read');
  assert.equal(body.indices.length, T.indices.length);
  const index = body.bones.findIndex((b) => b.name === 'hips');
  assert.ok(index >= 0, 'the unweighted hips is a bone');
  assert.equal(
    body.bones.some((b) => b.name === 'RootNode'),
    false,
    'nodes above the meshes are not bones',
  );
  assert.deepEqual(
    [...body.bones[index].bind].slice(12, 15).map((c) => Math.round(c * 1e6) / 1e6),
    at(hips).map((c) => Math.round(c * 1e6) / 1e6),
  );
  assert.equal(body.bones[body.bones.findIndex((b) => b.name === 'pelvisShare')].parent, index);
  // Every vertex keeps its bone by name through either skin.
  for (let k = 0; k < n * 4; k += 7) {
    const want = T.joints[k] === hips ? 'pelvisShare' : BONES[T.joints[k]];
    assert.equal(body.bones[body.joints[k]].name, want);
    assert.equal(body.bones[body.joints[n * 4 + k]].name, want);
  }
  near(F.fitOutfit(body, 'townsman-1910').measures.stature, 1.72, 0.001, 'stature');
});

test('bad bodies and options fail with coded messages', () => {
  assert.throws(
    () => F.fitOutfit({ ...T, bones: T.bones.map((b, i) => ({ ...b, name: `b${i}` })) }, 'miner-1910'),
    /humanoid skeleton/,
  );
  assert.throws(() => F.fitOutfit(T, 'pirate-1700'), TypeError);
  assert.throws(() => F.fitOutfit(T, 'miner-1910', { ease: -1 }), RangeError);
  assert.throws(() => F.fitOutfit({ ...T, weights: T.weights.slice(4) }, 'miner-1910'), TypeError);
  assert.throws(() => F.fitPenetration(T, F.fitOutfit(T, 'miner-1910'), new Float64Array(3)), RangeError);
});

test('riggedBody reads a loaded model: the skin found by its material, or by its node or mesh named Body when it has none', () => {
  // A gltf/pbr model as riggedBody reads it: primitives of 20 floats a vertex, the glTF document and its accessors.
  const model = ({ material, node = 'figure', mesh = 'figure' }) => {
    const n = T.positions.length / 3,
      vertices = new Float32Array(n * 20);
    for (let v = 0; v < n; v++) {
      vertices.set(T.positions.subarray(v * 3, v * 3 + 3), v * 20);
      vertices.set(T.normals.subarray(v * 3, v * 3 + 3), v * 20 + 4);
    }
    const ibm = new Float32Array(T.bones.length * 16);
    T.bones.forEach((b, i) =>
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b.bind[12], -b.bind[13], -b.bind[14], 1], i * 16),
    );
    const accessors = [ibm, Float32Array.from(T.joints), Float32Array.from(T.weights)],
      bones = T.bones.map((b) => ({ name: b.name })),
      doc = {
        nodes: [...bones, { name: node, mesh: 0, skin: 0 }],
        meshes: [{ name: mesh }],
        skins: [{ joints: bones.map((_, i) => i), inverseBindMatrices: 0 }],
      };
    return {
      primitives: [
        {
          material: material === undefined ? undefined : { name: material },
          nodeIndex: bones.length,
          vertices,
          indices: T.indices,
          definition: { attributes: { JOINTS_0: 1, WEIGHTS_0: 2 } },
        },
      ],
      asset: { doc, accessor: (id) => accessors[id] },
    };
  };
  for (const named of [{ material: 'Std_Skin_Body' }, { node: 'Body' }, { mesh: 'Body' }]) {
    const body = F.riggedBody(model(named));
    assert.equal(body.positions.length, T.positions.length, JSON.stringify(named));
    assert.deepEqual(
      body.bones.map((b) => b.name),
      BONES,
    );
    near(F.fitOutfit(body, 'miner-1910').measures.stature, 1.72, 0.001, `${JSON.stringify(named)} stature`);
  }
  assert.throws(() => F.riggedBody(model({})), /material, node or mesh named/);
  assert.throws(() => F.riggedBody(model({ material: 'Cloth' })), /material, node or mesh named/);
});

/** The convex hull perimeter of a garment's vertices of body part `part` within 11 mm of height `y`: its girth there. */
function girthAt(g, y, part) {
  const xs = [],
    zs = [];
  for (let v = 0; v < g.positions.length / 3; v++)
    if (g.parts[v] === part && Math.abs(g.positions[v * 3 + 1] - y) < 0.011) {
      xs.push(g.positions[v * 3]);
      zs.push(g.positions[v * 3 + 2]);
    }
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b] || zs[a] - zs[b]),
    turn = (o, a, b) => (xs[a] - xs[o]) * (zs[b] - zs[o]) - (zs[a] - zs[o]) * (xs[b] - xs[o]),
    chain = (list) => {
      const out = [];
      for (const i of list) {
        while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], i) <= 0) out.pop();
        out.push(i);
      }
      return out.slice(0, -1);
    },
    h = [...chain(order), ...chain([...order].reverse())];
  let p = 0;
  for (let i = 0; i < h.length; i++)
    p += Math.hypot(xs[h[(i + 1) % h.length]] - xs[h[i]], zs[h[(i + 1) % h.length]] - zs[h[i]]);
  return p;
}
/** The highest vertex of a garment among those `keep` picks. */
function highest(g, keep) {
  let y = -Infinity;
  for (let v = 0; v < g.positions.length / 3; v++)
    if (keep(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2], v))
      y = Math.max(y, g.positions[v * 3 + 1]);
  return y;
}

// Wilbur (Character Creator) measured a 0.77 m neck against about 0.38 m for a real one: the neck was a horizontal
// slice at the neck joint, 7 cm above his shoulder joints, which reads the trapezius and the clavicles as neck. ISO
// 8559-1 takes the neck girth square to the neck's axis; the fit takes the narrowest such ring between the clavicle
// line and the jaw, so a jaw reaching down in front of the neck does not count either.
test('the neck girth is the narrowest ring square to the neck between the clavicle line and the jaw', () => {
  const neck = 2 * 24 * 0.055 * Math.sin(Math.PI / 24); // the test body's neck: a 24-sided tube of radius 55 mm
  for (const [label, body] of [
    ['T-pose', T],
    ['A-pose', A],
    ['with a jaw', riggedTestBody('T', { jaw: true })],
  ])
    near(F.fitOutfit(body, 'townsman-1910').measures.neckGirth, neck, 0.002, `${label} neck girth`);
});

// Dressed Wilbur read as a black sack: the coat's trunk tube stopped flat at the neck joint's height as wide as the
// slice there (no shoulder slope, collar, neck opening or lapels), hung as a wide tube, the shirt collar and the vest
// were hidden, and the trousers hung straight down from the thigh at about twice a 1900s leg.
const suit = F.fitOutfit(T, 'townsman-1910'),
  [shirt, vest, coat, trousers] = ['shirt', 'vest', 'coat', 'trousers'].map((name) =>
    suit.garments.find((g) => g.spec.name === name),
  ),
  centre = (front) => (x, y, z) => Math.abs(x) < 0.012 && (front ? z > 0 : z < 0),
  neckBase = 1.47; // the test body's torso narrows into its neck there
test('the townsman suit shows its collars and opens in a V with lapels, the high-cut vest above the break', () => {
  // Collars: the shirt's stands 2 1/4 inch up the neck and shows above the coat's, which stands at the back of the neck.
  const shirtTop = highest(shirt, () => true),
    coatBack = highest(coat, centre(false));
  assert.ok(shirtTop > neckBase + 0.05, `shirt collar top ${shirtTop}`);
  assert.ok(coatBack > neckBase + 0.025, `coat collar at the back of the neck ${coatBack}`);
  assert.ok(shirtTop > coatBack + 0.02, `shirt collar ${shirtTop} shows over the coat collar ${coatBack}`);
  // The V: the coat opens down to its break; the high-cut vest shows in it above the break.
  const coatFront = highest(coat, centre(true)),
    vestFront = highest(vest, centre(true));
  assert.ok(coatFront < 1.35, `the coat's V reaches down to ${coatFront}`);
  assert.ok(vestFront > coatFront + 0.05, `the vest's V (${vestFront}) is higher than the coat's (${coatFront})`);
  // Lapels lie on the chest either side of the V.
  let lapel = 0;
  for (let t = 0; t < coat.faces.length; t++)
    if (coat.faces[t] === 3) {
      const v = coat.indices[t * 3],
        [x, y, z] = [coat.positions[v * 3], coat.positions[v * 3 + 1], coat.positions[v * 3 + 2]];
      if (Math.abs(x) > 0.03 && Math.abs(x) < 0.12 && y > 1.3 && y < 1.46 && z > 0.05) lapel++;
    }
  assert.ok(lapel > 40, `lapel triangles on the chest: ${lapel}`);
});
// Dressed Wilbur (dressed5, 2026-11-18) showed a flat white bib from the neck to the vest: the shirt's standing collar
// closed all round like a tube, no tie, and lapels lying flat on the coat 2 mm up, so nothing at the neck and chest read
// as a 1900s suit next to the Library of Congress photographs of the Wright brothers.
test('the townsman wears a four-in-hand: the knot at the collar front, the blade down the shirt under the vest', () => {
  const fit = F.fitOutfit(T, 'townsman-1910'),
    tie = fit.garments.find((g) => g.spec.name === 'tie'),
    vest = fit.garments.find((g) => g.spec.name === 'vest'),
    shirtG = fit.garments.find((g) => g.spec.name === 'shirt');
  assert.ok(tie, 'the outfit has a tie');
  let knotTop = -Infinity,
    knotWide = 0,
    low = Infinity;
  for (let v = 0; v < tie.positions.length / 3; v++) {
    const [x, y, z] = [tie.positions[v * 3], tie.positions[v * 3 + 1], tie.positions[v * 3 + 2]];
    assert.ok(z > 0, `every tie vertex is in front: ${x} ${y} ${z}`);
    if (y > neckBase) {
      knotTop = Math.max(knotTop, y);
      knotWide = Math.max(knotWide, 2 * Math.abs(x));
    }
    low = Math.min(low, y);
  }
  // The knot sits on the collar's front from the stud up under the points, about 1 1/4 to 1 1/2 inch wide.
  assert.ok(knotTop > neckBase + 0.02 && knotTop < neckBase + 0.05, `knot top ${knotTop}`);
  assert.ok(knotWide > 0.028 && knotWide < 0.04, `knot width ${knotWide}`);
  // The blade reaches down under the vest to near the waist.
  assert.ok(low < fit.measures.waistHeight + 0.05, `blade end ${low} near the waist ${fit.measures.waistHeight}`);
  // Over the shirt and under the vest (the measure reads every tie vertex against both faces of each).
  assert.ok(
    shirtG && vest && tie.spec.layer > shirtG.spec.layer && tie.spec.layer < vest.spec.layer,
    'the tie is a layer between the shirt and the vest',
  );
  const rest = F.fitPenetration(T, fit);
  assert.ok(rest.layers < 1e-4, `nothing through anything at rest: ${JSON.stringify(rest.worst)} ${rest.layers}`);
});
// A V neckline folds a column's rows above its cut onto one point. The yoke rows read their weights at the body under
// them and the collar rows above read the lattice, so in a turn and lean the folded points parted (0.12 mm) into
// slivers whose normals point anywhere, and the tie under the coat's V measured 20 mm through it.
// The four-in-hand read as a plain block in dressed6 (2026-11-18): a smooth wedge, its middle rising 1.7 mm from 20 to
// 60 percent up the knot and 0.8 mm from 10 to 30. A four-in-hand's face is the band the last pass wraps across the
// front, proud above its lower edge, with the blade dropping through it into a dimple (Fink and Mao 1999).
test('the four-in-hand shows its wrapped band and a dimple under it', () => {
  for (const body of [T, A]) {
    const tie = F.fitOutfit(body, 'townsman-1910').garments.find((x) => x.spec.name === 'tie'),
      P = tie.positions,
      pts = [];
    let top = -Infinity,
      low = Infinity;
    for (let v = 0; v < P.length / 3; v++) top = Math.max(top, P[v * 3 + 1]);
    for (let v = 0; v < P.length / 3; v++)
      if (P[v * 3 + 1] > top - 0.04) pts.push([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    for (const p of pts) low = Math.min(low, p[1]);
    /** How far forward the knot's middle reaches on its row nearest a share of its height. */
    const middle = (f) => {
      const want = low + (top - low) * f;
      let y = Infinity;
      for (const p of pts) if (Math.abs(p[1] - want) < Math.abs(y - want)) y = p[1];
      return Math.max(...pts.filter((p) => Math.abs(p[1] - y) < 1e-4 && Math.abs(p[0]) < 0.004).map((p) => p[2]));
    };
    assert.ok(
      middle(0.6) - middle(0.2) >= 0.0035,
      `the band stands ${(middle(0.6) - middle(0.2)).toFixed(4)} m over the knot's lower middle`,
    );
    assert.ok(
      middle(0.3) - middle(0.1) >= 0.0018,
      `the dimple dips ${(middle(0.3) - middle(0.1)).toFixed(4)} m under the band`,
    );
  }
});
test('the rows folded onto a V neckline cut stay one point when the body moves', () => {
  const fit = F.fitOutfit(T, 'townsman-1910'),
    skin = poseSkin(T, posesFor('T')['turn and lean']);
  for (const name of ['vest', 'coat']) {
    const g = fit.garments.find((x) => x.spec.name === name),
      n = g.positions.length / 3,
      posed = new Float64Array(n * 3),
      groups = new Map();
    for (let v = 0; v < n; v++) {
      for (let i = 0; i < 4; i++) {
        const w = g.weights[v * 4 + i],
          m = g.joints[v * 4 + i] * 16;
        for (let d = 0; d < 3; d++)
          posed[v * 3 + d] +=
            w *
            (skin[m + d] * g.positions[v * 3] +
              skin[m + 4 + d] * g.positions[v * 3 + 1] +
              skin[m + 8 + d] * g.positions[v * 3 + 2] +
              skin[m + 12 + d]);
      }
      const key = [0, 1, 2].map((d) => g.positions[v * 3 + d].toFixed(6)).join();
      (groups.get(key) ?? groups.set(key, []).get(key)).push(v);
    }
    let apart = 0,
      folded = 0;
    for (const list of groups.values()) {
      if (list.length < 3) continue;
      folded++;
      for (const v of list)
        apart = Math.max(
          apart,
          Math.hypot(
            posed[v * 3] - posed[list[0] * 3],
            posed[v * 3 + 1] - posed[list[0] * 3 + 1],
            posed[v * 3 + 2] - posed[list[0] * 3 + 2],
          ),
        );
    }
    assert.ok(folded > 10, `${name}: folded points ${folded}`);
    assert.ok(apart < 1e-5, `${name}: folded points part by ${apart} m in a turn and lean`);
  }
});
test("the shirt's wing collar parts at the front over the stud and turns its corners down into points", () => {
  // The old collar stood 2 1/4 inch all round, a closed white tube over the centre front.
  const frontTop = highest(shirt, (x, y, z) => Math.abs(x) < 0.004 && z > 0);
  assert.ok(frontTop < neckBase + 0.012, `the collar fronts part down to the stud at the centre front: ${frontTop}`);
  let points = 0;
  for (let t = 0; t < shirt.faces.length; t++)
    if (shirt.faces[t] === 3) {
      const v = shirt.indices[t * 3],
        [x, y, z] = [shirt.positions[v * 3], shirt.positions[v * 3 + 1], shirt.positions[v * 3 + 2]];
      if (z > 0 && Math.abs(x) > 0.004 && Math.abs(x) < 0.045 && y > neckBase + 0.02 && y < neckBase + 0.065) points++;
    }
  assert.ok(points >= 24, `turned point triangles on the collar front: ${points}`);
});
test('the coat lapels roll: the folded edge stands off the forepart toward the gorge, flat at the break', () => {
  // The old lapels lay on the coat 0.4 mm over its cloth, the same tone as the chest under it.
  const outer = [];
  for (let t = 0; t < coat.faces.length; t++)
    if (coat.faces[t] === 0)
      for (let c = 0; c < 3; c++) {
        const v = coat.indices[t * 3 + c];
        outer.push([coat.positions[v * 3], coat.positions[v * 3 + 1], coat.positions[v * 3 + 2]]);
      }
  const standoff = (x, y, z) => {
    const r = Math.hypot(x, z),
      a = Math.atan2(z, x);
    let under = -Infinity;
    for (const [px, py, pz] of outer)
      if (Math.abs(py - y) < 0.012 && Math.abs(Math.atan2(pz, px) - a) < 0.1)
        under = Math.max(under, Math.hypot(px, pz));
    return r - under;
  };
  let top = 0,
    bottom = Infinity;
  for (let t = 0; t < coat.faces.length; t++)
    if (coat.faces[t] === 3) {
      const v = coat.indices[t * 3],
        [x, y, z] = [coat.positions[v * 3], coat.positions[v * 3 + 1], coat.positions[v * 3 + 2]];
      if (z < 0.03 || Math.abs(x) > 0.12) continue;
      const s = standoff(x, y, z);
      if (!Number.isFinite(s)) continue;
      if (y > 1.42) top = Math.max(top, s);
      if (y < 1.3) bottom = Math.min(bottom, s);
    }
  assert.ok(top > 0.008, `the lapel stands ${top} off the forepart near the gorge`);
  assert.ok(bottom < 0.004, `and lies on it near the break: ${bottom}`);
});

test('the townsman coat slopes from the side of the neck down to the shoulder point', () => {
  // The cloth falls from the neck point to the shoulder point over the body (bridging the hollow between them, as a
  // shoulder seam does), where the old coat stopped in a flat box.
  const at = (x) => (px, py, pz) => Math.abs(px - x) < 0.006 && Math.abs(pz) < 0.03,
    coatTop = (x) => highest(coat, (px, py, pz, v) => coat.parts[v] === 0 && at(x)(px, py, pz)),
    bodyTop = (x) => highest({ positions: T.positions }, (px, py, pz) => at(x)(px, py, pz) && py < 1.5),
    [c08, c12, c16] = [0.08, 0.12, 0.16].map(coatTop);
  assert.ok(c08 > c12 && c12 > c16 && c08 - c16 > 0.02, `shoulder drop ${c08}, ${c12}, ${c16}`);
  for (const x of [0.08, 0.12, 0.16])
    assert.ok(coatTop(x) > bodyTop(x) + 0.005, `coat ${coatTop(x)} over body ${bodyTop(x)} at x ${x}`);
});

// Dressed Wilbur showed his skin at both shoulder points: the shoulder's cap weighs to the arm, so the yoke (the trunk's
// points) stopped short of it and the sleeve began just inside the joint, leaving a hole between the two.
/** Linear blend skinning of positions and normals by skin matrices (16 numbers a bone). */
function skinned(positions, normals, joints, weights, skin) {
  const n = positions.length / 3,
    p = new Float64Array(n * 3),
    q = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) {
    for (let i = 0; i < 4; i++) {
      const w = weights[v * 4 + i],
        m = joints[v * 4 + i] * 16;
      if (!w) continue;
      for (let r = 0; r < 3; r++) {
        p[v * 3 + r] +=
          w *
          (skin[m + r] * positions[v * 3] +
            skin[m + 4 + r] * positions[v * 3 + 1] +
            skin[m + 8 + r] * positions[v * 3 + 2] +
            skin[m + 12 + r]);
        q[v * 3 + r] +=
          w *
          (skin[m + r] * normals[v * 3] + skin[m + 4 + r] * normals[v * 3 + 1] + skin[m + 8 + r] * normals[v * 3 + 2]);
      }
    }
    const l = Math.hypot(q[v * 3], q[v * 3 + 1], q[v * 3 + 2]) || 1;
    for (let r = 0; r < 3; r++) q[v * 3 + r] /= l;
  }
  return { positions: p, normals: q };
}
/** Body vertices facing up over the shoulders (between the armpit and the neck base) with no coat above them, posed by `skin` when given. */
function bareShoulders(body, fit, skin) {
  const g0 = fit.garments.find((x) => x.spec.name === 'coat'),
    g = skin ? { ...g0, ...skinned(g0.positions, g0.normals, g0.joints, g0.weights, skin) } : g0;
  if (skin) body = { ...body, ...skinned(body.positions, body.normals, body.joints, body.weights, skin) };
  const P = g.positions,
    I = g.indices,
    axilla = fit.measures.axillaHeight;
  const covered = (o, d) => {
    // Moller and Trumbore (1997): the ray from the skin along its normal meets a coat triangle within 15 cm.
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3],
        e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]],
        e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]],
        p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]],
        det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-12) continue;
      const w = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]],
        u = (w[0] * p[0] + w[1] * p[1] + w[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]],
        v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det,
        hit = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (v >= 0 && u + v <= 1 && hit > 0 && hit < 0.15) return true;
    }
    return false;
  };
  const bare = [];
  let checked = 0;
  for (let v = 0; v < body.positions.length / 3; v++) {
    const o = [0, 1, 2].map((i) => body.positions[v * 3 + i]),
      d = [0, 1, 2].map((i) => body.normals[v * 3 + i]);
    if (o[1] < axilla || o[1] > neckBase || d[1] < 0.2 || Math.abs(o[0]) < 0.08 || Math.abs(o[0]) > 0.3) continue;
    checked++;
    if (!covered(o, d)) bare.push(o.map((x) => x.toFixed(3)).join(', '));
  }
  return { checked, bare };
}
test('the townsman coat covers the shoulder points, from the yoke into the sleeves', () => {
  for (const [pose, body, fit] of [
    ['T', T, suit],
    ['A', A, F.fitOutfit(A, 'townsman-1910')],
  ]) {
    const { checked, bare } = bareShoulders(body, fit);
    assert.ok(checked > 100, `${pose}: ${checked} shoulder vertices checked`);
    assert.deepEqual(bare, [], `${pose}: bare skin over the shoulders at ${bare.slice(0, 4).join('; ')}`);
  }
});
// Dressed Wilbur showed a white sliver at the shoulder seam (dressed6, 2026-11-18): the coat's sleeve was set in at the
// same place as the shirt's, so the shirt sleeve's raw top edge stood level with the coat sleeve's, above the coat's
// yoke over the shoulder point. Each sleeve now starts a ring further in than the one beneath. Before the fix, 18 to 50
// of the shirt sleeves' outer vertices over the shoulders met no coat along their normal on these bodies.
/** The outer faces of `g`'s sleeves (parts 2 and 3) as a mesh of their vertices: positions, normals and skin. */
function sleevesOf(g) {
  const keep = new Uint8Array(g.positions.length / 3);
  for (let t = 0; t < g.faces.length; t++)
    if (g.faces[t] === F.FACE.outer) for (let c = 0; c < 3; c++) keep[g.indices[t * 3 + c]] = 1;
  const vs = [...keep.keys()].filter((v) => keep[v] && (g.parts[v] === 2 || g.parts[v] === 3)),
    pick = (a, n) => Float32Array.from(vs.flatMap((v) => Array.from(a.subarray(v * n, v * n + n))));
  return {
    positions: pick(g.positions, 3),
    normals: pick(g.normals, 3),
    joints: Uint32Array.from(vs.flatMap((v) => Array.from(g.joints.subarray(v * 4, v * 4 + 4)))),
    weights: pick(g.weights, 4),
  };
}
test('the coat sleeve covers the shirt sleeve at the shoulder seam: no shirt shows between yoke and sleeve', () => {
  for (const [pose, body, drop] of [
    ['T', T, 80],
    ['A', A, 40],
  ]) {
    const fit = F.fitOutfit(body, 'townsman-1910'),
      shirt = sleevesOf(fit.garments.find((x) => x.spec.name === 'shirt'));
    for (const deg of [0, drop]) {
      const skin = deg
          ? poseSkin(body, { leftUpperArm: quat([0, 0, 1], -deg), rightUpperArm: quat([0, 0, 1], deg) })
          : undefined,
        { checked, bare } = bareShoulders(shirt, fit, skin);
      assert.ok(checked > 50, `${pose} ${deg}: ${checked} shirt sleeve vertices checked`);
      assert.deepEqual(
        bare,
        [],
        `${pose} ${deg}: shirt showing at the shoulder seam at ${bare.slice(0, 4).join('; ')}`,
      );
    }
  }
});
// Dressed Wilbur showed a wedge of skin at each sleeve top once the idle clip lowered his arms (KB-HUMANS-WILBURSUIT1):
// the yoke over the shoulder's cap read the trunk's weight lattice, whose slices hold no deltoid, so it stayed with the
// chest while the cap (weighted to the upper arm) turned down with the arm. Lowered 80 degrees from the T-pose, the
// old fit left 14 shoulder vertices bare.
test('the coat over the shoulder points moves with the arm: arms lowered from a T-pose leave no bare shoulder', () => {
  for (const drop of [45, 80]) {
    const skin = poseSkin(T, { leftUpperArm: quat([0, 0, 1], -drop), rightUpperArm: quat([0, 0, 1], drop) }),
      { checked, bare } = bareShoulders(T, suit, skin);
    assert.ok(checked > 50, `${drop} degrees: ${checked} shoulder vertices checked`);
    assert.deepEqual(bare, [], `${drop} degrees: bare skin over the shoulders at ${bare.slice(0, 4).join('; ')}`);
  }
});
test('the townsman coat hangs as a sack coat from the chest to the seat over the hollow of the waist', () => {
  const m = suit.measures;
  // A sack coat hangs from the chest to the seat over the hollow of the waist: more ease at the waist than the chest.
  const chestEase = girthAt(coat, m.chestHeight, 0) - m.chestGirth,
    waistEase = girthAt(coat, m.waistHeight, 0) - m.waistGirth;
  assert.ok(chestEase > 0.08 && chestEase < 0.2, `coat ease over the chest ${chestEase}`);
  assert.ok(waistEase > chestEase + 0.05, `coat ease over the waist ${waistEase} against the chest's ${chestEase}`);
});
// Dressed Wilbur's coat bellied out at the waist and came in again to a hem 2.3 cm narrower than its chest
// (KB-HUMANS-WILBURSUIT1): the drape envelope compared radii taken round the trunk's centre line, which on a real torso
// moves forward at the belly and back at the waist and blades, and a lean man's chest is broader than his hips. A sack
// coat hangs plumb from the chest (Gordon 1895): below it no column of the coat comes back in toward the hem.
test('the townsman coat hangs plumb from the chest on a lean body: no column comes back in toward the hem', () => {
  for (const pose of ['T', 'A']) {
    const body = riggedTestBody(pose, { lean: true }),
      fit = F.fitOutfit(body, 'townsman-1910'),
      g = fit.garments.find((x) => x.spec.name === 'coat'),
      P = g.positions,
      outer = new Uint8Array(P.length / 3);
    for (let t = 0; t < g.faces.length; t++)
      if (g.faces[t] === F.FACE.outer) for (let c = 0; c < 3; c++) outer[g.indices[t * 3 + c]] = 1;
    let hem = Infinity;
    for (let v = 0; v < P.length / 3; v++) if (outer[v] && g.parts[v] === 0) hem = Math.min(hem, P[v * 3 + 1]);
    /** Half breadth, front and back of the coat's trunk within a centimetre of `y` (front and back on the centre line). */
    const at = (y) => {
      let x = 0,
        front = -Infinity,
        back = Infinity;
      for (let v = 0; v < P.length / 3; v++)
        if (outer[v] && g.parts[v] === 0 && Math.abs(P[v * 3 + 1] - y) < 0.01) {
          x = Math.max(x, Math.abs(P[v * 3]));
          if (Math.abs(P[v * 3]) < 0.02) [front, back] = [Math.max(front, P[v * 3 + 2]), Math.min(back, P[v * 3 + 2])];
        }
      return { x, front, back };
    };
    const chest = at(fit.measures.chestHeight);
    let above = chest;
    for (let y = fit.measures.chestHeight - 0.04; y > hem + 0.01; y -= 0.04) {
      const row = at(y);
      assert.ok(row.x >= chest.x - 0.001, `${pose}: half breadth ${row.x} at ${y} against the chest's ${chest.x}`);
      assert.ok(row.front >= above.front - 0.001, `${pose}: front ${row.front} at ${y} comes in from ${above.front}`);
      assert.ok(row.back <= above.back + 0.001, `${pose}: back ${row.back} at ${y} comes in from ${above.back}`);
      above = row;
    }
  }
});
// Dressed Wilbur's coat still bellied out over the front waist and came back in below it (dressed3, 2026-11-18), round
// the front corners though the centre line hung plumb: the hang and the plumb moved each radius only by the centre's
// shift along its own angle, which slides every point sideways by the rest of the shift, so where the torso's centre
// line runs forward over the belly and back below it (Wilbur's by 2.8 cm in 10 cm) the rings below read narrower at
// the front corners. Measured on this body before the fix: 8 cm either side of the centre the front came back in 4.0 mm
// (on Wilbur 8 mm, 14 cm out).
/** The lean body with a belly `by` metres further forward and the seat as far back (Wilbur's centre line). */
function bellied(pose, by) {
  const body = riggedTestBody(pose, { lean: true }),
    P = Float32Array.from(body.positions);
  for (let v = 0; v < P.length / 3; v++) {
    const y = P[v * 3 + 1];
    if (y > 0.86 && y < 1.4 && Math.abs(P[v * 3]) < 0.19)
      P[v * 3 + 2] += by * (Math.max(0, 1 - ((y - 1.13) / 0.08) ** 2) - Math.max(0, 1 - ((y - 0.98) / 0.07) ** 2));
  }
  return { ...body, positions: P };
}
/** Where the plane at height `y` cuts the outer faces of `g`'s trunk: segments [x0, z0, x1, z1]. */
function sliceOuter(g, y) {
  const P = g.positions,
    I = g.indices,
    segs = [];
  for (let t = 0; t < g.faces.length; t++) {
    if (g.faces[t] !== F.FACE.outer || g.parts[I[t * 3]] !== 0) continue;
    const cut = [];
    for (let e = 0; e < 3; e++) {
      const a = I[t * 3 + e] * 3,
        b = I[t * 3 + ((e + 1) % 3)] * 3,
        f = (y - P[a + 1]) / (P[b + 1] - P[a + 1]);
      if ((P[a + 1] - y) * (P[b + 1] - y) < 0) cut.push(P[a] + f * (P[b] - P[a]), P[a + 2] + f * (P[b + 2] - P[a + 2]));
    }
    if (cut.length === 4) segs.push(cut);
  }
  return segs;
}
/** The most forward z of a slice on the vertical line `x`. */
const frontOf = (segs, x) =>
  Math.max(
    ...segs
      .filter(([x0, , x1]) => (x0 - x) * (x1 - x) <= 0 && x0 !== x1)
      .map(([x0, z0, x1, z1]) => z0 + ((z1 - z0) * (x - x0)) / (x1 - x0)),
  );
test('the townsman coat hangs plumb all round the front over a belly: no column comes back in below the waist', () => {
  for (const pose of ['T', 'A']) {
    const fit = F.fitOutfit(bellied(pose, 0.04), 'townsman-1910'),
      g = fit.garments.find((x) => x.spec.name === 'coat');
    let hem = Infinity;
    for (let v = 0; v < g.positions.length / 3; v++) if (g.parts[v] === 0) hem = Math.min(hem, g.positions[v * 3 + 1]);
    const columns = [-0.08, -0.04, 0, 0.04, 0.08],
      most = columns.map(() => -Infinity);
    for (let y = fit.measures.chestHeight - 0.04; y > hem + 0.01; y -= 0.01) {
      const segs = sliceOuter(g, y);
      columns.forEach((x, i) => {
        const z = frontOf(segs, x);
        assert.ok(
          z >= most[i] - 0.001,
          `${pose}: front ${z.toFixed(4)} at x ${x}, ${y.toFixed(3)} is back in from ${most[i].toFixed(4)} above`,
        );
        most[i] = Math.max(most[i], z);
      });
    }
  }
});
// Dressed Wilbur's coat swelled into a barrel with the arms down (dressed6, 2026-11-18): 2.2 cm wider each side than
// his chest from the chest to the hem, the back 1.8 cm further out. A Character Creator body stands in an A-pose with
// the roots of the lats and deltoids standing out under the arms and partly weighted to them; the coat hung plumb from
// that ring at rest, so once the arms came down and pulled that flesh in, the coat stood 5 to 8 cm off the sides. The
// coat now hangs from the trunk as it stands with the arms down. Measured on this body before the fix, the coat stood
// 30.5 to 36 mm (A) and 45 to 50 mm (T) off the lowered chest between waist and hip; after, at most 9 and 21 mm. The
// bound is the stack of shirt, vest and coat (each layer's ease, gap and thickness) plus 4 mm.
test('the townsman coat hangs from the chest as worn with the arms down, not from an A-pose armpit', () => {
  const g = (name) => OUTFITS['townsman-1910'].garments.find((x) => x.name === name),
    stack = [g('shirt'), g('vest'), g('coat')].reduce((s, x, i) => s + x.ease + (i ? 0.002 : 0.003) + x.thickness, 0);
  for (const [pose, drop] of [
    ['A', 45],
    ['T', 90],
  ]) {
    const body = riggedTestBody(pose, { lean: true, armRoots: true }),
      fit = F.fitOutfit(body, 'townsman-1910'),
      coat = fit.garments.find((x) => x.spec.name === 'coat'),
      skin = poseSkin(body, { leftUpperArm: quat([0, 0, 1], -drop), rightUpperArm: quat([0, 0, 1], drop) }),
      bp = skinned(body.positions, body.normals, body.joints, body.weights, skin).positions,
      cp = skinned(coat.positions, coat.normals, coat.joints, coat.weights, skin).positions,
      arm = new Set(
        ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'].map((b) =>
          BONES.indexOf(b),
        ),
      ),
      trunk = (v) =>
        [0, 1, 2, 3].reduce((s, i) => s + (arm.has(body.joints[v * 4 + i]) ? body.weights[v * 4 + i] : 0), 0) < 0.5,
      halfBreadth = (P, keep, y) => {
        let x = 0;
        for (let v = 0; v < P.length / 3; v++)
          if (keep(v) && Math.abs(P[v * 3 + 1] - y) < 0.01) x = Math.max(x, Math.abs(P[v * 3]));
        return x;
      },
      m = fit.measures;
    let chest = 0;
    for (let y = m.waistHeight; y <= m.chestHeight + 0.04; y += 0.01)
      chest = Math.max(chest, halfBreadth(bp, trunk, y));
    for (let y = m.waistHeight; y >= m.hipHeight; y -= 0.02) {
      const off = halfBreadth(cp, (v) => coat.parts[v] === 0, y) - chest;
      assert.ok(
        off <= stack + 0.004,
        `${pose}: the coat stands ${off.toFixed(4)} m off the lowered chest at ${y.toFixed(2)} (layers ${stack.toFixed(4)})`,
      );
    }
  }
});
// Every garment was a smooth shell (the dressed Wilbur frames of 2026-11-18): no drape, no folds. The outer garments
// now stand out in folds where cloth has girth or length to spare (Rohmer et al. 2010).
/** The outer-face vertices of `g` on `part`: position, normal and uv (u round the ring, v along the tube). */
function outerOf(g, part) {
  const keep = new Uint8Array(g.positions.length / 3);
  for (let t = 0; t < g.faces.length; t++)
    if (g.faces[t] === F.FACE.outer) for (let c = 0; c < 3; c++) keep[g.indices[t * 3 + c]] = 1;
  const out = [];
  for (let v = 0; v < keep.length; v++)
    if (keep[v] && g.parts[v] === part)
      out.push({
        p: [0, 1, 2].map((i) => g.positions[v * 3 + i]),
        n: [0, 1, 2].map((i) => g.normals[v * 3 + i]),
        u: g.uvs[v * 2],
        v: g.uvs[v * 2 + 1],
      });
  return out;
}
/** How often a sequence of turns changes sign (turns under `by` left out): 0 on a smooth convex surface. */
function reversals(turns, by) {
  let count = 0,
    last = 0;
  for (const t of turns)
    if (Math.abs(t) > by) {
      if (last && Math.sign(t) !== last) count++;
      last = Math.sign(t);
    }
  return count;
}
test('the outer garments drape in folds: flutes round the coat, creases behind the knee and a break over the boot', () => {
  const m = suit.measures;
  // Round the coat's ring nearest the seat a smooth convex shell's normal turns one way all round; flutes turn it back
  // and forth (the cloth goes concave between them).
  const coatPts = outerOf(coat, 0),
    rowY = coatPts.reduce(
      (best, q) => (Math.abs(q.p[1] - m.hipHeight) < Math.abs(best - m.hipHeight) ? q.p[1] : best),
      Infinity,
    ),
    ring = coatPts.filter((q) => Math.abs(q.p[1] - rowY) < 1e-5 && q.u < 1).sort((a, b) => a.u - b.u),
    turns = ring.map((q, i) => {
      const n = ring[(i + 1) % ring.length].n;
      return q.n[2] * n[0] - q.n[0] * n[2];
    });
  assert.ok(
    reversals(turns, 1e-3) >= 4,
    `coat flutes round the seat: ${reversals(turns, 1e-3)} reversals over ${ring.length} vertices`,
  );
  // Down the back (and the front) of the left trouser leg the normal tips up and down over each crease.
  const leg = outerOf(trousers, 6),
    column = (u, from, to) =>
      leg
        .filter((q) => Math.abs(q.u - u) < 1e-6 && q.p[1] > from && q.p[1] < to)
        .sort((a, b) => a.p[1] - b.p[1])
        .map((q) => q.n[1]),
    tilt = (ns) => ns.slice(1).map((n, i) => n - ns[i]);
  const hemY = Math.min(...leg.map((q) => q.p[1])),
    knee = reversals(tilt(column(0.75, m.kneeHeight - 0.07, m.kneeHeight + 0.07)), 0.01),
    hem = reversals(tilt(column(0.25, hemY + 0.005, hemY + 0.12)), 0.01);
  assert.ok(knee >= 3, `creases behind the knee: ${knee}`);
  assert.ok(hem >= 2, `the break over the boot: ${hem}`);
  // The coat sleeve creases inside the elbow and gathers over the cuff.
  const sleeve = outerOf(coat, 2),
    cuff = sleeve.filter((q) => Math.abs(q.u - 0.25) < 1e-6).sort((a, b) => a.v - b.v),
    along = cuff.slice(1).map((q, i) => q.n[0] * cuff[i].n[2] - q.n[2] * cuff[i].n[0]);
  assert.ok(reversals(along, 0.005) >= 4, `sleeve creases: ${reversals(along, 0.005)}`);
});
test("the townsman's trousers taper from the thigh to Gordon's knee and bottom", () => {
  const m = suit.measures;
  // Trousers taper from the thigh to Gordon's knee (19 inches on a 37 inch seat) and on toward the bottom (an inch less).
  const knee = (m.hipGirth * 19) / 37,
    calfY = 0.25,
    hem = 0.09, // the ankle joint and a centimetre
    calf = knee - (0.0254 * (m.kneeHeight - calfY)) / (m.kneeHeight - hem);
  near(girthAt(trousers, m.kneeHeight, 6), knee, 0.015, 'trouser knee girth');
  near(girthAt(trousers, calfY, 6), calf, 0.015, 'trouser girth down the calf');
});

// The wool was drawn flat black: charcoal at 0.03 linear left a base colour of 0.004 once the fit took the cloth's
// surface reflection out of the dye's albedo.
// The townsman's hat read as a top hat (dressed6, 2026-11-18): a straight 11 cm crown with a flat top. The Wrights wear
// stiff felt derbies in town in the Library of Congress photographs; a derby's crown rounds over from about halfway up,
// 4 1/2 to 5 1/2 inches tall on a 2 inch brim in the period catalogues.
test('the townsman wears a derby: its crown rounds over from about halfway up, 5 1/4 inches tall on a 2 inch brim', () => {
  const hat = suit.garments.find((x) => x.spec.name === 'hat'),
    P = hat.positions,
    centre = [0, 2].map((i) => {
      let lo = Infinity,
        hi = -Infinity;
      for (let v = 0; v < P.length / 3; v++) [lo, hi] = [Math.min(lo, P[v * 3 + i]), Math.max(hi, P[v * 3 + i])];
      return (lo + hi) / 2;
    });
  let base = Infinity,
    top = -Infinity,
    brim = 0;
  for (let v = 0; v < P.length / 3; v++) {
    base = Math.min(base, P[v * 3 + 1]);
    top = Math.max(top, P[v * 3 + 1]);
    brim = Math.max(brim, Math.hypot(P[v * 3] - centre[0], P[v * 3 + 2] - centre[1]));
  }
  /** The crown's widest reach on its row nearest a share of its height (above the brim's top). */
  const reach = (f) => {
    const want = base + (top - base) * f;
    let y = Infinity,
      r = 0;
    for (let v = 0; v < P.length / 3; v++)
      if (P[v * 3 + 1] > base + 0.004 && Math.abs(P[v * 3 + 1] - want) < Math.abs(y - want)) y = P[v * 3 + 1];
    for (let v = 0; v < P.length / 3; v++)
      if (Math.abs(P[v * 3 + 1] - y) < 1e-4)
        r = Math.max(r, Math.hypot(P[v * 3] - centre[0], P[v * 3 + 2] - centre[1]));
    return r;
  };
  near(top - base, 5.25 * 0.0254, 0.008, 'crown height over the brim');
  const band = reach(0.2);
  assert.ok(reach(0.45) > 0.95 * band, `straight sides to about halfway: ${reach(0.45)} against the band's ${band}`);
  assert.ok(
    reach(0.85) < 0.8 * band && reach(0.85) > 0.4 * band,
    `rounded over near the top: ${reach(0.85)} against the band's ${band}`,
  );
  near(brim - band, 2 * 0.0254, 0.006, 'brim width');
});
test("the townsman's wool is a dark grey-brown cloth, not black", () => {
  const coat = OUTFITS['townsman-1910'].garments.find((g) => g.name === 'coat'),
    { baseColor } = garmentMaterial(coat),
    luminance = 0.2126 * baseColor[0] + 0.7152 * baseColor[1] + 0.0722 * baseColor[2];
  assert.ok(luminance > 0.03 && luminance < 0.1, `drawn luminance ${luminance}`);
  assert.ok(baseColor[0] > baseColor[2], 'warm: brown-grey');
});
