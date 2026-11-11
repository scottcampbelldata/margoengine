import { speedEnabled, deferSpeed } from './support/speed-phase.mjs';
// The Boulder demo in a real browser on the built page (node scripts/build-boulder.mjs first; `--shots=<dir>` saves
// screenshots there). On every tier it checks: no console errors, the opening stance is clear, every move of a route
// reaches its hold with hull gaps kept and knees under the armour limit, the climber faces the way a person does on every
// frame (FACING below), a hold out of reach comes back, a fall lands, the plaque shows the dedication, GPU passes per
// frame, and pagehide disposes. Writes
// test-results/boulder-browser.json with what it measured. Timing numbers are this PC's, and only meaningful when quiet.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preview } from 'vite';
import { launchBrowser } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { percentile } from './lib/percentile.mjs';

const shots = process.argv.find((a) => a.startsWith('--shots='))?.slice(8),
  only = process.argv.find((a) => a.startsWith('--only='))?.slice(7),
  skipRoutes = process.argv.includes('--no-routes'),
  root = resolve('test-results/boulder-site'),
  // Wall gaps may be this far under zero: the hull is a bound on the mesh, and a hand on a hold sits against the wall.
  GAP_FLOOR = -0.005,
  // The armour touches past about 110 degrees.
  KNEE_LIMIT = 110,
  // The chain must put an end joint within this of the target the solver cleared, metres.
  END_ERROR = 0.005,
  // A settled limb stays within this of where it is planted: the stance tolerance plus the chain's.
  CONTACT_ERROR = 0.03,
  // The way a person faces a wall, checked on every frame of every route and tier as [lowest, highest] of each measure in
  // climber.facing(). A clearance gate cannot see any of this: a knee bent backward and a palm to the room both clear. The
  // numbers hold for any model with these bones, since the measures are in the character's own axes.
  FACING = {
    // Pelvis and chest toward the wall, degrees, with little twist between them.
    hipsToWall: [0, 40],
    chestToWall: [0, 35],
    twist: [0, 8],
    // Each knee a true hinge: 1 is the shin folding about the axis the thigh gives it. A knee bends forward (azimuth 0 is
    // straight at the wall, 90 straight out to the side); past that it starts to bend back toward the room.
    kneeHinge: [0.98, 1],
    shinTwist: [0.98, 1],
    kneeAzimuth: [-45, 110],
    // Toes to the wall, turned out as a climber's are, the tip on its hold and out of the wall.
    toeToWall: [0, 60],
    toeTurnOut: [0, 45],
    toeToHold: [0, 0.1],
    footGap: [GAP_FLOOR, Infinity],
    // Hands: palm on the hold, fingers up and over it, thumb on the inner side, and the hand clear of the wall.
    leftPalmToHold: [0.8, 1],
    rightPalmToHold: [0.8, 1],
    leftPalmToWall: [0.85, 1],
    rightPalmToWall: [0.85, 1],
    leftThumbInner: [0.95, 1],
    rightThumbInner: [0.95, 1],
    leftFingersUp: [0.85, 1],
    rightFingersUp: [0.85, 1],
    handGap: [GAP_FLOOR, Infinity],
  },
  FACING_SLACK = 1e-3;

/** Every way the ranges one route measured leave FACING: empty when the climber faces the way a person does. */
function facingFaults(facing) {
  const faults = [];
  for (const [key, [low, high]] of Object.entries(FACING)) {
    const range = facing[key];
    if (!range) faults.push(`${key}: never measured`);
    else if (range[0] < low - FACING_SLACK || range[1] > high + FACING_SLACK)
      faults.push(`${key}: ${range[0].toFixed(3)} to ${range[1].toFixed(3)}, allowed ${low} to ${high}`);
  }
  return faults;
}

const CASES = {
  high: { viewport: { width: 1440, height: 900 }, query: '?quality=high' },
  light: { viewport: { width: 1440, height: 900 }, query: '?quality=low' },
  phone: {
    viewport: { width: 390, height: 844 },
    query: '',
    mobile: true,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  },
};

