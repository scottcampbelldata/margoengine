import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { GrassScatter, grassPoseCode, grassRings, grassShape } from '../dist/grass.js';
import { Scatter, coverCode, coverDeclaration, splitDeclaration } from '../dist/index.js';

const bounds = (g) => {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.vertices.length; i += 6)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], g.vertices[i + a]);
      max[a] = Math.max(max[a], g.vertices[i + a]);
    }
  return { min, max };
};

test('grassRings: a clump of strips per ring, fewer segments further out', () => {
  const rings = grassRings({ blades: 4, segments: [6, 2, 1] });
  // A blade of s segments has two vertices a step, the tip a pair too (the pixel floor widens it), and 2s triangles.
  assert.deepEqual(
    rings.map((g) => [g.vertices.length / 6, g.indices.length / 3]),
    [6, 2, 1].map((s) => [4 * (2 * s + 2), 4 * (2 * s)]),
  );
  for (const g of rings)
    for (let i = 3; i < g.vertices.length; i += 6) assert.deepEqual([...g.vertices.subarray(i, i + 3)], [0, 0, 1]);
});

test('grassRings: the mesh box holds every blade the GPU builds', () => {
  const shape = { height: 0.8, width: 0.1, radius: 0.3, lean: 0.5 },
    reach = 0.3 + 0.5 * 0.8 + 0.05;
  const { min, max } = bounds(grassRings(shape)[0]);
  assert.ok(Math.abs(max[1] - 0.8) < 1e-6 && min[1] === 0, 'root at 0, top at the tallest blade');
  for (const a of [0, 2]) {
    assert.ok(Math.abs(max[a] - reach) < 1e-6 && Math.abs(min[a] + reach) < 1e-6, `axis ${a}: ${min[a]} to ${max[a]}`);
  }
  // A clump of one blade still spans its reach across x and z: the GPU turns it to any heading, so a box flat in z
  // culled clumps whose blade leaned out of it (the GPU check drew fewer instances for 1 blade than for 16).
  for (const ring of grassRings({ ...shape, blades: 1 })) {
    const single = bounds(ring);
    for (const a of [0, 2])
      assert.ok(
        Math.abs(single.max[a] - reach) < 1e-6 && Math.abs(single.min[a] + reach) < 1e-6,
        `one blade, axis ${a}`,
      );
  }
});

test('grassShape: defaults and refusals that say how to fix it', () => {
  assert.deepEqual(grassShape(), {
    height: 0.6,
    heightVariance: 0.4,
    width: 0.04,
    blades: 8,
    radius: 0.15,
    lean: 0.35,
    round: 0.3,
    segments: [5, 3, 1],
  });
  for (const bad of [
    { height: 0 },
    { width: -1 },
    { blades: 0 },
    { blades: 2.5 },
    { blades: 65 },
    { lean: 1 },
    { heightVariance: 0.99 },
    { round: 2 },
    { radius: Number.NaN },
    { segments: [1, 3, 5] },
    { segments: [5, 3] },
    { segments: [17, 3, 1] },
  ])
    assert.throws(
      () => grassShape(bad),
      (e) => e instanceof RangeError && /non-increasing integer segments/.test(e.message),
      JSON.stringify(bad),
    );
  assert.throws(
    () => grassShape(null),
    (e) => e instanceof TypeError && /omit it for the defaults/.test(e.message),
  );
});

