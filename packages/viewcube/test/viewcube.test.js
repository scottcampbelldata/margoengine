import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Camera } from '../../core/dist/index.js';
import { CADCameraControls } from '../../stage/dist/controls.js';
import { OrbitControls, AUTOCAD, BLENDER, SOLIDWORKS } from '../../controls/dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { compactOutput } from '../../../scripts/measure-size.js';
import { THEMES, ViewCube } from '../dist/index.js';
import { AxisTriad } from '../dist/axes.js';

/** Inline style: plain fields, plus the custom-property methods. */
class FakeStyle {
  setProperty(name, value) {
    this[name] = value;
  }
  removeProperty(name) {
    delete this[name];
  }
}
/** Just enough DOM for the widget: elements, attributes, delegated events and `closest`. */
class FakeElement {
  constructor(document, tag) {
    Object.assign(this, {
      ownerDocument: document,
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: null,
      style: new FakeStyle(),
      dataset: {},
      attributes: {},
      listeners: {},
      className: '',
      textContent: '',
      title: '',
      tabIndex: 0,
    });
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    const p = this.parentElement;
    if (p) {
      p.children.splice(p.children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= new Set()).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type]?.delete(listener);
  }
  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (let node = this; node; node = node.parentElement)
      for (const listener of node.listeners[type] ?? []) listener(event);
    return event;
  }
  closest() {
    let node = this;
    while (node && !['view', 'projection', 'home', 'roll'].some((k) => k in node.dataset)) node = node.parentElement;
    return node;
  }
  all() {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  // Canvas surface for the controls.
  get clientWidth() {
    return 400;
  }
  get clientHeight() {
    return 300;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 400, height: 300 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() {
    return false;
  }
}
function setup(camera = { position: [0, 0, 10], target: [0, 0, 0] }) {
  const document = { createElement: (tag) => new FakeElement(document, tag) },
    container = new FakeElement(document, 'div'),
    canvas = container.appendChild(new FakeElement(document, 'canvas'));
  const plugins = new Map(),
    passes = [];
  const engine = {
    canvas,
    camera: new Camera(camera),
    disposed: false,
    plugins,
    use(plugin) {
      plugin.setup(engine);
      plugin.registerPasses?.({ add: (pass) => passes.push(pass) });
      plugins.set(plugin.name, plugin);
      return engine;
    },
    hasPlugin: (name) => plugins.has(name),
    sceneOf: (plugin) => plugins.get(plugin.name) === plugin ? engine : undefined,
    removePlugin(name) {
      const p = plugins.get(name);
      plugins.delete(name);
      p?.dispose?.();
    },
    /** Core's order: plugins' onPreUpdate, camera advance and update, then the frame graph. */
    frame(delta = 1 / 60) {
      for (const p of plugins.values()) p.onPreUpdate?.(delta);
      engine.camera.advance(delta);
      engine.camera.update(4 / 3, true);
      for (const pass of passes) pass.execute({});
    },
    run(seconds) {
      for (let t = 0; t < seconds; t += 1 / 60) engine.frame();
    },
  };
  return { engine, container, canvas, plugins, passes };
}
const close = (a, b, eps = 1e-4) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const direction = (c) => unit(c.position.map((v, i) => v - c.target[i]));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Screen right and up as core builds them: right = camera.up x back, up = back x right. */
const screen = (c) => {
  const z = direction(c),
    r = unit(cross(c.up, z));
  return { right: r, up: cross(z, r) };
};
const cells = (cube) => cube.element.all().filter((e) => 'view' in e.dataset);
const matrix = (cube) =>
  cube.element
    .all()
    .find((e) => e.className === 'mvc-cube')
    .style.transform.slice(9, -1)
    .split(',')
    .map(Number);

test('engine fixture finds plugin owners by identity and OrbitControls disposal removes its registration', () => {
  const { engine, plugins } = setup();
  const orbit = new OrbitControls(engine);
  const registration = [...plugins.values()].find(p => p.name.startsWith('margoengine-controls:'));
  assert.ok(registration);
  assert.equal(engine.sceneOf(registration), engine);
  assert.equal(engine.sceneOf({ ...registration }), undefined, 'same name is not the registered identity');
  orbit.dispose();
  assert.equal(plugins.has(registration.name), false);
  assert.equal(engine.sceneOf(registration), undefined);
});

test('six faces of nine cells cover all 26 views; the six faces are labelled buttons', () => {
  const { engine, container } = setup(),
    cube = new ViewCube(engine, { labels: { front: 'Avant' } });
  assert.equal(container.children.at(-1), cube.element);
  assert.equal(cube.element.getAttribute('role'), 'group');
  assert.equal(cube.element.getAttribute('aria-label'), 'View cube');
  assert.equal(cells(cube).length, 54);
  assert.equal(new Set(cells(cube).map((e) => e.dataset.view)).size, 26);
  const buttons = cells(cube).filter((e) => e.tagName === 'BUTTON');
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')).sort(), [
    'Avant view',
    'Back view',
    'Bottom view',
    'Left view',
    'Right view',
    'Top view',
  ]);
  assert.ok(
    cells(cube)
      .filter((e) => e.tagName === 'DIV')
      .every((e) => e.getAttribute('aria-hidden') === 'true' && e.title),
  );
  assert.equal(cells(cube).find((e) => e.dataset.view === '1,1,1').title, 'Top Avant Right');
  assert.equal(cube.element.style.top, '12px');
  assert.equal(cube.element.style.right, '12px');
  assert.equal(cube.element.style.width, '80px');
  assert.ok(
    !cube.element.all().some((e) => e.dataset.projection !== undefined),
    'no projection toggle without a projection',
  );
});

