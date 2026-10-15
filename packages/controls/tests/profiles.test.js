// CAD navigation profiles (HANDOFF 5h.b): the default replays a recording made before profiles existed, each profile maps
// its gestures to the right camera motion, and browser gesture conflicts are handled.
// Re-record the replay (only when an orbit behaviour change is intended): RECORD=1 node --test tests/profiles.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Camera } from '@margoengine/core';
import { CameraProjection } from '../../cameras/dist/index.js';
import * as controls from '../dist/index.js';

const { OrbitControls } = controls;
const FIXTURE = new URL('./orbit-replay.json', import.meta.url);

class FakeElement {
  listeners = new Map();
  clientWidth = 800;
  clientHeight = 600;
  style = { touchAction: 'auto' };
  captured = new Set();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type, props = {}) {
    const event = {
      type,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...props,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
  get count() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
}
const camera = () => new Camera({ position: [3, 4, 9], target: [0, 1, 0] });
const mouse = (button, mods = {}) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

// ---------- recorded sequence (default behaviour) ----------
// Events as a browser sends them for a mouse (pointerdown then the compatibility mousedown), touch, wheel and keys.
function sequence() {
  const events = [];
  let t = 1000;
  const drag = (button, mods, from, to) => {
    const base = { ...mouse(button, mods) };
    events.push(
      ['pointerdown', { ...base, clientX: from[0], clientY: from[1], timeStamp: (t += 50) }],
      ['mousedown', { ...base, clientX: from[0], clientY: from[1] }],
    );
    if (button === 2) events.push(['contextmenu', {}]);
    for (let i = 1; i <= 3; i++)
      events.push([
        'pointermove',
        { ...base, clientX: from[0] + ((to[0] - from[0]) * i) / 3, clientY: from[1] + ((to[1] - from[1]) * i) / 3 },
      ]);
    events.push(['pointerup', { ...base, clientX: to[0], clientY: to[1] }]);
  };
  drag(0, {}, [400, 300], [460, 330]);
  drag(2, {}, [400, 300], [350, 260]);
  drag(0, { shiftKey: true }, [400, 300], [420, 350]);
  drag(0, { ctrlKey: true }, [300, 200], [330, 210]);
  drag(0, { metaKey: true }, [300, 200], [280, 230]);
  drag(2, { ctrlKey: true }, [400, 300], [380, 280]);
  drag(1, {}, [400, 300], [400, 340]);
  drag(1, {}, [400, 300], [400, 280]);
  drag(0, { altKey: true }, [400, 300], [440, 300]);
  drag(1, { shiftKey: true }, [400, 300], [430, 320]);
  drag(1, { ctrlKey: true }, [400, 300], [400, 330]);
  drag(2, { shiftKey: true }, [400, 300], [420, 310]);
  drag(1, {}, [500, 250], [500, 250]);
  drag(1, {}, [501, 251], [501, 251]); // a quick double middle click
  for (const [deltaY, deltaMode, mods] of [
    [-100, 0, {}],
    [120, 0, {}],
    [3, 1, {}],
    [-1, 2, {}],
    [-2, 0, { ctrlKey: true }],
    [5, 0, { ctrlKey: true }],
    [-100, 0, { shiftKey: true }],
    [-100, 0, { altKey: true }],
  ])
    events.push(['wheel', { deltaY, deltaMode, clientX: 610, clientY: 180, ...mods }]);
  const touch = (type, id, x, y) =>
    events.push([type, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y }]);
  touch('pointerdown', 7, 400, 300);
  touch('pointermove', 7, 430, 320);
  touch('pointermove', 7, 450, 310);
  touch('pointerdown', 8, 500, 300);
  touch('pointermove', 8, 560, 330);
  touch('pointermove', 7, 430, 280);
  touch('pointerup', 8, 560, 330);
  touch('pointermove', 7, 420, 290);
  touch('pointerup', 7, 420, 290);
  for (const [code, mods] of [
    ['ArrowLeft', {}],
    ['ArrowUp', {}],
    ['ArrowRight', { shiftKey: true }],
    ['ArrowDown', { ctrlKey: true }],
    ['KeyF', {}],
    ['Numpad1', {}],
    ['Digit1', { ctrlKey: true }],
    ['Home', {}],
  ])
    events.push([
      'keydown',
      { code, key: code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods },
    ]);
  events.push(['keyup', { key: 'Alt', code: 'AltLeft' }]);
  return events;
}
const VARIANTS = { plain: {}, damping: { enableDamping: true }, cursor: { zoomToCursor: true } };
function replay(events, setup, variant) {
  const el = new FakeElement(),
    cam = camera(),
    orbit = new OrbitControls(cam, el);
  setup?.(orbit);
  Object.assign(orbit, VARIANTS[variant]);
  orbit.listenToKeyEvents(el); // options after the profile, as an app would
  const fired = [];
  for (const type of ['start', 'change', 'end', 'fit']) orbit.addEventListener(type, () => fired.push(type));
  const states = events.map(([type, props]) => {
    fired.length = 0;
    const event = el.dispatch(type, props);
    if (variant === 'damping') orbit.update(1 / 60);
    return [...cam.position, ...cam.target, event.defaultPrevented ? 1 : 0, orbit.state, fired.join()];
  });
  orbit.dispose();
  assert.equal(el.count, 0, 'every listener removed');
  return states;
}