test('grassPoseCode: wraps scatterPose once with the shape compiled in', () => {
  const stage =
    'struct ScatterPose {world:vec3f}\nfn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f)->ScatterPose {}\n';
  const code = grassPoseCode(stage, { height: 2, blades: 3, width: 0.05 });
  assert.equal(code.split('fn scatterPose(').length, 2);
  assert.equal(code.split('fn scatterPoseBase(').length, 2);
  // Whole numbers are written as f32 literals.
  assert.match(code, /p\.y\/2\.0;/);
  assert.match(code, /0\.5\*2\.0\)\);/);
  assert.match(code, /let w=0\.05;/);
  // KB-SCATTER-SUBPIXEL1: the pose takes the camera's pixel footprint and floors the blade's width at it, keeping
  // w^2 / (w^2 + p^2) of the blades (w / 2p under a pixel) so the field's area stays the same.
  assert.match(code, /pixel:f32,sway:vec4f\)->ScatterPose \{/);
  assert.match(code, /grassVertex\(p,position,wide,d\*pixel\/\(wide\*position\.w\),view\)/);
  assert.match(code, /let foot=1\.5\*pix;/);
  // The floor and the kept share use the width the eye sees (seen at least 0.25; under a pixel edge on, left out).
  assert.match(code, /let wt=w\*\(1\.0-t\); let drawn=max\(wt,foot\/seen\);/);
  assert.doesNotMatch(code, /scatterCover/, 'an opaque ring keeps the hashed share');
  assert.match(code, /select\(wp\*wp\/\(wp\*wp\+foot\*foot\),wp\/\(2\.0\*foot\),wp<foot\)/);
  assert.match(code, /keep=select\(keep,0\.0,face<0\.25&&wp<foot\);/);
  assert.throws(
    () => grassPoseCode('fn main(){}'),
    (e) => e instanceof TypeError && /scatter vertex stage/.test(e.message),
  );
});

test('GrassScatter: a Scatter with no mesh input, blades shading on', () => {
  const grass = new GrassScatter({ count: 64, grass: { blades: 3 } });
  assert.ok(grass instanceof Scatter);
  assert.equal(grass.grass.blades, 3);
  assert.ok(Object.isFrozen(grass.grass) && Object.isFrozen(grass.grass.segments));
  assert.throws(() => new GrassScatter({ grass: { blades: 0 } }), RangeError);
  assert.throws(() => new GrassScatter({ lod: [3, 2, 1] }), /rules/);
  assert.throws(
    () => GrassScatter.attach({}, box()),
    (e) => e instanceof TypeError && /without meshes/.test(e.message),
  );
  assert.throws(() => new GrassScatter(null), TypeError);
});

test('grassPoseCode: a covered ring keeps every blade, widened across its screen axis by the filter radius (KB-SCATTER-SUBPIXEL1)', () => {
  const stage =
    coverDeclaration +
    'struct ScatterPose {world:vec3f}\nfn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f)->ScatterPose {}\n';
  const code = grassPoseCode(stage, { width: 0.05 });
  // Across as the screen shows it: perpendicular to the spine and the eye, on the side of right.
  assert.match(
    code,
    /var perp=cross\(tangent,view\);perp=select\(right,perp\/length\(perp\),dot\(perp,perp\)>1e-12\);/,
  );
  assert.match(
    code,
    /perp=select\(perp,-perp,dot\(perp,right\)<0\.0\);let rp=dot\(right,perp\);let h=0\.5\*wt\*rp\/max\(pix,1e-30\);/,
  );
  // A blade under 8 pixels tall turns to the two-pixel filter over 4 pixels, and is drawn that much wider.
  assert.match(
    code,
    /let far=clamp\(\(8\.0-height\/max\(pix,1e-30\)\)\/4\.0,0\.0,1\.0\);let fr=select\(1\.0,2\.0,far>0\.0\);/,
  );
  assert.match(
    code,
    /let across=select\(right\*\(side\*0\.5\*wt\),right\*\(side\*0\.5\*wt\)\+perp\*\(side\*fr\*pix\),pix>0\.0\);/,
  );
  // w: the blade's hashed depth threshold for the coverage-depth stage (KB-SCENES-DUNE-GTAO1).
  assert.match(
    code,
    /scatterCover=select\(vec4f\(0\.0,65536\.0,0\.0,0\.5\),vec4f\(side\*\(h\+fr\),h,far,grassHash\(seed\^0x3c6ef372u\)\),pix>0\.0\);/,
  );
  // scatterPose widens x and z by wide afterwards, so across's height is widened to match.
  assert.match(code, /\+vec3f\(across\.x,across\.y\*wide,across\.z\);/);
  assert.match(code, /let grow=1\.0;let t=along;/);
  assert.doesNotMatch(code, /var keep=|grow<=0\.0/, 'no blade is left out by a hash');
});