test('the cube turns with the camera, and only faces toward the viewer take keyboard focus', () => {
  const { engine } = setup(),
    cube = new ViewCube(engine),
    focusable = () =>
      cells(cube)
        .filter((e) => e.tagName === 'BUTTON' && e.tabIndex === 0)
        .map((e) => e.textContent);
  engine.frame();
  assert.ok(
    close(matrix(cube), [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    'front view: world X right, world Y up the screen',
  );
  assert.deepEqual(focusable(), ['Front']);
  cube.view('iso', 0);
  engine.frame();
  assert.deepEqual(focusable().sort(), ['Front', 'Right', 'Top']);
  // Each face's CSS matrix maps its centre to normal * size/2 in world space.
  const face = cube.element
    .all()
    .filter((e) => e.className === 'mvc-face')[4]
    .style.transform.slice(9, -1)
    .split(',')
    .map(Number);
  assert.deepEqual(face.slice(12, 15), [0, 40, 0], 'top face pushed up by half the cube');
});

test('a click animates around the target, keeps the distance, and top/bottom keep a standard orientation', () => {
  const { engine } = setup({ position: [0, 0, -10], target: [1, 2, 3] }),
    cube = new ViewCube(engine, { duration: 0.5 });
  cells(cube)
    .find((e) => e.dataset.view === '0,1,0')
    .dispatch('click');
  assert.ok(cube.animating);
  engine.run(0.25);
  const mid = direction(engine.camera);
  assert.ok(mid[1] > 0.1 && mid[1] < 0.95, 'halfway up');
  engine.run(0.3);
  assert.ok(!cube.animating);
  const c = engine.camera;
  assert.deepEqual([...c.target], [1, 2, 3]);
  assert.ok(Math.abs(Math.hypot(...c.position.map((v, i) => v - c.target[i])) - Math.hypot(1, 2, 13)) < 1e-9);
  assert.deepEqual(direction(c), [0, 1, 0], 'exactly straight down');
  let s = screen(c);
  assert.ok(close(s.right, [1, 0, 0]) && close(s.up, [0, 0, -1]), 'top view from the back still has X right and -Z up');
  cube.view('bottom');
  engine.run(0.5);
  s = screen(c);
  assert.ok(direction(c)[1] === -1 && close(s.right, [1, 0, 0]) && close(s.up, [0, 0, 1]), 'bottom: X right, +Z up');
  for (const [view, right] of [
    ['front', [1, 0, 0]],
    ['right', [0, 0, -1]],
    ['back', [-1, 0, 0]],
    ['left', [0, 0, 1]],
  ]) {
    cube.view(view, 0);
    assert.ok(close(screen(c).right, right) && close(screen(c).up, [0, 1, 0]), view);
  }
  cube.view([1, 1, 0], 0);
  assert.ok(close(direction(c), unit([1, 1, 0])));
  assert.throws(() => cube.view([0, 0, 0]), /Invalid view/);
  assert.throws(() => cube.view('side'), /Invalid view/);
});

test('works with the stage CADCameraControls and OrbitControls: their input cancels an animation, idle controls do not', () => {
  const { engine, canvas } = setup(),
    orbit = new OrbitControls(engine),
    cube = new ViewCube(engine, { duration: 0.4 });
  orbit.enableDamping = true;
  cube.view('right');
  engine.run(0.5);
  assert.ok(close(direction(engine.camera), [1, 0, 0]), 'idle damped OrbitControls left the animation alone');
  cube.view('top');
  engine.frame();
  orbit.rotateLeft(0.5);
  engine.frame();
  engine.run(0.5);
  assert.ok(!cube.animating && direction(engine.camera)[1] < 0.9, 'an orbit drag mid-animation wins');
  const before = matrix(cube);
  orbit.rotateLeft(0.3);
  engine.frame();
  assert.notDeepEqual(matrix(cube), before, 'cube follows the orbit in the same frame');
  orbit.dispose();
  const cad = new CADCameraControls(engine.camera, canvas);
  cube.view('front');
  engine.frame();
  cad.orbit(0.4, 0);
  engine.run(0.5);
  assert.ok(!cube.animating && Math.abs(direction(engine.camera)[0]) > 0.2, 'CAD orbit mid-animation wins');
  cube.view('front');
  engine.run(0.5);
  assert.ok(close(direction(engine.camera), [0, 0, 1]));
  cad.dispose();
});

test('keyboard: arrows step 45 degrees, Home is isometric', () => {
  const { engine } = setup(),
    cube = new ViewCube(engine, { duration: 0 }),
    key = (k) => cube.element.dispatch('keydown', { key: k });
  assert.ok(key('ArrowRight').defaultPrevented);
  assert.ok(close(direction(engine.camera), unit([1, 0, 1])));
  key('ArrowRight');
  assert.ok(close(direction(engine.camera), [1, 0, 0]));
  key('ArrowUp');
  assert.ok(close(direction(engine.camera), unit([1, 1, 0])));
  key('ArrowUp');
  key('ArrowUp');
  assert.deepEqual(direction(engine.camera), [0, 1, 0], 'stops exactly on the pole');
  key('Home');
  assert.ok(close(direction(engine.camera), unit([1, 1, 1])));
  assert.ok(!key('a').defaultPrevented);
});

test('top and bottom are exactly vertical through camera.up, which is given back off the pole', () => {
  const { engine } = setup(),
    c = engine.camera,
    worldUp = c.up,
    cube = new ViewCube(engine, { duration: 0 }),
    key = (k) => cube.element.dispatch('keydown', { key: k });
  cube.view('top');
  engine.frame();
  assert.deepEqual(direction(c), [0, 1, 0]);
  assert.ok(close(c.up, [0, 0, -1]) && c.matrix.every(Number.isFinite), 'core accepts the exact pole');
  // Same image as the old 1e-6 rad approach, which core rendered with its default +Y up.
  const near = new Camera({ position: [0, 10 * Math.cos(1e-6), 10 * Math.sin(1e-6)], target: [0, 0, 0] });
  near.update(4 / 3, true);
  assert.ok(close([...c.matrix], [...near.matrix], 1e-5));
  cube.view('front');
  engine.frame();
  assert.equal(c.up, worldUp, 'the original up object is back');
  // Arrow keys from the right side to the top: the heading is kept in camera.up and turns on the pole.
  key('ArrowRight');
  key('ArrowRight');
  key('ArrowUp');
  key('ArrowUp');
  engine.frame();
  assert.deepEqual(direction(c), [0, 1, 0]);
  assert.ok(close(screen(c).up, [-1, 0, 0]), 'came from +X, so +X is at the bottom');
  key('ArrowLeft');
  engine.frame();
  assert.deepEqual(direction(c), [0, 1, 0]);
  assert.ok(close(screen(c).up, unit([-1, 0, -1])), 'turned 45 degrees on the pole');
  key('ArrowDown');
  engine.frame();
  assert.ok(close(direction(c), [0.5, Math.SQRT1_2, 0.5]));
  assert.equal(c.up, worldUp);
  key('ArrowDown');
  key('ArrowDown');
  key('ArrowDown');
  key('ArrowDown');
  engine.frame();
  assert.deepEqual(direction(c), [0, -1, 0]);
  assert.ok(close(screen(c).up, unit([1, 0, 1])), 'bottom: the heading points up the screen');
  // A control registered after the cube moves off the pole after the cube's update: one frame with the cube's up, then +Y.
  const orbit = new OrbitControls(engine);
  orbit.rotateUp(0.3);
  engine.frame();
  assert.ok(direction(c)[1] > -0.99 && c.matrix.every(Number.isFinite));
  engine.frame();
  assert.equal(c.up, worldUp);
  orbit.dispose();
  // An up set by someone else is theirs: the cube neither replaces nor restores it.
  cube.view('top');
  const mine = [1, 0, 0];
  c.up = mine;
  cube.view('front');
  engine.frame();
  assert.equal(c.up, mine);
  c.up = worldUp;
  // Disposing on the pole gives the up back and leaves a camera core accepts, showing the same view.
  cube.view('top');
  engine.frame();
  const before = [...c.matrix];
  cube.dispose();
  engine.camera.update(4 / 3, true);
  assert.equal(c.up, worldUp);
  assert.ok(close([...c.matrix], before, 1e-5));
});

test('the projection toggle drives @margoengine/cameras and reports its state', () => {
  const { engine } = setup(),
    projection = new CameraProjection({ mode: 'perspective' });
  engine.use(projection);
  const cube = new ViewCube(engine, { projection, corner: 'bottom-left' }),
    toggle = cube.element.all().find((e) => e.dataset.projection !== undefined);
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Orthographic projection');
  assert.equal(cube.element.style.bottom, '38px', 'room for the toggle under the cube');
  engine.frame();
  assert.notEqual(engine.camera.matrix[11], 0, 'perspective');
  toggle.dispatch('click');
  engine.frame();
  assert.equal(projection.mode, 'orthographic');
  assert.equal(cube.getProjection(), 'orthographic');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.textContent, 'Ortho');
  const m = engine.camera.matrix;
  assert.ok(!m[3] && !m[7] && !m[11], 'orthographic matrix');
  cube.view('top', 0);
  engine.frame();
  assert.ok(engine.camera.matrix.every(Number.isFinite), 'vertical view under the projection');
  cube.setProjection('perspective');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.throws(() => cube.setProjection('fisheye'), /Invalid projection/);
  const found = new ViewCube(engine);
  assert.equal(found.getProjection(), 'perspective', 'finds the attached CameraProjection');
  found.setProjection('orthographic');
  assert.equal(projection.mode, 'orthographic');
  assert.throws(() => new ViewCube(setup().engine).setProjection('orthographic'), { code: 'state' });
});

test('navigation profiles: flip turns a repeated click to the opposite view; a profile key toggling the projection updates the label', () => {
  const click = (cube, view) =>
    cells(cube)
      .find((e) => e.dataset.view === view)
      .dispatch('click');
  for (const [options, flips] of [
    [{}, false],
    [{ ...AUTOCAD.viewCube }, false],
    [{ ...BLENDER.viewCube }, true],
    [{ ...SOLIDWORKS.viewCube }, true],
  ]) {
    const { engine } = setup(),
      cube = new ViewCube(engine, { duration: 0, ...options });
    click(cube, '1,0,0');
    assert.ok(close(direction(engine.camera), [1, 0, 0]), 'first click turns to the view');
    click(cube, '1,0,0');
    assert.ok(
      close(direction(engine.camera), flips ? [-1, 0, 0] : [1, 0, 0]),
      `repeat click ${JSON.stringify(options)}`,
    );
    click(cube, '0,1,0');
    click(cube, '0,1,0');
    engine.frame();
    assert.deepEqual(direction(engine.camera), flips ? [0, -1, 0] : [0, 1, 0], 'and on the poles');
    assert.ok(engine.camera.matrix.every(Number.isFinite));
    cube.dispose();
  }
  // Mid-animation a click goes where it says, even with flip.
  const { engine, canvas } = setup(),
    cube = new ViewCube(engine, { duration: 0.4, flip: true });
  click(cube, '0,0,1');
  assert.ok(cube.animating);
  click(cube, '0,0,1');
  engine.run(0.5);
  assert.ok(close(direction(engine.camera), [0, 0, 1]));
  // Blender numpad 5 through OrbitControls flips the projection; the cube's toggle follows on the next frame.
  const projection = new CameraProjection({ mode: 'perspective' });
  engine.use(projection);
  const withToggle = new ViewCube(engine),
    orbit = OrbitControls.attach(engine).setProfile(BLENDER),
    toggle = withToggle.element.all().find((e) => e.dataset.projection !== undefined);
  orbit.listenToKeyEvents(canvas);
  canvas.dispatch('keydown', { code: 'Numpad5' });
  engine.frame();
  assert.equal(projection.mode, 'orthographic');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.textContent, 'Ortho');
  orbit.dispose();
  withToggle.dispose();
  cube.dispose();
});