test('default unchanged: the recorded pointer/wheel/touch/key sequence replays to the exact camera states', () => {
  if (process.env.RECORD) {
    const events = sequence(),
      runs = Object.fromEntries(Object.keys(VARIANTS).map((variant) => [variant, replay(events, null, variant)]));
    writeFileSync(
      FIXTURE,
      JSON.stringify({ note: 'Recorded from OrbitControls before navigation profiles (659038f).', events, runs }) +
        '\n',
    );
  }
  const { events, runs } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(events, JSON.parse(JSON.stringify(sequence())), 'the fixture is this sequence');
  // Exact equality: JSON round-trips doubles, so any change in the arithmetic fails.
  const setups = {
    'no profile': null,
    'setProfile(THREE_ORBIT)': (o) => o.setProfile(controls.THREE_ORBIT),
    'BLENDER then THREE_ORBIT': (o) => o.setProfile(controls.BLENDER).setProfile(controls.THREE_ORBIT),
  };
  for (const [label, setup] of Object.entries(setups))
    for (const variant of Object.keys(VARIANTS))
      assert.deepEqual(replay(events, setup, variant), runs[variant], `${label}, ${variant}`);
});

// ---------- per profile ----------
/** Classifies what one gesture did to the camera. */
function motion(cam, run) {
  const p0 = [...cam.position],
    t0 = [...cam.target];
  run();
  const dp = cam.position.map((v, i) => v - p0[i]),
    dt = cam.target.map((v, i) => v - t0[i]);
  const moved = Math.hypot(...dp) > 1e-9,
    targetMoved = Math.hypot(...dt) > 1e-9;
  const r0 = Math.hypot(...p0.map((v, i) => v - t0[i])),
    r1 = Math.hypot(...cam.position.map((v, i) => v - cam.target[i]));
  if (!moved && !targetMoved) return 'none';
  if (targetMoved && Math.hypot(...dp.map((v, i) => v - dt[i])) < 1e-9) return 'pan';
  if (Math.abs(r1 - r0) > 1e-9) return r1 < r0 ? 'in' : 'out';
  return 'rotate';
}
function rig(profile, options = {}) {
  const el = new FakeElement(),
    cam = options.camera ?? camera(),
    orbit = new OrbitControls(cam, el);
  if (profile) orbit.setProfile(profile);
  orbit.listenToKeyEvents(el);
  const drag = (button, mods = {}, to = [440, 260]) =>
    motion(cam, () => {
      el.dispatch('pointerdown', { ...mouse(button, mods), clientX: 400, clientY: 300, timeStamp: 0 });
      el.dispatch('pointermove', { ...mouse(button, mods), clientX: to[0], clientY: to[1] });
      el.dispatch('pointerup', { ...mouse(button, mods), clientX: to[0], clientY: to[1] });
    });
  const wheel = (deltaY, mods = {}, at = [400, 300]) =>
    motion(cam, () => el.dispatch('wheel', { deltaY, deltaMode: 0, clientX: at[0], clientY: at[1], ...mods }));
  const touch = (type, id, x, y) =>
    el.dispatch(type, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y });
  const oneFinger = () =>
    motion(cam, () => {
      touch('pointerdown', 5, 400, 300);
      touch('pointermove', 5, 440, 330);
      touch('pointerup', 5, 440, 330);
    });
  const pinch = () =>
    motion(cam, () => {
      touch('pointerdown', 5, 300, 300);
      touch('pointerdown', 6, 500, 300);
      touch('pointermove', 6, 600, 300);
      touch('pointerup', 6, 600, 300);
      touch('pointerup', 5, 300, 300);
    });
  const key = (code, mods = {}) =>
    el.dispatch('keydown', {
      code,
      key: code,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ...mods,
    });
  return { el, cam, orbit, drag, wheel, oneFinger, pinch, key };
}
const L = 0,
  M = 1,
  R = 2;
