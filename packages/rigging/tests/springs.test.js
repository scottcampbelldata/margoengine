// Spring bones and jiggle: the step against the specification's own pseudocode at 60 Hz, frame-rate independence,
// colliders, center space, scale, teleports, and a real rig: the tail of Khronos' Fox on a running Animator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation, Skeleton } from '../../animation/dist/index.js';
import { Animator } from '../../animator/dist/index.js';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';
import { SpringBones, addSpringBones } from '../dist/springs.js';

// A rope: root bone, then `links` bones of one unit down -y.
function rope(links = 3) {
  const parents = [-1],
    local = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
  for (let i = 1; i <= links; i++) {
    parents.push(i - 1);
    local.push(0, -1, 0, 0, 0, 0, 1, 1, 1, 1);
  }
  return { parents, local: Float64Array.from(local), joints: parents.map((_, i) => i).slice(1) };
}
// World positions of a pose's bones.
function positions({ parents, local }) {
  const q = [],
    p = [];
  const rotate = (v, r) => {
    const u = [r[0], r[1], r[2]],
      w = r[3],
      c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      d = [u[1] * c[2] - u[2] * c[1], u[2] * c[0] - u[0] * c[2], u[0] * c[1] - u[1] * c[0]];
    return v.map((x, i) => x + 2 * (w * c[i] + d[i]));
  };
  const multiply = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  parents.forEach((parent, b) => {
    const t = Array.from(local.subarray(b * 10, b * 10 + 3)),
      r = Array.from(local.subarray(b * 10 + 3, b * 10 + 7));
    if (parent < 0) {
      p[b] = t;
      q[b] = r;
    } else {
      const moved = rotate(t, q[parent]);
      p[b] = moved.map((v, i) => v + p[parent][i]);
      q[b] = multiply(q[parent], r);
    }
  });
  return p;
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('at 60 Hz one step is the specification: Verlet, stiffness, gravity, length', () => {
  const pose = rope(1),
    settings = { stiffness: 0.7, drag: 0.3, gravity: 0.4, gravityDirection: [1, 0, 0] },
    springs = new SpringBones(pose.parents, { chains: [{ joints: [0, 1], ...settings }] }),
    h = 1 / 60;
  let current = [0, -1, 0],
    previous = [0, -1, 0],
    head = [0, 0, 0];
  for (let frame = 0; frame < 60; frame++) {
    head = [Math.sin(frame / 7), 0, 0];
    pose.local[0] = head[0];
    pose.local.set([0, 0, 0, 1], 3);
    springs.stepPose(pose, h);
    const next = current.map(
      (v, i) => v + (v - previous[i]) * (1 - 0.3) + h * 0.7 * [0, -1, 0][i] + h * 0.4 * [1, 0, 0][i],
    );
    const length = distance(next, head),
      held = next.map((v, i) => head[i] + (v - head[i]) / length);
    previous = current;
    current = held;
    const tail = positions(pose)[1];
    assert.ok(distance(tail, current) < 1e-9, `frame ${frame}: ${tail} against ${current}`);
  }
});

test('the same motion looks the same at 30, 60 and 144 frames a second', () => {
  const run = (rate) => {
    const pose = rope(3),
      springs = new SpringBones(pose.parents, {
        chains: [{ joints: pose.joints, stiffness: 2, drag: 0.2, gravity: 0.5 }],
      }),
      samples = [];
    for (let frame = 0; frame <= rate * 3; frame++) {
      const time = frame / rate;
      pose.local[0] = 0.6 * Math.sin(time * 4);
      pose.local.set([0, 0, 0, 1], 3);
      for (let b = 1; b < 4; b++) pose.local.set([0, 0, 0, 1], b * 10 + 3);
      springs.stepPose(pose, 1 / rate);
      if (frame % (rate / 2 | 0 || 1) === 0 && Number.isInteger(time * 2)) samples.push(positions(pose)[3]);
    }
    return samples;
  };
  const low = run(30),
    mid = run(60),
    high = run(144);
  assert.equal(mid.length, 7);
  assert.equal(low.length, 7);
  assert.equal(high.length, 7);
  mid.forEach((sample, i) => {
    assert.ok(distance(sample, low[i]) < 0.002, `30 Hz sample ${i}: ${distance(sample, low[i])}`);
    assert.ok(distance(sample, high[i]) < 0.06, `144 Hz sample ${i}: ${distance(sample, high[i])}`);
  });
});

test('a swing keeps bone lengths, lags the head and settles on the animated pose', () => {
  const pose = rope(3),
    springs = new SpringBones(pose.parents, { chains: [{ joints: pose.joints, stiffness: 3, drag: 0.3 }] }),
    reset = () => {
      for (let b = 1; b < 4; b++) pose.local.set([0, 0, 0, 1], b * 10 + 3);
    };
  springs.stepPose(pose, 1 / 60);
  let lag = 0;
  for (let frame = 0; frame < 30; frame++) {
    pose.local[0] = frame * 0.03;
    reset();
    springs.stepPose(pose, 1 / 60);
    const p = positions(pose);
    for (let b = 1; b < 4; b++) assert.ok(Math.abs(distance(p[b], p[b - 1]) - 1) < 1e-9);
    lag = Math.max(lag, pose.local[0] - p[3][0]);
  }
  assert.ok(lag > 0.2, `tip trails the head: ${lag}`);
  for (let frame = 0; frame < 600; frame++) {
    reset();
    springs.stepPose(pose, 1 / 60);
  }
  const p = positions(pose);
  assert.ok(distance(p[3], [pose.local[0], -3, 0]) < 1e-3, `settled at ${p[3]}`);
});

test('the chain settles on the clip, not on the rest pose', () => {
  const pose = rope(2),
    turn = [0, 0, Math.sin(0.4), Math.cos(0.4)],
    springs = new SpringBones(pose.parents, { chains: [{ joints: pose.joints, stiffness: 4 }] });
  for (let frame = 0; frame < 400; frame++) {
    pose.local.set(turn, 13);
    pose.local.set([0, 0, 0, 1], 23);
    springs.stepPose(pose, 1 / 60);
  }
  assert.ok(Math.abs(pose.local[13 + 2] - turn[2]) < 1e-3, `rotation ${pose.local[15]}`);
});

test('gravity droops a sideways bone; a joint setting beats the chain setting', () => {
  const parents = [-1, 0],
    pose = () => ({ parents, local: Float64Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1]) }),
    settle = (chain) => {
      const p = pose(),
        springs = new SpringBones(parents, { chains: [chain] });
      for (let i = 0; i < 400; i++) {
        p.local.set([0, 0, 0, 1], 3);
        springs.stepPose(p, 1 / 60);
      }
      return positions(p)[1];
    };
  const stiff = settle({ joints: [0, 1], stiffness: 3, gravity: 0 }),
    droop = settle({ joints: [0, 1], stiffness: 3, gravity: 3 }),
    own = settle({ joints: [0, 1], stiffness: 3, gravity: 0, settings: [{ gravity: 3 }] });
  assert.ok(Math.abs(stiff[1]) < 1e-6);
  assert.ok(droop[1] < -0.5, `droop ${droop}`);
  assert.ok(distance(droop, own) < 1e-9);
});