test('drag to orbit: the cube follows the pointer, stops at the poles, and the click that ends a drag does nothing', () => {
  const { engine } = setup({ position: [0, 0, 10], target: [0, 0, 0] }),
    cube = new ViewCube(engine, { duration: 0.5 }),
    c = engine.camera,
    front = cells(cube).find((e) => e.dataset.view === '0,0,1'),
    drag = (from, to, cell = front, id = 1) => {
      cell.dispatch('pointerdown', { pointerId: id, button: 0, clientX: from[0], clientY: from[1] });
      const move = cell.dispatch('pointermove', { pointerId: id, clientX: to[0], clientY: to[1] });
      cell.dispatch('pointerup', { pointerId: id, clientX: to[0], clientY: to[1] });
      cell.dispatch('click');
      return move;
    };
  // 40 px right on an 80 px cube is one radian: the front turns right, so the camera goes left (azimuth -1).
  const move = drag([100, 100], [140, 100]);
  assert.ok(move.defaultPrevented, 'a drag move is not a page scroll');
  assert.ok(close(direction(c), [Math.sin(-1), 0, Math.cos(-1)], 1e-12), `${direction(c)}`);
  assert.ok(!cube.animating, 'the click ending the drag did not start a view');
  assert.ok(Math.abs(Math.hypot(...c.position) - 10) < 1e-9, 'distance kept');
  // Dragging down tips the top toward the viewer and stops exactly on the pole with a screen up, then frames run.
  cube.view('front', 0);
  drag([100, 100], [100, 400]);
  assert.deepEqual(direction(c), [0, 1, 0]);
  assert.ok(close(screen(c).up, [0, 0, -1]) && close(screen(c).right, [1, 0, 0]), 'top view keeps -Z up');
  engine.run(0.1);
  // Off the pole again, the app's up comes back.
  drag([100, 100], [100, 80]);
  assert.ok(direction(c)[1] < 1 && direction(c)[2] > 0);
  assert.deepEqual([...c.up], [0, 1, 0]);
  // A press that moves under 3 px is a click; Enter after a drag still activates a face.
  cube.view('front', 0);
  drag(
    [100, 100],
    [102, 101],
    cells(cube).find((e) => e.dataset.view === '0,1,0'),
  );
  assert.ok(cube.animating, 'small move is a click');
  engine.run(0.6);
  assert.deepEqual(direction(c), [0, 1, 0]);
  cube.view('front', 0);
  drag([100, 100], [120, 100]);
  cube.element.dispatch('keydown', { key: 'Enter' });
  front.dispatch('click');
  assert.ok(cube.animating, 'Enter activates after a drag');
  // A drag cancels a running animation; another pointer, a right-button press and drag = false do not orbit.
  cube.view('top');
  engine.run(0.1);
  drag([0, 0], [10, 0]);
  assert.ok(!cube.animating, 'drag cancels the animation');
  cube.view('front', 0);
  front.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  front.dispatch('pointermove', { pointerId: 2, clientX: 50, clientY: 0 });
  front.dispatch('pointerup', { pointerId: 1, clientX: 0, clientY: 0 });
  assert.ok(close(direction(c), [0, 0, 1]), 'another pointer');
  front.dispatch('pointerdown', { pointerId: 4, button: 2, clientX: 0, clientY: 0 });
  front.dispatch('pointermove', { pointerId: 4, clientX: 50, clientY: 0 });
  assert.ok(close(direction(c), [0, 0, 1]), 'a right-button press');
  cube.drag = false;
  cube.view('front', 0);
  drag([0, 0], [50, 0]);
  assert.ok(close(direction(c), [0, 0, 1]), 'drag = false');
  assert.equal(new ViewCube(engine, { drag: false }).drag, false);
  cube.dispose();
});