// [profile, [button, modifiers, expected motion][], wheel forward, zoom to cursor, one finger]. 'in' is a dolly (drag up).
const TABLE = [
  [
    'THREE_ORBIT',
    [
      [L, {}, 'rotate'],
      [M, {}, 'in'],
      [R, {}, 'pan'],
      [L, { shiftKey: true }, 'pan'],
      [L, { ctrlKey: true }, 'pan'],
      [R, { shiftKey: true }, 'rotate'],
    ],
    'in',
    false,
    'rotate',
  ],
  [
    'SOLIDWORKS',
    [
      [M, {}, 'rotate'],
      [M, { ctrlKey: true }, 'pan'],
      [M, { metaKey: true }, 'pan'],
      [M, { shiftKey: true }, 'in'],
      [L, {}, 'none'],
      [R, {}, 'none'],
      [M, { altKey: true }, 'none'],
    ],
    'out',
    true,
    'rotate',
  ],
  [
    'AUTOCAD',
    [
      [M, {}, 'pan'],
      [M, { shiftKey: true }, 'rotate'],
      [L, {}, 'none'],
      [R, {}, 'none'],
    ],
    'in',
    true,
    'pan',
  ],
  [
    'INVENTOR',
    [
      [M, {}, 'pan'],
      [M, { shiftKey: true }, 'rotate'],
      [L, {}, 'none'],
      [R, {}, 'none'],
    ],
    'in',
    true,
    'rotate',
  ],
  [
    'FUSION',
    [
      [M, {}, 'pan'],
      [M, { shiftKey: true }, 'rotate'],
      [L, {}, 'none'],
    ],
    'in',
    true,
    'rotate',
  ],
  [
    'BLENDER',
    [
      [M, {}, 'rotate'],
      [M, { shiftKey: true }, 'pan'],
      [M, { ctrlKey: true }, 'in'],
      [L, {}, 'none'],
      [R, {}, 'none'],
      [L, { altKey: true }, 'none'],
    ],
    'in',
    false,
    'rotate',
  ],
  [
    'MAYA',
    [
      [L, { altKey: true }, 'rotate'],
      [M, { altKey: true }, 'pan'],
      [R, { altKey: true }, 'in'],
      [L, {}, 'none'],
      [M, {}, 'none'],
      [R, {}, 'none'],
    ],
    'in',
    false,
    'rotate',
  ],
  [
    'ONSHAPE',
    [
      [R, {}, 'rotate'],
      [M, {}, 'pan'],
      [R, { ctrlKey: true }, 'pan'],
      [L, {}, 'none'],
    ],
    'out',
    true,
    'rotate',
  ],
  [
    'RHINO',
    [
      [R, {}, 'rotate'],
      [R, { shiftKey: true }, 'pan'],
      [R, { ctrlKey: true }, 'in'],
      [R, { ctrlKey: true, shiftKey: true }, 'rotate'],
      [L, {}, 'none'],
      [M, {}, 'none'],
    ],
    'in',
    true,
    'rotate',
  ],
];
for (const [name, drags, forward, cursor, finger] of TABLE)
  test(`profile ${name}: mouse drags, wheel direction, zoom to cursor, touch`, () => {
    const profile = controls[name];
    assert.equal(controls.PROFILES[profile.name], profile, 'listed in PROFILES');
    for (const [button, mods, expected] of drags) {
      const r = rig(profile);
      assert.equal(r.drag(button, mods), expected, `${name} button ${button} ${JSON.stringify(mods)}`);
      r.orbit.dispose();
    }
    const r = rig(profile);
    assert.equal(r.wheel(-100), forward, 'wheel forward');
    assert.equal(r.wheel(100), forward === 'in' ? 'out' : 'in', 'wheel back');
    // Off-centre wheel: zoom to cursor moves the target toward the cursor, centre zoom keeps it.
    const target = [...r.cam.target];
    r.wheel(-100, {}, [700, 100]);
    assert.equal(Math.hypot(...r.cam.target.map((v, i) => v - target[i])) > 1e-6, cursor, 'zoom to cursor');
    assert.equal(r.oneFinger(), finger, 'one finger');
    assert.equal(r.pinch(), 'in', 'two fingers spreading zoom in');
    r.orbit.dispose();
  });