test('grassPoseCode: a split ring draws each blade opaque a filter radius in from its edges, then covered whole (KB-SCATTER-SUBPIXEL1)', () => {
  const stage =
    'struct ScatterPose {world:vec3f}\nfn scatterPose(p:vec3f,n:vec3f,position:vec4f,rotation:vec4f)->ScatterPose {}\n';
  const body = grassPoseCode(splitDeclaration + stage, { width: 0.05 });
  assert.match(
    body,
    /let across=right\*\(side\*select\(0\.5\*wt,max\(h-fr,0\.0\)\*pix\/max\(rp,1e-3\),pix>0\.0\)\);/,
    'the opaque core',
  );
  assert.doesNotMatch(body, /scatterCover=|var keep=|grow<=0\.0/, 'opaque, every blade, no hashed keep');
  const tip = grassPoseCode(splitDeclaration + coverDeclaration + stage, { width: 0.05 });
  assert.match(tip, /right\*\(side\*0\.5\*wt\)\+perp\*\(side\*fr\*pix\)/, 'the covered stage draws the whole blade');
  assert.match(tip, /scatterCover=select\(/);
  // GrassScatter splits the near ring and covers the middle and far ones; a plain Scatter draws every ring opaque.
  const grass = new GrassScatter({ count: 64 });
  assert.deepEqual(
    [0, 1, 2].map((i) => grass.coverRing(i)),
    ['split', 'cover', 'cover'],
  );
  const plain = new Scatter(grassRings(), { count: 64 });
  assert.deepEqual(
    [0, 1, 2].map((i) => plain.coverRing(i)),
    ['opaque', 'opaque', 'opaque'],
  );
});

test('coverCode: the tent filters of a strip sum to its true width over pixel centres one apart (KB-SCATTER-SUBPIXEL1)', () => {
  const unlit =
    'struct Output {@builtin(position) clip:vec4f,@location(3) shade:f32}\n' +
    '@vertex fn vertex()->Output{return Output(vec4f(0),pose.ground,pose.shade);}\n' +
    '@fragment fn fragment(i:Output)->@location(0) vec4f {let color=vec3f(1);return vec4f(color,1);}';
  const code = coverCode(unlit, false);
  // The WGSL, pinned, and the same sums in JavaScript.
  assert.ok(
    code.includes(
      'fn scatterTent(u:f32)->f32 {let v=clamp(u,-1.0,1.0);return select(1.0-(1.0-v)*(1.0-v)*0.5,(1.0+v)*(1.0+v)*0.5,v<0.0);}\n' +
        'fn scatterStrip(s:f32,h:f32,r:f32)->f32 {return clamp(scatterTent((h-s)/r)-scatterTent((-h-s)/r),0.0,1.0);}\n' +
        'fn scatterCoverage(e:vec4f)->f32 {return mix(scatterStrip(e.x,e.y,1.0),scatterStrip(e.x,e.y,2.0),e.z);}\n',
    ),
  );
  const tent = (u) => {
    const v = Math.min(Math.max(u, -1), 1);
    return v < 0 ? (1 + v) * (1 + v) * 0.5 : 1 - (1 - v) * (1 - v) * 0.5;
  };
  const strip = (s, h, r) => Math.min(Math.max(tent((h - s) / r) - tent((-h - s) / r), 0), 1);
  const coverage = (s, h, far) => strip(s, h, 1) * (1 - far) + strip(s, h, 2) * far;
  for (const h of [0.02, 0.3, 0.5, 0.8, 1.7, 4.2])
    for (const far of [0, 0.35, 1])
      for (const offset of [0, 0.13, 0.5, 0.77]) {
        // Pixel centres one apart across a strip drawn h + fr either side of its centre line, offset from it.
        const fr = far > 0 ? 2 : 1;
        let sum = 0;
        for (let k = -10; k <= 10; k++) {
          const x = k + offset;
          if (Math.abs(x) <= h + fr) sum += coverage(x, h, far);
        }
        assert.ok(Math.abs(sum - 2 * h) < 1e-9, JSON.stringify({ h, far, offset, sum }));
      }
  assert.equal(coverage(0, 65536, 0), 1, 'the default covers fully');
  assert.equal(coverage(1.9, 3, 0), 1, 'inside the core');
  assert.equal(coverage(4.1, 3, 0), 0, 'past the drawn edge');
});

test('coverCode: the vertex hands scatterCover to the fragment, which writes it as alpha (KB-SCATTER-SUBPIXEL1)', () => {
  const unlit =
    'struct ScatterPose {world:vec3f,shade:f32}\nstruct Output {@builtin(position) clip:vec4f,@location(3) @interpolate(perspective,centroid) shade:f32}\n' +
    '@vertex fn vertex()->Output{return Output(vec4f(0),pose.ground,pose.shade);}\n' +
    '@fragment fn fragment(i:Output)->@location(0) vec4f {let color=vec3f(1);return vec4f(color,1);}';
  const u = coverCode(unlit, false);
  assert.ok(u.startsWith(coverDeclaration));
  assert.match(u, /shade:f32,@location\(4\) cover:vec4f\}/);
  assert.match(u, /struct ScatterPose \{world:vec3f,shade:f32\}/, 'the pose struct is left alone');
  assert.match(u, /pose\.shade,scatterCover\);/);
  assert.match(u, /return vec4f\(color,scatterCoverage\(i\.cover\)\);\}/);
  const lit =
    'struct Output { @builtin(position) clip:vec4f,@location(3) material:vec4f }\n' +
    '@vertex fn vertex(@location(0) p:vec3f)->Output {var o:Output;return o;}\n' +
    '@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {\nif(!front){discard;}return vec4f(1);\n}';
  const l = coverCode(lit, true, 5);
  assert.match(l, /@location\(3\) material:vec4f ,@location\(5\) cover:vec4f\}/);
  assert.match(l, /o\.cover=scatterCover;return o;/);
  assert.match(l, /fn scatterOpaque\(i:Output,front:bool\)->vec4f \{\nif\(!front\)\{discard;\}/);
  assert.match(
    l,
    /@fragment fn fragment\(i:Output,@builtin\(front_facing\) front:bool\)->@location\(0\) vec4f \{let c=scatterOpaque\(i,front\);return vec4f\(c\.rgb,c\.a\*scatterCoverage\(i\.cover\)\);\}/,
  );
  // A stage this cannot wrap (several targets) stays opaque.
  assert.equal(coverCode(lit.replace('->@location(0) vec4f', '->Targets'), true, 5), undefined);
  assert.equal(coverCode(unlit.replace('return vec4f(color,1);}', 'return out;}'), false), undefined);
});