test('home: a button and the Home key return to the view the app set, target and distance included', () => {
  const { engine } = setup({ position: [3, 4, 12], target: [1, 2, 0] }),
    c = engine.camera,
    cube = new ViewCube(engine, { home: true, duration: 0.5 }),
    button = cube.element.all().find((e) => e.dataset.home !== undefined);
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('aria-label'), 'Home view');
  assert.equal(button.className, 'mvc-home');
  assert.deepEqual(cube.getHome(), { position: [3, 4, 12], target: [1, 2, 0] });
  // Somewhere else: another view, and a control panned the target and zoomed out.
  cube.view('top', 0);
  c.target = [-5, 0, 2];
  c.position = [-5, 30, 2];
  button.dispatch('click');
  assert.ok(cube.animating);
  engine.run(0.25);
  const mid = c.target;
  assert.ok(mid[0] > -5 && mid[0] < 1, 'the target moves during the animation');
  engine.run(0.3);
  assert.ok(!cube.animating);
  assert.deepEqual([...c.target], [1, 2, 0], 'the target lands exactly');
  assert.ok(close(c.position, [3, 4, 12], 1e-9), `${c.position}`);
  assert.deepEqual([...c.up], [0, 1, 0], 'the app up is back off the pole');
  // setHome takes the current camera or a placement; the Home key goes there; getHome is a copy.
  cube.setHome({ position: [1, 10, 0], target: [1, 0, 0] });
  cube.getHome().position[0] = 99;
  assert.equal(cube.element.all().filter((e) => e.dataset.home !== undefined).length, 1, 'one button');
  cube.element.dispatch('keydown', { key: 'Home' });
  engine.run(0.6);
  assert.deepEqual([...c.target], [1, 0, 0]);
  assert.ok(close(c.position, [1, 10, 0], 1e-9) && direction(c)[1] === 1, 'a vertical home is exactly vertical');
  assert.ok(close(screen(c).up, [0, 0, -1]), 'with a standard top orientation');
  engine.run(0.1);
  cube.view('front', 0);
  cube.setHome();
  cube.view('right', 0);
  cube.home(0);
  assert.ok(close(direction(c), [0, 0, 1]), 'setHome() keeps the camera as it was');
  for (const bad of [
    { position: [0, 0, 0], target: [0, 0, 0] },
    { position: [0, 0], target: [0, 0, 1] },
    { position: [0, NaN, 1], target: [0, 0, 0] },
  ])
    assert.throws(() => cube.setHome(bad), /Invalid home; use/);
  // A drag from the home button does not orbit; without a home, Home is the isometric view and there is no button.
  cube.view('front', 0);
  button.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  button.dispatch('pointermove', { pointerId: 1, clientX: 50, clientY: 0 });
  assert.ok(close(direction(c), [0, 0, 1]));
  cube.dispose();
  const plain = new ViewCube(engine);
  assert.equal(plain.getHome(), undefined);
  assert.ok(!plain.element.all().some((e) => e.dataset.home !== undefined));
  plain.home(0);
  assert.ok(close(direction(c), unit([1, 1, 1])));
  plain.dispose();
});