test('tails stay out of spheres and capsules, joint radius included', () => {
  for (const collider of [
    { offset: [0.35, -1, 0], radius: 0.3 },
    { offset: [0.35, -2, 0], tail: [0.35, -0.2, 0], radius: 0.3 },
  ]) {
    const pose = rope(1),
      springs = new SpringBones(pose.parents, {
        chains: [{ joints: [0, 1], stiffness: 1, radius: 0.1 }],
        colliders: [collider],
      });
    springs.stepPose(pose, 1 / 60);
    for (let frame = 0; frame < 120; frame++) {
      pose.local.set([0, 0, Math.sin(0.25), Math.cos(0.25)], 3);
      pose.local.set([0, 0, 0, 1], 13);
      springs.stepPose(pose, 1 / 60);
      const tail = positions(pose)[1];
      const centre = collider.tail ? [0.35, tail[1], 0] : collider.offset;
      // The length hold after the push can leave a hair of overlap, as in the specification's reference.
      assert.ok(distance(tail, centre) >= 0.4 - 1e-3, `frame ${frame}: ${distance(tail, centre)}`);
    }
  }
});

test('a chain hits only the colliders it names', () => {
  const pose = rope(1),
    collider = { offset: [0, -1, 0], radius: 0.3 },
    springs = new SpringBones(pose.parents, { chains: [{ joints: [0, 1], colliders: [] }], colliders: [collider] });
  springs.stepPose(pose, 1 / 60);
  springs.stepPose(pose, 1 / 60);
  assert.ok(distance(positions(pose)[1], [0, -1, 0]) < 1e-9);
});