const server = await preview({
  root,
  configFile: false,
  logLevel: 'error',
  build: { outDir: root },
  preview: { host: '127.0.0.1', port: 5211, strictPort: true },
});
const results = {};
let browser;
try {
  browser = await launchBrowser({ headless: true });
  if (shots) await mkdir(shots, { recursive: true });
  for (const [name, config] of Object.entries(CASES)) {
    if (only && !only.split(',').includes(name)) continue;
    const context = await browser.newContext({
      viewport: config.viewport,
      deviceScaleFactor: config.deviceScaleFactor ?? 1,
      isMobile: !!config.mobile,
      hasTouch: !!config.mobile,
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    });
    const page = await context.newPage(),
      problems = [];
    page.on('console', (m) => {
      // Chrome on Windows says this when the emulated phone's user agent makes core ask for a power preference.
      if (name === 'phone' && m.text().includes('powerPreference option is currently ignored')) return;
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.stack ?? e.message}`));
    // Counts GPU passes per submitted frame.
    await page.addInitScript(() => {
      const count = { passes: 0, gpuMs: [] };
      globalThis.__passes = count;
      if (!globalThis.GPUCommandEncoder) return;
      // Submit to finished, per submit that draws: a rough GPU cost that needs no timestamp feature.
      const submit = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function (buffers) {
        const start = performance.now(),
          out = submit.call(this, buffers);
        if (count.timing) this.onSubmittedWorkDone().then(() => count.gpuMs.push(performance.now() - start));
        return out;
      };
      for (const key of ['beginRenderPass', 'beginComputePass']) {
        const original = GPUCommandEncoder.prototype[key];
        GPUCommandEncoder.prototype[key] = function (...args) {
          count.passes++;
          return original.apply(this, args);
        };
      }
    });
    await page.goto(`http://127.0.0.1:5211/${config.query}`);
    await page
      .waitForFunction(() => globalThis.boulder?.readiness, null, { timeout: 90_000 })
      .catch(async (e) => {
        throw new Error(`${name}: page never became ready: ${e.message}\n${problems.join('\n')}`);
      });
    const result = (results[name] = { tier: await page.evaluate(() => globalThis.boulder.tier) });
    assert.equal(result.tier, name, `${name}: wrong tier`);
    // Let the pose settle, then check the opening stance.
    // fixed-wait: the pose damps over simulated time
    await page.waitForTimeout(800);
    result.opening = await page.evaluate(() => globalThis.boulder.climber.measure());
    result.hullPoints = await page.evaluate(() => globalThis.boulder.climber.hullPointCounts);
    if (shots) {
      await page.screenshot({ path: resolve(shots, `boulder-${name}-opening.png`) });
      if (process.argv.includes('--closeups')) {
        // The nearest the orbit allows, at each side of the climber, for judging the mesh at the demo's real camera.
        for (const [view, offset] of Object.entries({
          left: [-0.9, 0.2, 0.9],
          right: [0.9, 0.1, 0.9],
          back: [0, 0.3, 1.2],
        })) {
          await page.evaluate(
            ({ offset }) => {
              const { engine, climb } = globalThis.boulder,
                t = [climb.pelvis[0], climb.pelvis[1] + 0.45, climb.pelvis[2]];
              engine.camera.position = [t[0] + offset[0], t[1] + offset[1], t[2] + offset[2]];
              engine.camera.target = t;
            },
            { offset },
          );
          // fixed-wait: the moved camera has drawn a few frames
          await page.waitForTimeout(250);
          await page.screenshot({ path: resolve(shots, `boulder-${name}-close-${view}.png`) });
        }
        await page.evaluate(() => {
          const { engine, views } = globalThis.boulder;
          engine.camera.position = [...views.home.position];
          engine.camera.target = [...views.home.target];
        });
      }
    }

    result.passesPerFrame = await page.evaluate(async () => {
      const wait = () => new Promise((r) => requestAnimationFrame(r));
      await wait();
      const before = globalThis.__passes.passes;
      for (let i = 0; i < 30; i++) await wait();
      return (globalThis.__passes.passes - before) / 30;
    });
    if (name === 'phone')
      assert.ok(result.passesPerFrame <= 10, `phone: ${result.passesPerFrame} GPU passes a frame, the budget is 10`);
    result.hullLoadMs = await page.evaluate(() => globalThis.boulder.climber.hullLoadMs);
    // Timing, this PC only, and only meaningful when it is quiet.
    if (speedEnabled()) {
      const gpuMs = await page.evaluate(async () => {
        globalThis.__passes.timing = true;
        // fixed-wait: the length of the timing window
        await new Promise((r) => setTimeout(r, 2000));
        globalThis.__passes.timing = false;
        return [...globalThis.__passes.gpuMs];
      });
      // Nearest rank (scripts/lib/percentile.mjs): an empty window or a non-finite sample throws.
      result.gpuSubmitMs = {
        samples: gpuMs.length,
        median: percentile(gpuMs, 50, { label: `${name} GPU submit` }),
        p95: percentile(gpuMs, 95, { label: `${name} GPU submit` }),
      };
      result.solve = await page.evaluate(async () => {
        globalThis.boulder.climber.resetTimes();
        // fixed-wait: the length of the timing window
        const wait = () => new Promise((r) => setTimeout(r, 1500));
        await wait();
        return { averageMs: globalThis.boulder.climber.solveMs, largestMs: globalThis.boulder.climber.solveMaxMs };
      });
    } else deferSpeed('result.gpuSubmitMs speed diagnostics');

    // A hold far above: the reach comes up short and the stance stays.
    const short = await page.evaluate(async () => {
      const { holds, climb } = globalThis.boulder,
        before = climb.on.join(),
        far = holds.reduce((best, h, i) => (h.position[1] < holds[best].position[1] ? i : best), 0);
      globalThis.boulder.setMoment('reach');
      globalThis.boulder.sendTo(far);
      const start = performance.now();
      // fixed-wait: the poll interval while the move plays
      while (climb.moving >= 0 && performance.now() - start < 8000) await new Promise((r) => setTimeout(r, 50));
      return { changed: climb.on.join() !== before, status: document.getElementById('status').textContent };
    });
    assert.ok(!short.changed, `${name}: an out of reach hold changed the stance: ${JSON.stringify(short)}`);
    assert.match(short.status, /Too far/);

    // The plaque shows the dedication.
    const egg = await page.evaluate(() => {
      const engine = globalThis.boulder.engine,
        canvas = engine.canvas ?? document.querySelector('canvas'),
        before = [...engine.camera.position],
        beforeTarget = [...engine.camera.target];
      engine.camera.position = [2.28, 0.36, 1.2];
      engine.camera.target = [2.28, 0.36, 0];
      const rect = canvas.getBoundingClientRect();
      globalThis.boulder.choose(rect.left + rect.width / 2, rect.top + rect.height / 2, false);
      engine.camera.position = before;
      engine.camera.target = beforeTarget;
      return { text: document.getElementById('status').textContent, expected: globalThis.boulder.egg };
    });
    assert.equal(egg.text, 'Margo engine ❤️ made for Margie');
    assert.equal(egg.text, egg.expected);

    if (!skipRoutes) {
      // Every route on every tier: how a part faces does not depend on the tier, and this proves it.
      for (const routeName of ['green', 'red', 'blue']) {
        const route = await page.evaluate(async (routeName) => {
          const { climb, climber } = globalThis.boulder,
            out = {
              steps: 0,
              worst: { wall: Infinity, body: Infinity, knee: 0, end: 0 },
              held: 0,
              status: '',
              facing: {},
            },
            // Smallest and largest of each measure over the route, by name.
            track = (store, key, value) => {
              const range = (store[key] ??= [Infinity, -Infinity]);
              if (value < range[0]) range[0] = value;
              if (value > range[1]) range[1] = value;
            },
            trackFacing = (store, f) => {
              track(store, 'hipsToWall', f.hipsToWall);
              track(store, 'chestToWall', f.chestToWall);
              track(store, 'twist', f.twist);
              for (const k of f.knees) {
                track(store, 'kneeHinge', k.hinge);
                track(store, 'shinTwist', k.shinTwist);
                if (k.azimuth !== null) track(store, 'kneeAzimuth', k.azimuth);
              }
              for (const foot of f.feet) {
                track(store, 'toeToWall', foot.toWall);
                track(store, 'toeTurnOut', foot.turnOut);
                track(store, 'sole', foot.sole);
                if (foot.toeToHold > 0) track(store, 'toeToHold', foot.toeToHold);
                track(store, 'ankleTwist', foot.ankleTwist);
              }
              f.hands.forEach((hand, i) => {
                const side = i === 0 ? 'left' : 'right';
                track(store, `${side}Wrist`, hand.wrist);
                if (!hand.holding) return;
                track(store, `${side}PalmToHold`, hand.palmToHold);
                track(store, `${side}PalmToWall`, hand.palmToWall);
                track(store, `${side}ThumbInner`, hand.thumbInner);
                track(store, `${side}FingersUp`, hand.fingersUp);
              });
              for (const v of f.footGap) track(store, 'footGap', v);
              for (const v of f.handGap) track(store, 'handGap', v);
            };
          globalThis.boulder.startRoute(routeName);
          climber.resetTimes();
          const start = performance.now();
          while (performance.now() - start < 120_000) {
            await new Promise((r) => requestAnimationFrame(r));
            if (climb.falling) continue;
            const m = climber.measure();
            for (const v of m.wallGap) out.worst.wall = Math.min(out.worst.wall, v);
            for (const v of m.bodyGap) out.worst.body = Math.min(out.worst.body, v);
            for (const v of m.kneeDegrees.slice(2)) out.worst.knee = Math.max(out.worst.knee, v);
            for (const v of m.error) out.worst.end = Math.max(out.worst.end, v);
            trackFacing(out.facing, climber.facing());
            out.steps++;
            if (
              !globalThis.boulder.playing &&
              new RegExp(`Top of the ${routeName}`).test(document.getElementById('status').textContent)
            )
              break;
          }
          // fixed-wait: the climber settles on the last hold over simulated time
          await new Promise((r) => setTimeout(r, 1200));
          out.contact = climber.measure().contact;
          out.held = climber.heldFrames;
          out.solveMs = climber.solveMs;
          out.solveMaxMs = climber.solveMaxMs;
          out.status = document.getElementById('status').textContent;
          out.on = [...climb.on];
          const route = globalThis.boulder.routes.find((r) => r.name === routeName),
            wanted = [route.start[0], route.start[1], -1, -1];
          for (const move of route.moves) wanted[move.limb] = move.hold;
          out.wanted = wanted;
          return out;
        }, routeName);
        (result.routes ??= {})[routeName] = route;
        const said = JSON.stringify({ routeName, ...route });
        assert.match(
          route.status,
          new RegExp(`Top of the ${routeName} route`),
          `${name}: the route did not finish: ${said}`,
        );
        assert.deepEqual(route.on, route.wanted, `${name}: a move came up short: ${said}`);
        assert.ok(route.worst.wall >= GAP_FLOOR, `${name}: a limb entered the wall: ${said}`);
        assert.ok(route.worst.body >= GAP_FLOOR, `${name}: an arm entered the torso or head: ${said}`);
        assert.ok(route.worst.knee < KNEE_LIMIT, `${name}: knee past the armour: ${said}`);
        for (const c of route.contact)
          assert.ok(c < CONTACT_ERROR, `${name}: a limb is off its hold after the route: ${said}`);
        assert.ok(route.worst.end < END_ERROR, `${name}: end joint off target: ${said}`);
        assert.deepEqual(facingFaults(route.facing), [], `${name}, ${routeName}: faces the wrong way`);
      }
      if (shots) await page.screenshot({ path: resolve(shots, `boulder-${name}-top.png`) });

      // Fall: back on the mat.
      const fell = await page.evaluate(async () => {
        document.getElementById('fall').click();
        const start = performance.now();
        // fixed-wait: the fall begins on the next frame
        await new Promise((r) => setTimeout(r, 100));
        while (globalThis.boulder.climb.falling && performance.now() - start < 5000)
          // fixed-wait: the poll interval while the fall plays
          await new Promise((r) => setTimeout(r, 50));
        // fixed-wait: the pelvis damps down after the landing
        await new Promise((r) => setTimeout(r, 700));
        return { y: globalThis.boulder.climb.pelvis[1], status: document.getElementById('status').textContent };
      });
      assert.ok(fell.y < 1.1, `${name}: the fall did not reach the mat: ${JSON.stringify(fell)}`);
      result.fall = fell;
      if (shots) await page.screenshot({ path: resolve(shots, `boulder-${name}-fall.png`) });
    }
    assert.deepEqual(problems, [], `${name}: console problems`);
    result.problems = problems.length;
    // Pagehide disposes without an error.
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
    // fixed-wait: room for an error from the disposal to surface
    await page.waitForTimeout(200);
    assert.deepEqual(problems, [], `${name}: errors on dispose`);
    await context.close();
    console.log(name, JSON.stringify(result));
  }
  if (!only) {
    // Reduced motion: moves are instant, and they have to reach the screen.
    const context = await browser.newContext({ viewport: CASES.light.viewport, reducedMotion: 'reduce' }),
      page = await context.newPage(),
      problems = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.stack ?? e.message}`));
    await page.addInitScript(() => {
      const count = { submits: 0 };
      globalThis.__stillDraws = count;
      const submit = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function (buffers) {
        count.submits++;
        return submit.call(this, buffers);
      };
    });
    await page.goto(`http://127.0.0.1:5211/${CASES.light.query}`);
    await page.waitForFunction(() => !!globalThis.boulder?.readiness, null, { timeout: 60_000 });
    await page.evaluate(() => globalThis.boulder.readiness);
    const opening = await page.screenshot(),
      before = await page.evaluate(() => {
        const hold = globalThis.boulder.routes.find((r) => r.name === 'blue').moves[0].hold,
          on = globalThis.boulder.climb.on.join(),
          submits = globalThis.__stillDraws.submits;
        globalThis.boulder.sendTo(hold);
        return { on, submits };
      });
    await page.waitForFunction((seen) => globalThis.__stillDraws.submits > seen, before.submits, { timeout: 10_000 });
    assert.notEqual(
      await page.evaluate(() => globalThis.boulder.climb.on.join()),
      before.on,
      'still: the move did not apply',
    );
    assert.ok(!opening.equals(await page.screenshot()), 'still: the move did not reach the screen');
    assert.deepEqual(problems, [], 'still: console problems');
    await context.close();
    results.still = { problems: 0 };
    console.log('still ok');
  }
} finally {
  await writeFile('test-results/boulder-browser.json', JSON.stringify(results, null, 2) + '\n');
  await closeAll([browser, server]);
}
console.log('boulder browser test passed');
process.exit(0);