test('roll buttons turn the view 90 degrees about its axis; the roll holds while orbiting and a view click ends it', () => {
  const { engine } = setup({ position: [0, 0, 10], target: [0, 0, 0] }),
    c = engine.camera,
    cube = new ViewCube(engine, { roll: true, duration: 0.5 }),
    buttons = cube.element.all().filter((e) => e.dataset.roll !== undefined),
    [ccw, cw] = buttons;
  assert.deepEqual(
    buttons.map((b) => [b.tagName, b.getAttribute('aria-label'), b.dataset.roll]),
    [
      ['BUTTON', 'Roll the view counter-clockwise', '1'],
      ['BUTTON', 'Roll the view clockwise', '-1'],
    ],
  );
  assert.equal(cube.element.style.top, '38px', 'a top-corner cube moves down for the button row above it');
  assert.equal(cube.turns, 0);
  ccw.dispatch('click');
  engine.run(0.25);
  assert.ok(cube.turns > 0.2 && cube.turns < 0.8, `halfway: ${cube.turns}`);
  engine.run(0.3);
  // Counter-clockwise: world +X, right before, is now up the screen and +Y points left; the camera did not move.
  assert.equal(cube.turns, 1);
  assert.ok(close(c.position, [0, 0, 10], 1e-12), 'the camera stays');
  assert.ok(close(screen(c).up, [1, 0, 0], 1e-12) && close(screen(c).right, [0, -1, 0], 1e-12));
  assert.ok(close(matrix(cube), [0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 1e-12), 'the cube shows the roll');
  // Another control orbits to the right view: the roll holds about the new axis (never parallel to it).
  c.position = [10, 0, 0];
  engine.frame();
  assert.ok(close(screen(c).up, [0, 0, -1], 1e-12), `${screen(c).up}`);
  // A drag on the rolled view follows the pointer on screen: up the screen is what right was before the roll.
  cube.view('front', 0);
  assert.equal(cube.turns, 0, 'a view change is upright');
  assert.deepEqual([...c.up], [0, 1, 0], 'with the app up');
  cube.roll(1, 0);
  const front = cells(cube).find((e) => e.dataset.view === '0,0,1');
  front.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  front.dispatch('pointermove', { pointerId: 1, clientX: 100, clientY: 60 });
  front.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 60 });
  front.dispatch('click'); // the browser's click that ends the drag
  assert.ok(close(direction(c), [Math.sin(-1), 0, Math.cos(-1)], 1e-12), `${direction(c)}`);
  assert.equal(cube.turns, 1, 'a drag keeps the roll');
  // Clockwise, twice round, on the top pole and the bottom pole; four quarter turns are upright again.
  cube.view('top', 0);
  cw.dispatch('click');
  engine.run(0.6);
  assert.equal(cube.turns, 3);
  assert.deepEqual(direction(c), [0, 1, 0]);
  assert.ok(close(screen(c).up, [-1, 0, 0], 1e-12), 'top view rolled clockwise: -X up');
  cube.roll(1, 0);
  assert.equal(cube.turns, 0);
  assert.ok(close(screen(c).up, [0, 0, -1], 1e-12), 'four quarter turns: the standard top view');
  cube.view('bottom', 0);
  cube.roll(2, 0);
  assert.ok(close(screen(c).up, [0, 0, -1], 1e-12) && direction(c)[1] === -1, 'bottom rolled half a turn');
  cube.element.dispatch('keydown', { key: 'ArrowUp' });
  engine.run(0.6);
  assert.equal(cube.turns, 0, 'the arrow keys are upright');
  // An up set by someone else wins and ends the roll; dispose gives the app up back; bad turns throw.
  cube.view('front', 0);
  cube.roll(1, 0);
  c.up = [0, 1, 0];
  engine.frame();
  assert.equal(cube.turns, 0);
  assert.deepEqual([...c.up], [0, 1, 0]);
  cube.roll(-1, 0);
  const rolledUp = c.up;
  assert.ok(close(screen(c).up, [-1, 0, 0], 1e-12));
  assert.throws(() => cube.roll(Number.NaN), /Invalid roll; use/);
  cube.dispose();
  assert.deepEqual([...c.up], [0, 1, 0]);
  assert.notEqual(c.up, rolledUp);
  const plain = new ViewCube(engine);
  assert.ok(!plain.element.all().some((e) => e.dataset.roll !== undefined), 'no roll buttons by default');
  plain.dispose();
});