test('profiles: double click of the fit button and fit keys dispatch fit; others do not', () => {
  const cases = [
    ['SOLIDWORKS', 1, ['KeyF']],
    ['AUTOCAD', 1, []],
    ['INVENTOR', 1, []],
    ['BLENDER', null, ['Home', 'NumpadDecimal']],
    ['MAYA', null, ['KeyF', 'KeyA']],
    ['ONSHAPE', null, ['KeyF']],
    ['RHINO', null, []],
    ['THREE_ORBIT', null, []],
  ];
  for (const [name, button, keys] of cases) {
    const { el, orbit, key } = rig(controls[name]);
    let fits = 0;
    orbit.addEventListener('fit', () => fits++);
    const click = (b, t, x = 500) => {
      el.dispatch('pointerdown', { ...mouse(b), clientX: x, clientY: 200, timeStamp: t });
      el.dispatch('pointerup', { ...mouse(b), clientX: x, clientY: 200 });
    };
    for (const b of [0, 1, 2]) {
      click(b, 1000);
      click(b, 1250);
      assert.equal(fits, b === button ? 1 : 0, `${name} double click ${b}`);
      fits = 0;
      click(b, 5000);
      click(b, 5450);
      click(b, 9000);
      click(b, 9100, 520);
      assert.equal(fits, 0, `${name} slow or moved clicks ${b}`);
    }
    for (const code of keys) {
      const event = key(code);
      assert.equal(fits, 1, `${name} ${code}`);
      assert.ok(event.defaultPrevented);
      fits = 0;
    }
    for (const code of ['KeyF', 'Home', 'KeyA', 'NumpadDecimal'])
      if (!keys.includes(code)) {
        assert.equal(key(code).defaultPrevented, false, `${name} ${code} unbound`);
        assert.equal(fits, 0);
      }
    orbit.dispose();
  }
});