test('coverCode depth: the coverage-depth stage keeps a fragment above its threshold and discards the rest (KB-SCENES-DUNE-GTAO1)', () => {
  // Blended blades wrote no depth, so GTAO found no grass to occlude the sand and the dune coast's camp view lost its
  // shade. The depth stage is drawn after the blending: the same pose and coverage, depth only.
  assert.ok(
    coverDeclaration.includes('var<private> scatterCover:vec4f=vec4f(0.0,65536.0,0.0,0.5);'),
    'default: above half',
  );
  const unlit =
    'struct Output {@builtin(position) clip:vec4f,@location(3) shade:f32}\n' +
    '@vertex fn vertex()->Output{return Output(vec4f(0),pose.ground,pose.shade);}\n' +
    '@fragment fn fragment(i:Output)->@location(0) vec4f {let color=vec3f(1);return vec4f(color,1);}';
  const u = coverCode(unlit, false, 0, true);
  assert.match(u, /if\(scatterCoverage\(i\.cover\)<=i\.cover\.w\)\{discard;\}return vec4f\(color,1\);\}/);
  assert.doesNotMatch(u, /return vec4f\(color,scatterCoverage/, 'no blended alpha');
  assert.match(
    coverCode(unlit, false),
    /return vec4f\(color,scatterCoverage\(i\.cover\)\);\}/,
    'the colour stage blends',
  );
  const lit =
    'struct Output { @builtin(position) clip:vec4f,@location(3) material:vec4f }\n' +
    '@vertex fn vertex(@location(0) p:vec3f)->Output {var o:Output;return o;}\n' +
    '@fragment fn fragment(varyings:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {\nreturn vec4f(1);\n}';
  const l = coverCode(lit, true, 5, true);
  assert.match(l, /o\.cover=scatterCover;return o;/);
  assert.match(
    l,
    /let c=scatterOpaque\(varyings,front\);if\(c\.a\*scatterCoverage\(varyings\.cover\)<=varyings\.cover\.w\)\{discard;\}return c;\}/,
  );
});