/** A CSS colour as [r, g, b, a] (0 to 255, alpha 0 to 1): #rgb, #rrggbb or rgba(). */
const rgba = (c) => {
  if (c.startsWith('rgba(')) return c.slice(5, -1).split(',').map(Number);
  const h = c.length === 4 ? [...c.slice(1)].map((x) => x + x) : [c.slice(1, 3), c.slice(3, 5), c.slice(5, 7)];
  return [...h.map((x) => Number.parseInt(x, 16)), 1];
};
/** Source-over of a translucent colour on an opaque one, as browsers blend sRGB values. */
const over = (top, under) => [...top.slice(0, 3).map((x, i) => x * top[3] + under[i] * (1 - top[3])), 1];
/** WCAG 2.2 relative luminance and contrast ratio. */
const luminance = (c) => {
  const [r, g, b] = c.slice(0, 3).map((x) => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('themes: every built-in colour pair meets WCAG 2 contrast over a black and a white page', () => {
  assert.deepEqual(Object.keys(THEMES), ['light', 'dark', 'high-contrast']);
  for (const [name, t] of Object.entries(THEMES)) {
    const min = name === 'high-contrast' ? 7 : 4.5;
    for (const page of [
      [0, 0, 0],
      [255, 255, 255],
    ]) {
      const fill = over(rgba(t.background), page),
        hover = over(rgba(t.hover), fill),
        at = `${name} over ${page}`;
      assert.ok(contrast(rgba(t.text), fill) >= min, `${at}: text ${contrast(rgba(t.text), fill)}`);
      assert.ok(contrast(rgba(t.hoverText), hover) >= min, `${at}: hover text ${contrast(rgba(t.hoverText), hover)}`);
      assert.ok(contrast(rgba(t.line), fill) >= 3, `${at}: edges ${contrast(rgba(t.line), fill)}`);
      assert.ok(contrast(rgba(t.focus), hover) >= 3, `${at}: focus ring ${contrast(rgba(t.focus), hover)}`);
    }
  }
  // The checker itself: black on white is 21:1, and the old light edge colour #868d98 fails 3:1 over a black page.
  assert.equal(contrast([0, 0, 0], [255, 255, 255]), 21);
  assert.ok(contrast(rgba('#868d98'), over(rgba(THEMES.light.background), [0, 0, 0])) < 3);
});

test('setTheme writes the theme as custom properties; the stylesheet reads them, light by default', () => {
  const { engine } = setup(),
    cube = new ViewCube(engine),
    css = cube.element.all().find((e) => e.tagName === 'STYLE').textContent,
    props = () => Object.keys(cube.element.style).filter((k) => k.startsWith('--mvc-'));
  // No theme: no inline colours, so app CSS can set the --mvc-* properties; the stylesheet has no fixed colours left.
  assert.deepEqual(props(), []);
  assert.ok(css.startsWith(`.mvc{--mvc-background:${THEMES.light.background};--mvc-text:${THEMES.light.text};`));
  assert.ok(css.includes(`--mvc-hover-text:${THEMES.light.hoverText}`));
  const rules = css
    .split('\n')
    .filter((l) => !l.includes('--mvc-background:'))
    .join('');
  assert.ok(!/#[0-9a-f]{3,6}\b|rgba?\(/.test(rules), `fixed colours left: ${rules}`);
  assert.ok(css.includes('@media(prefers-color-scheme:dark){.mvc-auto{--mvc-background:rgba(36,40,47,.92)'));
  cube.setTheme('dark');
  assert.equal(cube.element.style['--mvc-background'], THEMES.dark.background);
  assert.equal(cube.element.style['--mvc-hover-text'], THEMES.dark.hoverText);
  assert.equal(props().length, 6);
  assert.equal(cube.element.className, 'mvc');
  // Your own tokens: the rest fall back to the stylesheet. 'auto' leaves the colours to the browser's settings.
  cube.setTheme({ background: '#123456', text: 'white' });
  assert.deepEqual(props(), ['--mvc-background', '--mvc-text']);
  cube.setTheme('auto');
  assert.deepEqual(props(), []);
  assert.equal(cube.element.className, 'mvc mvc-auto');
  cube.setTheme('light');
  assert.equal(cube.element.className, 'mvc');
  for (const bad of ['sepia', null, { text: 4 }]) assert.throws(() => cube.setTheme(bad), /Invalid theme; use/);
  cube.dispose();
  const hc = new ViewCube(engine, { theme: 'high-contrast' });
  assert.equal(hc.element.style['--mvc-background'], '#000');
  hc.dispose();
});

test('dispose removes the widget and its plugin; engine removal disposes it', () => {
  const { engine, container, plugins } = setup(),
    cube = new ViewCube(engine);
  cube.dispose();
  assert.ok(!container.children.includes(cube.element));
  assert.equal(plugins.size, 0);
  cube.dispose();
  const again = new ViewCube(engine);
  engine.removePlugin(again.name);
  assert.ok(!container.children.includes(again.element));
  assert.throws(() => new ViewCube({ ...engine, canvas: { parentElement: null } }), /needs a container/);
  assert.throws(() => new ViewCube(engine, { size: 0 }), /Invalid size or duration; use/);
});

test('a view option turns that view camera and places the cube in the corner of its rectangle', () => {
  const { engine } = setup(),
    camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] });
  const cube = new ViewCube(engine, { view: { camera, viewport: [0.5, 0, 0.5, 0.5] } });
  assert.equal(cube.camera, camera);
  assert.equal(cube.element.style.top, 'calc(0% + 12px)');
  assert.equal(cube.element.style.right, 'calc(0% + 12px)');
  cube.dispose();
  const left = new ViewCube(engine, { corner: 'bottom-left', view: { camera, viewport: [0.25, 0, 0.5, 0.5] } });
  assert.equal(left.element.style.left, 'calc(25% + 12px)');
  assert.equal(left.element.style.bottom, 'calc(50% + 12px)');
  left.dispose();
});

