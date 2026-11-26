// KB-PHYS-FRAMEORDER1: an animation-driven kinematic body must be drawn where the animation put it in the same frame. A
// page that steps its physics before its animation draws every such body one frame behind (at 10 m/s and 60 fps,
// 0.167 m). The shot tool's film hook (shot.page.film) runs before the frame with the frame's exact film time, so the
// page moves its animation first and its physics after, whatever order it added its plugins in. Here a shot step drives
// a page whose film hook sets a kinematic body's target from an animation and advances the physics to the frame; the
// frame then reads the drawn pose, which is the animation's pose at that frame. The old order, physics then animation,
// is the control: it trails by one frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shotStep } from '../tools/shot/render.mjs';
import { Physics } from '../packages/physics/dist/index.js';
import { FilmClock } from '../packages/math/dist/clock.js';

await Physics.load();
const SPEED = 10;
/** The animation: the body slides along x at 10 m/s. */
const animation = (t) => [SPEED * t, 1, 0];

function page(order) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0], interpolate: false }),
    body = physics.addBody(null, {
      type: 'kinematicPosition',
      position: animation(0),
      colliders: { shape: 'sphere', radius: 0.5 },
    }),
    clock = new FilmClock({ fps: 60 }),
    drawn = [];
  const animate = () => body.setNextPosition(animation(clock.time)),
    step = () => physics.advance(clock.frame, clock.fps);
  return {
    drawn,
    film: async ({ frame, offset, fps }) => {
      assert.deepEqual(fps, { num: 60, den: 1 });
      clock.at(frame, offset);
      if (order === 'animation first') {
        animate();
        step();
      } else {
        step();
        animate();
      }
    },
    // The frame's callbacks: the draw reads the body's pose as the mesh shows it.
    frame: () => {
      drawn.push({ time: clock.time, x: body.position[0] });
      return true;
    },
  };
}

async function run(order) {
  const p = page(order);
  globalThis.__margoShot = {
    queued: 1,
    get: (name) => (name === 'page.film' ? p.film : undefined),
    frame: p.frame,
    settle: async () => {},
  };
  try {
    for (let frame = 1; frame <= 30; frame++)
      await shotStep({
        subs: [
          {
            time: { ms: (frame * 1000) / 60, seconds: frame / 60 },
            film: { frame, offset: { num: 0, den: 1 }, fps: { num: 60, den: 1 } },
          },
        ],
        kept: null,
        filmHook: 'page.film',
        warmup: false,
      });
  } finally {
    delete globalThis.__margoShot;
  }
  return p.drawn;
}

test('through the film hook, a kinematic body is drawn where the animation put it in the same frame', async () => {
  const drawn = await run('animation first');
  for (const { time, x } of drawn)
    assert.ok(
      Math.abs(x - animation(time)[0]) < 1e-5,
      `at ${time} s drawn at ${x}, animation at ${animation(time)[0]}`,
    );
});

test('the old order, physics then animation, draws the body one frame behind (the control)', async () => {
  const drawn = await run('physics first');
  const lag = drawn.slice(5).map(({ time, x }) => animation(time)[0] - x);
  for (const l of lag) assert.ok(Math.abs(l - SPEED / 60) < 1e-5, `one frame behind: ${l} m`);
});