test('profiles: view keys snap to the named views (eased with damping), and keep the distance and target', () => {
  const views = {
    front: [0, 0, 1],
    back: [0, 0, -1],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 1, 0],
    bottom: [0, -1, 0],
    iso: [1, 1, 1],
  };
  const cases = [
    [
      'BLENDER',
      {
        front: ['Numpad1'],
        back: ['Numpad1', { ctrlKey: true }],
        right: ['Numpad3'],
        left: ['Numpad3', { ctrlKey: true }],
        top: ['Numpad7'],
        bottom: ['Numpad7', { ctrlKey: true }],
      },
    ],
    [
      'SOLIDWORKS',
      Object.fromEntries(
        ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].map((v, i) => [
          v,
          [`Digit${i + 1}`, { ctrlKey: true }],
        ]),
      ),
    ],
    [
      'ONSHAPE',
      Object.fromEntries(
        ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].map((v, i) => [
          v,
          [`Digit${i + 1}`, { shiftKey: true }],
        ]),
      ),
    ],
  ];
  for (const [name, keys] of cases)
    for (const [view, [code, mods]] of Object.entries(keys)) {
      const { cam, orbit, key } = rig(controls[name]),
        r0 = Math.hypot(...cam.position.map((v, i) => v - cam.target[i])),
        target = [...cam.target];
      assert.ok(key(code, mods).defaultPrevented);
      const d = cam.position.map((v, i) => v - cam.target[i]),
        r = Math.hypot(...d),
        want = views[view],
        wl = Math.hypot(...want);
      assert.ok(
        d.every((v, i) => Math.abs(v / r - want[i] / wl) < 1e-5),
        `${name} ${view}: ${d.map((v) => v / r)}`,
      );
      assert.ok(Math.abs(r - r0) < 1e-9);
      assert.deepEqual([...cam.target], target);
      assert.doesNotThrow(() => cam.update(4 / 3, true), 'renderable (poles stay EPS away)');
      orbit.dispose();
    }
  // Damping eases into the view instead of jumping.
  const { cam, orbit, key } = rig(controls.BLENDER);
  orbit.enableDamping = true;
  key('Numpad3');
  const half = cam.position.map((v, i) => v - cam.target[i]);
  assert.ok(Math.abs(half[0] / Math.hypot(...half) - 1) > 1e-3, 'not there yet');
  for (let i = 0; i < 600; i++) orbit.update(1 / 60);
  const d = cam.position.map((v, i) => v - cam.target[i]);
  assert.ok(Math.abs(d[0] / Math.hypot(...d) - 1) < 1e-6, 'settles on the right view');
  orbit.dispose();
});

test('profiles: Blender numpad 5 toggles the engine projection (@margoengine/cameras)', () => {
  const canvas = new FakeElement(),
    plugins = new Map();
  const engine = {
    canvas,
    camera: camera(),
    disposed: false,
    plugins,
    use(plugin) {
      plugins.set(plugin.name, plugin);
      plugin.setup(engine);
    },
    hasPlugin: (n) => plugins.has(n),
    removePlugin(n) {
      plugins.get(n)?.dispose?.();
      plugins.delete(n);
    },
  };
  const projection = CameraProjection.attach(engine),
    orbit = OrbitControls.attach(engine).setProfile(controls.BLENDER);
  orbit.listenToKeyEvents(canvas);
  canvas.dispatch('keydown', { code: 'Numpad5' });
  assert.equal(projection.mode, 'perspective');
  canvas.dispatch('keydown', { code: 'Numpad5' });
  assert.equal(projection.mode, 'orthographic');
  orbit.dispose();
  // Without a projection the key is still consumed and nothing breaks.
  const bare = rig(controls.BLENDER);
  assert.ok(bare.key('Numpad5').defaultPrevented);
  bare.orbit.dispose();
});