test('axis triad: X, Y and Z balls turn with the camera and act like the cube', () => {
  const { engine, plugins } = setup(),
    c = engine.camera,
    triad = AxisTriad.attach(engine, { duration: 0, home: true, roll: true }),
    of = (name) => triad.element.all().filter((e) => e.className === name),
    balls = of('mvc-ball'),
    sticks = of('mvc-stick'),
    at = (e) => /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(e.style.transform).slice(1).map(Number);
  assert.ok(triad instanceof ViewCube);
  assert.equal(triad.element.style.width, '64px', 'smaller than the cube by default');
  assert.deepEqual(of('mvc-face'), [], 'no cube faces');
  assert.deepEqual(
    balls.map((b) => [b.tagName, b.dataset.view, b.getAttribute('aria-label'), b.style.width]),
    [
      ['BUTTON', '1,0,0', 'Right view (X)', '18px'],
      ['DIV', '-1,0,0', null, '12px'],
      ['BUTTON', '0,1,0', 'Top view (Y)', '18px'],
      ['DIV', '0,-1,0', null, '12px'],
      ['BUTTON', '0,0,1', 'Front view (Z)', '18px'],
      ['DIV', '0,0,-1', null, '12px'],
    ],
  );
  assert.equal(balls[0].style['--c'], 'var(--mvc-x,#c62828)');
  for (const b of balls.filter((e) => e.tagName === 'BUTTON')) {
    const color = rgba(/#\w+/.exec(b.style['--c'])[0]);
    assert.ok(contrast([255, 255, 255], color) >= 4.5, `white letter on ${b.style['--c']}`);
  }
  // Front view: centre 32 px, axis length 23 px. +X right of the centre, +Y above it, +Z on the centre in front.
  assert.deepEqual(at(balls[0]), [46, 23]);
  assert.deepEqual(at(balls[1]), [3, 26]);
  assert.deepEqual(at(balls[2]), [23, 0]);
  assert.deepEqual(at(balls[4]), [23, 23]);
  assert.deepEqual(
    balls.map((b) => b.style.zIndex),
    ['200', '200', '200', '200', '300', '100'],
  );
  assert.equal(sticks[0].style.width, '23px');
  assert.equal(sticks[0].style.transform, 'translate(32px,31px) rotate(0rad)');
  assert.equal(sticks[4].style.width, '0px');
  // A click on a ball is that axis view: from the right, -Z is screen right, so the Z ball moves to the left.
  balls[0].dispatch('click');
  engine.frame();
  assert.ok(close(direction(c), [1, 0, 0], 1e-12));
  assert.deepEqual(at(balls[0]), [23, 23]);
  assert.deepEqual(at(balls[4]), [0, 23]);
  assert.equal(balls[0].style.zIndex, '300');
  // Dragging a ball orbits (two radians per triad width); the click ending the drag starts no view.
  triad.view('front', 0);
  balls[4].dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  balls[4].dispatch('pointermove', { pointerId: 1, clientX: 32, clientY: 0 });
  balls[4].dispatch('pointerup', { pointerId: 1, clientX: 32, clientY: 0 });
  balls[4].dispatch('click');
  assert.ok(close(direction(c), [Math.sin(-1), 0, Math.cos(-1)], 1e-12), `${direction(c)}`);
  // Home, roll and themes come with it.
  assert.equal(triad.element.all().filter((e) => e.dataset.home !== undefined).length, 1);
  assert.equal(triad.element.all().filter((e) => e.dataset.roll !== undefined).length, 2);
  triad.roll(1, 0);
  assert.equal(triad.turns, 1);
  triad.home(0);
  assert.ok(close(direction(c), [0, 0, 1], 1e-12));
  triad.setTheme('dark');
  assert.equal(triad.element.style['--mvc-background'], THEMES.dark.background);
  triad.dispose();
  assert.equal(triad.element.parentElement, null);
  assert.ok(![...plugins.keys()].some((k) => k.startsWith('margoengine-viewcube')));
});

/** Minified and gzipped size of a dist entry; `alone` also leaves out the package's own root entry it imports. */
async function gzipOf(t, file, alone = false) {
  const { build } = await import('vite'),
    { gzipSync } = await import('node:zlib'),
    { mkdtemp, writeFile, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'margoengine-viewcube-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const entry = join(folder, 'entry.js');
  await writeFile(
    entry,
    `export * from ${JSON.stringify(fileURLToPath(new URL(`../dist/${file}`, import.meta.url)).replaceAll('\\', '/'))};`,
  );
  const out = await build({
    root: folder,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: 'entry' },
      rollupOptions: {
        external: (id) => id.startsWith('@margoengine/') || (alone && id === './index.js'),
        output: compactOutput,
      },
    },
  });
  return gzipSync((Array.isArray(out) ? out[0] : out).output.map((chunk) => chunk.code ?? '').join('\n')).length;
}

test('size budget', async (t) => {
  const gzip = await gzipOf(t, 'index.js');
  console.log(`viewcube gzip: ${gzip} B`);
  // 3,394 B before drag to orbit; drag measured 3,709 B, home view 4,101 B, roll 4,619 B, themes 5,065 B, the build
  // and draw hooks for the axis triad 5,130 B (2026-11-08).
  assert.ok(gzip < 5150, `${gzip} B`);
});

test('axis triad size budget: the axes entry over the cube it imports', async (t) => {
  const gzip = await gzipOf(t, 'axes.js', true);
  console.log(`viewcube/axes gzip, without the root entry: ${gzip} B`);
  // Measured 1,127 B (2026-11-08).
  assert.ok(gzip < 1200, `${gzip} B`);
});