test('center: a moving center does not swing the chain, its own head motion does', () => {
  const run = (center) => {
    const parents = [-1, 0, 1],
      local = Float64Array.from([
        ...[0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
        ...[0, -1, 0, 0, 0, 0, 1, 1, 1, 1],
        ...[0, -1, 0, 0, 0, 0, 1, 1, 1, 1],
      ]),
      springs = new SpringBones(parents, { chains: [{ joints: [1, 2], stiffness: 1, drag: 0.1, center }] });
    let swing = 0;
    for (let frame = 0; frame < 60; frame++) {
      local[0] = frame * 0.05;
      local.set([0, 0, 0, 1], 13);
      springs.stepPose({ parents, local }, 1 / 60);
      swing = Math.max(swing, Math.abs(positions({ parents, local })[2][0] - local[0]));
    }
    return swing;
  };
  assert.ok(run(null) > 0.1);
  assert.ok(run(0) < 1e-9);
});

test('center: gravity stays in world space when the center turns', () => {
  const parents = [-1, 1, 1],
    turned = [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    local = () =>
      Float64Array.from([
        ...[0, 0, 0, ...turned, 1, 1, 1],
        ...[0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
        ...[0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      ]);
  parents[1] = 0;
  parents[2] = 1;
  const pose = { parents, local: local() };
  pose.local.set([1, 0, 0], 20);
  const springs = new SpringBones(parents, {
    chains: [{ joints: [1, 2], stiffness: 0, drag: 0.5, gravity: 6, center: 0 }],
  });
  for (let i = 0; i < 300; i++) {
    pose.local.set([0, 0, 0, 1], 13);
    springs.stepPose(pose, 1 / 60);
  }
  const p = positions(pose);
  assert.ok(p[2][1] < -0.99, `hangs down the world: ${p[2]}`);
});

test('a model twice the size swings the same, twice as far', () => {
  const run = (size) => {
    const pose = rope(2),
      root = [size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, 0, 0, 0, 1],
      springs = new SpringBones(pose.parents, {
        chains: [{ joints: pose.joints, stiffness: 1, gravity: 0.5, radius: 0.1 }],
        colliders: [{ node: 0, offset: [0.5, -1, 0], radius: 0.3 }],
      }),
      out = [];
    for (let frame = 0; frame < 90; frame++) {
      pose.local[0] = 0.5 * Math.sin(frame / 9);
      pose.local.set([0, 0, 0, 1], 13);
      pose.local.set([0, 0, 0, 1], 23);
      springs.stepPose(pose, 1 / 60, root);
      out.push(positions(pose)[2].slice());
    }
    return out;
  };
  const small = run(1),
    large = run(2);
  small.forEach((p, i) => assert.ok(distance(p, large[i]) < 1e-9, `frame ${i}`));
});

test('a teleport restarts the chain instead of whipping; reset() does the same by hand', () => {
  const pose = rope(2),
    springs = new SpringBones(pose.parents, { chains: [{ joints: pose.joints }] }),
    frame = (x) => {
      pose.local[0] = x;
      pose.local.set([0, 0, 0, 1], 13);
      pose.local.set([0, 0, 0, 1], 23);
      springs.stepPose(pose, 1 / 60);
    };
  frame(0);
  frame(0);
  frame(50);
  assert.ok(distance(positions(pose)[2], [50, -2, 0]) < 1e-9);
  springs.options.teleportSpeed = 1e9;
  frame(100);
  assert.ok(distance(positions(pose)[2], [100, -2, 0]) > 1);
  springs.reset();
  frame(100);
  assert.ok(distance(positions(pose)[2], [100, -2, 0]) < 1e-9);
});

test('weight 0 leaves the pose alone, a delta of 0 holds the swing, a stall cannot blow up', () => {
  const pose = rope(2),
    options = { chains: [{ joints: pose.joints, stiffness: 1, drag: 0.1, gravity: 2 }], weight: 0 },
    springs = new SpringBones(pose.parents, options),
    frame = (x, delta) => {
      pose.local[0] = x;
      pose.local.set([0, 0, 0, 1], 13);
      pose.local.set([0, 0, 0, 1], 23);
      springs.stepPose(pose, delta);
    };
  frame(0, 1 / 60);
  frame(0.2, 1 / 60);
  assert.ok(distance(positions(pose)[2], [0.2, -2, 0]) < 1e-9);
  options.weight = 1;
  frame(0.4, 1 / 60);
  frame(0.6, 1 / 60);
  const held = positions(pose)[2];
  frame(0.6, 0);
  assert.ok(distance(positions(pose)[2], held) < 1e-9, 'held');
  frame(0.7, 5);
  const p = positions(pose);
  for (const point of p) assert.ok(point.every(Number.isFinite));
  assert.ok(Math.abs(distance(p[2], p[1]) - 1) < 1e-9);
});

test('a one-joint accessory swings with a tail; a chain below another sees it', () => {
  const parents = [-1, 0, 1, 2],
    local = Float64Array.from([
      ...[0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      ...[0, -1, 0, 0, 0, 0, 1, 1, 1, 1],
      ...[0, -1, 0, 0, 0, 0, 1, 1, 1, 1],
      ...[0, -1, 0, 0, 0, 0, 1, 1, 1, 1],
    ]),
    // The child chain is listed first: order comes from the skeleton.
    springs = new SpringBones(parents, {
      chains: [
        { joints: [3], tail: [0, -0.5, 0], stiffness: 1, drag: 0.2 },
        { joints: [0, 1, 2], stiffness: 1, drag: 0.2 },
      ],
    });
  const moves = [];
  for (let frame = 0; frame < 40; frame++) {
    local[0] = frame * 0.04;
    for (const b of [0, 1, 2, 3]) local.set([0, 0, 0, 1], b * 10 + 3);
    springs.stepPose({ parents, local }, 1 / 60);
    moves.push(Math.hypot(local[33], local[34], local[35]));
  }
  assert.ok(moves.at(-1) > 0.05, `accessory turned: ${moves.at(-1)}`);
});

test('jiggle lags, wobbles back, stays inside its limit and leaves no lag at a steady speed', () => {
  const parents = [-1, 0],
    make = () => Float64Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1]),
    run = (rate, drive, jiggle, seconds = 2) => {
      const options = { jiggles: [{ joint: 1, ...jiggle }] },
        springs = new SpringBones(parents, options),
        out = [];
      for (let frame = 0; frame <= rate * seconds; frame++) {
        const local = make();
        local[0] = drive(frame / rate);
        springs.stepPose({ parents, local }, 1 / rate);
        out.push(local[10] - 0);
      }
      return out;
    };
  // A step-like move, then rest.
  const moved = run(60, (t) => Math.min(t, 0.2) * 0.5, { limit: 0.02, frequency: 4, damping: 0.2 }),
    peak = Math.max(...moved.map(Math.abs));
  assert.ok(peak > 0.005 && peak <= 0.02 + 1e-9, `peak ${peak}`);
  assert.ok(moved.some((v) => v > 1e-4) && moved.some((v) => v < -1e-4), 'wobbles both ways');
  assert.ok(Math.abs(moved.at(-1)) < 1e-3, `settles: ${moved.at(-1)}`);
  // Constant speed: the bone keeps up exactly once the start has died away.
  const steady = run(60, (t) => t * 0.2, { limit: 1, damping: 1 }, 4);
  assert.ok(Math.abs(steady.at(-1)) < 1e-6, `steady lag ${steady.at(-1)}`);
  // Rest: nothing moves.
  assert.ok(
    run(60, () => 0, {}).every((v) => v === 0),
    'rest',
  );
});

test('stepSkeleton poses a Skeleton', () => {
  const skeleton = new Skeleton(
    [
      { name: 'a', parent: -1, position: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, -1, 0] },
      { name: 'c', parent: 1, position: [0, -1, 0] },
    ].map((b) => ({ ...b, translation: b.position })),
  );
  const springs = new SpringBones(Array.from(skeleton.parents), { chains: [{ joints: [0, 1, 2], gravity: 2 }] });
  for (let frame = 0; frame < 30; frame++) {
    skeleton.setPose(0, { translation: [frame * 0.05, 0, 0], rotation: [0, 0, 0, 1] });
    skeleton.setPose(1, { rotation: [0, 0, 0, 1] });
    springs.stepSkeleton(skeleton, 1 / 60);
  }
  const turned = skeleton.getPose(0).rotation;
  assert.ok(Math.abs(turned[2]) > 1e-3, `turned ${Array.from(turned)}`);
});

test('bad input is refused with a way out', () => {
  const parents = [-1, 0, 1, 0];
  const make = (options) => new SpringBones(parents, options);
  assert.throws(() => new SpringBones('nope', {}), TypeError);
  assert.throws(() => new SpringBones([1, 0], {}), RangeError);
  assert.throws(() => make({ chains: [{ joints: [] }] }), RangeError);
  assert.throws(() => make({ chains: [{ joints: [1] }] }), /tail/);
  assert.throws(() => make({ chains: [{ joints: [9, 1] }] }), RangeError);
  assert.throws(() => make({ chains: [{ joints: [1, 3] }] }), TypeError);
  assert.throws(() => make({ chains: [{ joints: [0, 1] }, { joints: [1, 2] }] }), /two spring chains/);
  assert.throws(() => make({ chains: [{ joints: [0, 1], center: 3 }] }), /center/);
  assert.throws(() => make({ chains: [{ joints: [0, 1], drag: 2 }] }), /drag/);
  assert.throws(() => make({ chains: [{ joints: [0, 1], stiffness: -1 }] }), /stiffness/);
  assert.throws(() => make({ chains: [{ joints: [0, 1], gravity: 1, gravityDirection: [0, 0, 0] }] }), /gravityDirection/);
  assert.throws(() => make({ chains: [{ joints: [0, 1], colliders: [0] }] }), /collider/);
  assert.throws(() => make({ colliders: [{ radius: 0 }] }), /radius/);
  assert.throws(() => make({ jiggles: [{ joint: 1, frequency: 90 }] }), /frequency/);
  assert.throws(() => make({ weight: 2 }), /weight/);
  const springs = make({ chains: [{ joints: [0, 1] }] }),
    local = new Float64Array(40);
  assert.throws(() => springs.stepPose({ parents, local }, -1), /delta/);
  assert.throws(() => springs.stepPose({ parents, local: [] }, 0), /10 numbers/);
  assert.throws(() => springs.stepPose({ parents: [-1], local }, 0), /parents/);
  assert.throws(() => springs.stepSkeleton({}, 0), /Skeleton/);
  // A bone with no scale has no direction: refused by code, not a NaN pose.
  const pose = rope(1);
  pose.local.fill(0, 7, 10);
  assert.throws(() => new SpringBones(pose.parents, { chains: [{ joints: [0, 1] }] }).stepPose(pose, 1 / 60), {
    code: 'state',
  });
});

test('the tail of a real rig on a real Animator: Fox runs, the tail trails it and the clip stays', async (t) => {
  const bytes = readFileSync(new URL('../../../examples/assets/khronos/Fox/Fox.glb', import.meta.url)),
    chunks = glbChunks(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((chunk) => chunk.type === GLB_JSON).data)),
    bin = chunks.find((chunk) => chunk.type === GLB_BIN).data;
  delete doc.images;
  delete doc.textures;
  delete doc.samplers;
  delete doc.materials;
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const store = await TransformStore.create(64),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, [bin])),
    animation = new Animation(model),
    animator = new Animator(animation, { initial: 'run', states: { run: 'Run' } });
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  t.after(() => {
    animator.dispose();
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  const tail = [15, 16, 17],
    tip = () => {
      store.tick(false);
      return Array.from(model.nodes[17].matrix.subarray(12, 15));
    };
  // The clip alone, then the same frames with the springs at weight 0, then at weight 1.
  const run = (each) => {
    animator.enterAt(0);
    for (let frame = 0; frame < 60; frame++) {
      model.root.setPosition([0, 0, frame * 0.08]);
      animator.onPreUpdate(1 / 60);
      each(frame);
    }
  };
  const plain = [];
  run(() => plain.push(tip()));
  const options = { chains: [{ joints: tail, stiffness: 2, drag: 0.3 }], weight: 0 },
    handle = addSpringBones(animator, options),
    at = (n) => Array.from(model.nodes[n].matrix.subarray(12, 15)),
    lengths = () => {
      store.tick(false);
      return [distance(at(15), at(16)), distance(at(16), at(17))];
    },
    rest = lengths();
  run((frame) => assert.ok(distance(tip(), plain[frame]) < 1e-5, `weight 0 keeps the clip: frame ${frame}`));
  options.weight = 1;
  handle.reset();
  let furthest = 0;
  run((frame) => {
    lengths().forEach((v, i) => assert.ok(Math.abs(v - rest[i]) < 1e-3 * rest[i], `frame ${frame}: bone ${i}`));
    furthest = Math.max(furthest, distance(tip(), plain[frame]));
  });
  assert.ok(furthest > 0.01, `the tail moved off the clip by ${furthest}`);
  // Off again: the clip has the tail back.
  handle[Symbol.dispose]();
  handle.dispose();
  run((frame) => assert.ok(distance(tip(), plain[frame]) < 1e-5, `disposed: frame ${frame}`));
});