// ---------- orthographic cameras ----------
test('profiles under an orthographic camera: the wheel is ortho zoom about the cursor; Rhino right drag pans', () => {
  for (const name of ['SOLIDWORKS', 'AUTOCAD', 'INVENTOR', 'ONSHAPE', 'RHINO']) {
    const cam = camera(),
      projection = new CameraProjection();
    projection.attach(cam);
    cam.update(4 / 3, true);
    const { el, orbit, wheel, drag } = rig(controls[name], { camera: cam });
    const halfHeight = () => {
      cam.update(4 / 3, true);
      return 1 / Math.hypot(cam.matrix[1], cam.matrix[5], cam.matrix[9]);
    };
    // World point under the cursor on the target plane, from the orthographic matrix (column-major, WebGPU depth).
    const toPixel = (point) => {
      cam.update(4 / 3, true);
      const m = cam.matrix,
        c = [0, 1].map((r) => m[r] * point[0] + m[4 + r] * point[1] + m[8 + r] * point[2] + m[12 + r]);
      return [((c[0] + 1) / 2) * 800, ((1 - c[1]) / 2) * 600];
    };
    const cursor = [610, 180],
      h0 = halfHeight();
    const f = cam.target.map((v, i) => v - cam.position[i]),
      fl = Math.hypot(...f),
      fw = f.map((v) => v / fl);
    const right = [-fw[2], 0, fw[0]].map((v) => v / Math.hypot(fw[0], fw[2])),
      up = [
        right[1] * fw[2] - right[2] * fw[1],
        right[2] * fw[0] - right[0] * fw[2],
        right[0] * fw[1] - right[1] * fw[0],
      ];
    const nx = (cursor[0] / 800) * 2 - 1,
      ny = 1 - (cursor[1] / 600) * 2,
      point = cam.target.map((v, i) => v + (right[i] * nx * h0 * 4) / 3 + up[i] * ny * h0);
    assert.ok(
      toPixel(point).every((v, i) => Math.abs(v - cursor[i]) < 1e-3),
      'setup',
    );
    const forward = controls[name].wheel === 1 ? 'in' : 'out';
    wheel(-100, {}, cursor);
    const h1 = halfHeight();
    assert.ok(
      forward === 'in' ? h1 < h0 * 0.99 : h1 > h0 * 1.01,
      `${name}: ortho height follows the wheel (${h0} -> ${h1})`,
    );
    assert.ok(
      toPixel(point).every((v, i) => Math.abs(v - cursor[i]) < 1e-3),
      `${name}: the point under the cursor stays put`,
    );
    if (name === 'RHINO') {
      assert.equal(drag(R), 'pan', 'parallel view: right drag pans');
      assert.equal(drag(R, { ctrlKey: true, shiftKey: true }), 'rotate', 'Ctrl+Shift+right rotates');
      projection.mode = 'perspective';
      cam.update(4 / 3, true);
      assert.equal(drag(R), 'rotate', 'perspective: right drag rotates');
    }
    orbit.dispose();
    projection.dispose();
    assert.equal(el.count, 0);
  }
});

// ---------- gesture conflicts ----------
test('conflicts: Alt drags eat the Alt keyup (menu bar), plain Alt presses and the default profile do not', () => {
  const doc = new FakeElement(),
    maya = rig(controls.MAYA);
  maya.el.ownerDocument = doc;
  maya.orbit.connect(maya.el); // reconnect so the document is used
  const altUp = () => doc.dispatch('keyup', { key: 'Alt', code: 'AltLeft' });
  assert.equal(altUp().defaultPrevented, false, 'no listener before an Alt drag');
  assert.equal(maya.drag(L, { altKey: true }), 'rotate');
  assert.equal(altUp().defaultPrevented, true, 'Alt release after the drag does not reach the menu bar');
  assert.equal(altUp().defaultPrevented, false, 'only once');
  assert.equal(doc.dispatch('keyup', { key: 'Shift' }).defaultPrevented, false);
  maya.orbit.dispose();
  assert.equal(doc.count + maya.el.count, 0, 'document listener removed');
  // Default: Alt is ignored (three.js), so Alt + left still rotates and nothing listens on the document.
  const def = rig(null),
    doc2 = new FakeElement();
  def.el.ownerDocument = doc2;
  def.orbit.connect(def.el);
  assert.equal(def.drag(L, { altKey: true }), 'rotate');
  assert.equal(doc2.count, 0);
  def.orbit.dispose();
});

test('conflicts: context menu suppressed for right-button profiles, middle press cannot autoscroll, unbound buttons pass through', () => {
  for (const name of ['ONSHAPE', 'RHINO', 'MAYA', 'THREE_ORBIT']) {
    const { el, orbit } = rig(controls[name]),
      mods = name === 'MAYA' ? { altKey: true } : {};
    el.dispatch('pointerdown', { ...mouse(R, mods), clientX: 400, clientY: 300 });
    assert.equal(el.dispatch('contextmenu', {}).defaultPrevented, true, `${name}: no browser menu over a right drag`);
    assert.notEqual(orbit.state, 'none');
    assert.ok(el.captured.has(1), 'pointer captured');
    el.dispatch('pointerup', { ...mouse(R, mods), clientX: 400, clientY: 300 });
    orbit.enabled = false;
    assert.equal(el.dispatch('contextmenu', {}).defaultPrevented, false, 'disabled controls leave the menu alone');
    orbit.dispose();
  }
  // Middle-button profiles: the compatibility mousedown of a gesture is cancelled (no autoscroll, no paste, no selection).
  for (const name of ['SOLIDWORKS', 'AUTOCAD', 'INVENTOR', 'BLENDER']) {
    const { el, orbit } = rig(controls[name]);
    el.dispatch('pointerdown', { ...mouse(M), clientX: 400, clientY: 300 });
    assert.equal(el.dispatch('mousedown', mouse(M)).defaultPrevented, true, `${name}: middle press`);
    el.dispatch('pointerup', { ...mouse(M), clientX: 400, clientY: 300 });
    // Left is selection in these tools: not captured, not cancelled, so the app's own click handling works.
    el.dispatch('pointerdown', { ...mouse(L), clientX: 400, clientY: 300 });
    assert.equal(orbit.state, 'none');
    assert.equal(el.captured.size, 0);
    assert.equal(el.dispatch('mousedown', mouse(L)).defaultPrevented, false, `${name}: left press passes through`);
    el.dispatch('pointerup', { ...mouse(L), clientX: 400, clientY: 300 });
    orbit.dispose();
  }
  // Default (three.js): middle dollies and the mousedown is untouched, as before profiles.
  const { el, orbit } = rig(null);
  el.dispatch('pointerdown', { ...mouse(M), clientX: 400, clientY: 300 });
  assert.equal(orbit.state, 'dolly');
  assert.equal(el.dispatch('mousedown', mouse(M)).defaultPrevented, false);
  orbit.dispose();
});

test('conflicts: Ctrl + wheel (trackpad pinch) is never inverted and never zooms the page; browser key shortcuts pass through', () => {
  for (const name of ['SOLIDWORKS', 'ONSHAPE', 'BLENDER']) {
    const { el, cam, orbit, key } = rig(controls[name]);
    assert.equal(
      motion(cam, () =>
        assert.ok(
          el.dispatch('wheel', { deltaY: -5, deltaMode: 0, ctrlKey: true, clientX: 400, clientY: 300 })
            .defaultPrevented,
        ),
      ),
      'in',
      `${name}: pinch out zooms in`,
    );
    for (const [code, mods] of [
      ['KeyT', { ctrlKey: true }],
      ['KeyW', { ctrlKey: true }],
      ['Digit9', { ctrlKey: true }],
      ['KeyF', { shiftKey: true }],
      ['KeyF', { ctrlKey: true }],
      ['Tab', { ctrlKey: true }],
      ['F5', {}],
    ])
      assert.equal(
        key(code, mods).defaultPrevented,
        false,
        `${name}: ${JSON.stringify(mods)} ${code} reaches the browser`,
      );
    orbit.dispose();
  }
});

test('setProfile returns the controls, applies touches and zoomToCursor, and THREE_ORBIT restores mouseButtons', () => {
  const { orbit } = rig(null);
  assert.equal(orbit.profile, null);
  assert.equal(orbit.setProfile(controls.AUTOCAD), orbit);
  assert.equal(orbit.profile, controls.AUTOCAD);
  assert.equal(orbit.zoomToCursor, true);
  assert.deepEqual(orbit.touches, { ONE: controls.TOUCH.PAN, TWO: controls.TOUCH.DOLLY_PAN });
  orbit.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: null };
  orbit.setProfile(controls.THREE_ORBIT);
  assert.deepEqual(orbit.mouseButtons, { LEFT: 0, MIDDLE: 1, RIGHT: 2 });
  assert.equal(orbit.zoomToCursor, false);
  assert.notEqual(
    orbit.touches,
    controls.THREE_ORBIT.touches,
    'copied, so editing the controls never edits the shared profile',
  );
  orbit.dispose();
});
