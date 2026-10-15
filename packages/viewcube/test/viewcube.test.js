import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Camera, CADCameraControls} from '../../core/dist/index.js';
import {OrbitControls, AUTOCAD, BLENDER, SOLIDWORKS} from '../../controls/dist/index.js';
import {CameraProjection} from '../../cameras/dist/index.js';
import {compactOutput} from '../../../scripts/measure-size.js';
import {ViewCube} from '../dist/index.js';

/** Just enough DOM for the widget: elements, attributes, delegated events and `closest`. */
class FakeElement {
  constructor(document, tag) {Object.assign(this, {ownerDocument: document, tagName: tag.toUpperCase(), children: [], parentElement: null, style: {}, dataset: {}, attributes: {}, listeners: {}, className: '', textContent: '', title: '', tabIndex: 0});}
  appendChild(child) {child.parentElement = this; this.children.push(child); return child;}
  remove() {const p = this.parentElement; if (p) {p.children.splice(p.children.indexOf(this), 1); this.parentElement = null;}}
  setAttribute(name, value) {this.attributes[name] = String(value);}
  getAttribute(name) {return this.attributes[name] ?? null;}
  addEventListener(type, listener) {(this.listeners[type] ??= new Set()).add(listener);}
  removeEventListener(type, listener) {this.listeners[type]?.delete(listener);}
  dispatch(type, init = {}) {
    const event = {type, target: this, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, ...init};
    for (let node = this; node; node = node.parentElement) for (const listener of node.listeners[type] ?? []) listener(event);
    return event;
  }
  closest() {let node = this; while (node && !('view' in node.dataset || 'projection' in node.dataset)) node = node.parentElement; return node;}
  all() {return this.children.flatMap(child => [child, ...child.all()]);}
  // Canvas surface for the controls.
  get clientWidth() {return 400;} get clientHeight() {return 300;}
  getBoundingClientRect() {return {left: 0, top: 0, width: 400, height: 300};}
  setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() {return false;}
}
function setup(camera = {position: [0, 0, 10], target: [0, 0, 0]}) {
  const document = {createElement: tag => new FakeElement(document, tag)}, container = new FakeElement(document, 'div'), canvas = container.appendChild(new FakeElement(document, 'canvas'));
  const plugins = new Map(), passes = [];
  const engine = {canvas, camera: new Camera(camera), disposed: false, plugins,
    use(plugin) {plugin.setup(engine); plugin.registerPasses?.({add: pass => passes.push(pass)}); plugins.set(plugin.name, plugin); return engine;},
    hasPlugin: name => plugins.has(name), removePlugin(name) {const p = plugins.get(name); plugins.delete(name); p?.dispose?.();},
    /** Core's order: plugins' onPreUpdate, camera advance and update, then the frame graph. */
    frame(delta = 1 / 60) {for (const p of plugins.values()) p.onPreUpdate?.(delta); engine.camera.advance(delta); engine.camera.update(4 / 3, true); for (const pass of passes) pass.execute({});},
    run(seconds) {for (let t = 0; t < seconds; t += 1 / 60) engine.frame();}};
  return {engine, container, canvas, plugins, passes};
}
const close = (a, b, eps = 1e-4) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const unit = v => {const l = Math.hypot(...v); return v.map(x => x / l);};
const direction = c => unit(c.position.map((v, i) => v - c.target[i]));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Screen right and up as core builds them: right = camera.up x back, up = back x right. */
const screen = c => {const z = direction(c), r = unit(cross(c.up, z)); return {right: r, up: cross(z, r)};};
const cells = cube => cube.element.all().filter(e => 'view' in e.dataset);
const matrix = cube => cube.element.all().find(e => e.className === 'mvc-cube').style.transform.slice(9, -1).split(',').map(Number);

test('six faces of nine cells cover all 26 views; the six faces are labelled buttons', () => {
  const {engine, container} = setup(), cube = new ViewCube(engine, {labels: {front: 'Avant'}});
  assert.equal(container.children.at(-1), cube.element);
  assert.equal(cube.element.getAttribute('role'), 'group'); assert.equal(cube.element.getAttribute('aria-label'), 'View cube');
  assert.equal(cells(cube).length, 54); assert.equal(new Set(cells(cube).map(e => e.dataset.view)).size, 26);
  const buttons = cells(cube).filter(e => e.tagName === 'BUTTON');
  assert.deepEqual(buttons.map(b => b.getAttribute('aria-label')).sort(), ['Avant view', 'Back view', 'Bottom view', 'Left view', 'Right view', 'Top view']);
  assert.ok(cells(cube).filter(e => e.tagName === 'DIV').every(e => e.getAttribute('aria-hidden') === 'true' && e.title));
  assert.equal(cells(cube).find(e => e.dataset.view === '1,1,1').title, 'Top Avant Right');
  assert.equal(cube.element.style.top, '12px'); assert.equal(cube.element.style.right, '12px'); assert.equal(cube.element.style.width, '80px');
  assert.ok(!cube.element.all().some(e => e.dataset.projection !== undefined), 'no projection toggle without a projection');
});

test('the cube turns with the camera, and only faces toward the viewer take keyboard focus', () => {
  const {engine} = setup(), cube = new ViewCube(engine), focusable = () => cells(cube).filter(e => e.tagName === 'BUTTON' && e.tabIndex === 0).map(e => e.textContent);
  engine.frame();
  assert.ok(close(matrix(cube), [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 'front view: world X right, world Y up the screen');
  assert.deepEqual(focusable(), ['Front']);
  cube.view('iso', 0); engine.frame(); assert.deepEqual(focusable().sort(), ['Front', 'Right', 'Top']);
  // Each face's CSS matrix maps its centre to normal * size/2 in world space.
  const face = cube.element.all().filter(e => e.className === 'mvc-face')[4].style.transform.slice(9, -1).split(',').map(Number);
  assert.deepEqual(face.slice(12, 15), [0, 40, 0], 'top face pushed up by half the cube');
});

test('a click animates around the target, keeps the distance, and top/bottom keep a standard orientation', () => {
  const {engine} = setup({position: [0, 0, -10], target: [1, 2, 3]}), cube = new ViewCube(engine, {duration: 0.5});
  cells(cube).find(e => e.dataset.view === '0,1,0').dispatch('click');
  assert.ok(cube.animating); engine.run(0.25);
  const mid = direction(engine.camera); assert.ok(mid[1] > 0.1 && mid[1] < 0.95, 'halfway up');
  engine.run(0.3); assert.ok(!cube.animating);
  const c = engine.camera; assert.deepEqual([...c.target], [1, 2, 3]); assert.ok(Math.abs(Math.hypot(...c.position.map((v, i) => v - c.target[i])) - Math.hypot(1, 2, 13)) < 1e-9);
  assert.deepEqual(direction(c), [0, 1, 0], 'exactly straight down');
  let s = screen(c); assert.ok(close(s.right, [1, 0, 0]) && close(s.up, [0, 0, -1]), 'top view from the back still has X right and -Z up');
  cube.view('bottom'); engine.run(0.5); s = screen(c);
  assert.ok(direction(c)[1] === -1 && close(s.right, [1, 0, 0]) && close(s.up, [0, 0, 1]), 'bottom: X right, +Z up');
  for (const [view, right] of [['front', [1, 0, 0]], ['right', [0, 0, -1]], ['back', [-1, 0, 0]], ['left', [0, 0, 1]]]) {
    cube.view(view, 0); assert.ok(close(screen(c).right, right) && close(screen(c).up, [0, 1, 0]), view);
  }
  cube.view([1, 1, 0], 0); assert.ok(close(direction(c), unit([1, 1, 0])));
  assert.throws(() => cube.view([0, 0, 0]), /Invalid view/); assert.throws(() => cube.view('side'), /Invalid view/);
});

test('works with core CADCameraControls and OrbitControls: their input cancels an animation, idle controls do not', () => {
  const {engine, canvas} = setup(), orbit = new OrbitControls(engine), cube = new ViewCube(engine, {duration: 0.4});
  orbit.enableDamping = true;
  cube.view('right'); engine.run(0.5);
  assert.ok(close(direction(engine.camera), [1, 0, 0]), 'idle damped OrbitControls left the animation alone');
  cube.view('top'); engine.frame(); orbit.rotateLeft(0.5); engine.frame(); engine.run(0.5);
  assert.ok(!cube.animating && direction(engine.camera)[1] < 0.9, 'an orbit drag mid-animation wins');
  const before = matrix(cube); orbit.rotateLeft(0.3); engine.frame(); assert.notDeepEqual(matrix(cube), before, 'cube follows the orbit in the same frame');
  orbit.dispose();
  const cad = new CADCameraControls(engine.camera, canvas);
  cube.view('front'); engine.frame(); cad.orbit(0.4, 0); engine.run(0.5);
  assert.ok(!cube.animating && Math.abs(direction(engine.camera)[0]) > 0.2, 'CAD orbit mid-animation wins');
  cube.view('front'); engine.run(0.5); assert.ok(close(direction(engine.camera), [0, 0, 1]));
  cad.dispose();
});

test('keyboard: arrows step 45 degrees, Home is isometric', () => {
  const {engine} = setup(), cube = new ViewCube(engine, {duration: 0}), key = k => cube.element.dispatch('keydown', {key: k});
  assert.ok(key('ArrowRight').defaultPrevented); assert.ok(close(direction(engine.camera), unit([1, 0, 1])));
  key('ArrowRight'); assert.ok(close(direction(engine.camera), [1, 0, 0]));
  key('ArrowUp'); assert.ok(close(direction(engine.camera), unit([1, 1, 0])));
  key('ArrowUp'); key('ArrowUp'); assert.deepEqual(direction(engine.camera), [0, 1, 0], 'stops exactly on the pole');
  key('Home'); assert.ok(close(direction(engine.camera), unit([1, 1, 1])));
  assert.ok(!key('a').defaultPrevented);
});

test('top and bottom are exactly vertical through camera.up, which is given back off the pole', () => {
  const {engine} = setup(), c = engine.camera, worldUp = c.up, cube = new ViewCube(engine, {duration: 0}), key = k => cube.element.dispatch('keydown', {key: k});
  cube.view('top'); engine.frame();
  assert.deepEqual(direction(c), [0, 1, 0]); assert.ok(close(c.up, [0, 0, -1]) && c.matrix.every(Number.isFinite), 'core accepts the exact pole');
  // Same image as the old 1e-6 rad approach, which core rendered with its default +Y up.
  const near = new Camera({position: [0, 10 * Math.cos(1e-6), 10 * Math.sin(1e-6)], target: [0, 0, 0]}); near.update(4 / 3, true);
  assert.ok(close([...c.matrix], [...near.matrix], 1e-5));
  cube.view('front'); engine.frame(); assert.equal(c.up, worldUp, 'the original up object is back');
  // Arrow keys from the right side to the top: the heading is kept in camera.up and turns on the pole.
  key('ArrowRight'); key('ArrowRight'); key('ArrowUp'); key('ArrowUp'); engine.frame();
  assert.deepEqual(direction(c), [0, 1, 0]); assert.ok(close(screen(c).up, [-1, 0, 0]), 'came from +X, so +X is at the bottom');
  key('ArrowLeft'); engine.frame(); assert.deepEqual(direction(c), [0, 1, 0]); assert.ok(close(screen(c).up, unit([-1, 0, -1])), 'turned 45 degrees on the pole');
  key('ArrowDown'); engine.frame(); assert.ok(close(direction(c), [0.5, Math.SQRT1_2, 0.5])); assert.equal(c.up, worldUp);
  key('ArrowDown'); key('ArrowDown'); key('ArrowDown'); key('ArrowDown'); engine.frame();
  assert.deepEqual(direction(c), [0, -1, 0]); assert.ok(close(screen(c).up, unit([1, 0, 1])), 'bottom: the heading points up the screen');
  // A control registered after the cube moves off the pole after the cube's update: one frame with the cube's up, then +Y.
  const orbit = new OrbitControls(engine); orbit.rotateUp(0.3); engine.frame();
  assert.ok(direction(c)[1] > -0.99 && c.matrix.every(Number.isFinite)); engine.frame(); assert.equal(c.up, worldUp);
  orbit.dispose();
  // An up set by someone else is theirs: the cube neither replaces nor restores it.
  cube.view('top'); const mine = [1, 0, 0]; c.up = mine; cube.view('front'); engine.frame(); assert.equal(c.up, mine);
  c.up = worldUp;
  // Disposing on the pole gives the up back and leaves a camera core accepts, showing the same view.
  cube.view('top'); engine.frame(); const before = [...c.matrix]; cube.dispose(); engine.camera.update(4 / 3, true);
  assert.equal(c.up, worldUp); assert.ok(close([...c.matrix], before, 1e-5));
});

test('the projection toggle drives @margoengine/cameras and reports its state', () => {
  const {engine} = setup(), projection = new CameraProjection({mode: 'perspective'}); engine.use(projection);
  const cube = new ViewCube(engine, {projection, corner: 'bottom-left'}), toggle = cube.element.all().find(e => e.dataset.projection !== undefined);
  assert.equal(toggle.tagName, 'BUTTON'); assert.equal(toggle.getAttribute('aria-pressed'), 'false'); assert.equal(toggle.getAttribute('aria-label'), 'Orthographic projection');
  assert.equal(cube.element.style.bottom, '38px', 'room for the toggle under the cube');
  engine.frame(); assert.notEqual(engine.camera.matrix[11], 0, 'perspective');
  toggle.dispatch('click'); engine.frame();
  assert.equal(projection.mode, 'orthographic'); assert.equal(cube.getProjection(), 'orthographic'); assert.equal(toggle.getAttribute('aria-pressed'), 'true'); assert.equal(toggle.textContent, 'Ortho');
  const m = engine.camera.matrix; assert.ok(!m[3] && !m[7] && !m[11], 'orthographic matrix');
  cube.view('top', 0); engine.frame(); assert.ok(engine.camera.matrix.every(Number.isFinite), 'vertical view under the projection');
  cube.setProjection('perspective'); assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.throws(() => cube.setProjection('fisheye'), /Invalid projection/);
  const found = new ViewCube(engine); assert.equal(found.getProjection(), 'perspective', 'finds the attached CameraProjection'); found.setProjection('orthographic'); assert.equal(projection.mode, 'orthographic');
  assert.throws(() => new ViewCube(setup().engine).setProjection('orthographic'), /without a projection/);
});

test('navigation profiles: flip turns a repeated click to the opposite view; a profile key toggling the projection updates the label', () => {
  const click = (cube, view) => cells(cube).find(e => e.dataset.view === view).dispatch('click');
  for (const [options, flips] of [[{}, false], [{...AUTOCAD.viewCube}, false], [{...BLENDER.viewCube}, true], [{...SOLIDWORKS.viewCube}, true]]) {
    const {engine} = setup(), cube = new ViewCube(engine, {duration: 0, ...options});
    click(cube, '1,0,0'); assert.ok(close(direction(engine.camera), [1, 0, 0]), 'first click turns to the view');
    click(cube, '1,0,0'); assert.ok(close(direction(engine.camera), flips ? [-1, 0, 0] : [1, 0, 0]), `repeat click ${JSON.stringify(options)}`);
    click(cube, '0,1,0'); click(cube, '0,1,0'); engine.frame();
    assert.deepEqual(direction(engine.camera), flips ? [0, -1, 0] : [0, 1, 0], 'and on the poles'); assert.ok(engine.camera.matrix.every(Number.isFinite));
    cube.dispose();
  }
  // Mid-animation a click goes where it says, even with flip.
  const {engine, canvas} = setup(), cube = new ViewCube(engine, {duration: 0.4, flip: true});
  click(cube, '0,0,1'); assert.ok(cube.animating); click(cube, '0,0,1'); engine.run(0.5); assert.ok(close(direction(engine.camera), [0, 0, 1]));
  // Blender numpad 5 through OrbitControls flips the projection; the cube's toggle follows on the next frame.
  const projection = new CameraProjection({mode: 'perspective'}); engine.use(projection);
  const withToggle = new ViewCube(engine), orbit = OrbitControls.attach(engine).setProfile(BLENDER), toggle = withToggle.element.all().find(e => e.dataset.projection !== undefined);
  orbit.listenToKeyEvents(canvas); canvas.dispatch('keydown', {code: 'Numpad5'}); engine.frame();
  assert.equal(projection.mode, 'orthographic'); assert.equal(toggle.getAttribute('aria-pressed'), 'true'); assert.equal(toggle.textContent, 'Ortho');
  orbit.dispose(); withToggle.dispose(); cube.dispose();
});

test('dispose removes the widget and its plugin; engine removal disposes it', () => {
  const {engine, container, plugins} = setup(), cube = new ViewCube(engine);
  cube.dispose(); assert.ok(!container.children.includes(cube.element)); assert.equal(plugins.size, 0); cube.dispose();
  const again = new ViewCube(engine); engine.removePlugin(again.name); assert.ok(!container.children.includes(again.element));
  assert.throws(() => new ViewCube({...engine, canvas: {parentElement: null}}), /needs a container/);
  assert.throws(() => new ViewCube(engine, {size: 0}), /Invalid ViewCube size/);
});

test('size budget', async t => {
  const {build} = await import('vite'), {gzipSync} = await import('node:zlib'), {mkdtemp, writeFile, rm} = await import('node:fs/promises'), {tmpdir} = await import('node:os'), {join} = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'margoengine-viewcube-')); t.after(() => rm(folder, {recursive: true, force: true}));
  const entry = join(folder, 'entry.js'); await writeFile(entry, `export * from ${JSON.stringify(fileURLToPath(new URL('../dist/index.js', import.meta.url)).replaceAll('\\', '/'))};`);
  const out = await build({root: folder, configFile: false, logLevel: 'silent', build: {write: false, minify: true, target: 'es2022', lib: {entry, formats: ['es'], fileName: 'entry'}, rollupOptions: {external: id => id.startsWith('@margoengine/'), output: compactOutput}}});
  const gzip = gzipSync((Array.isArray(out) ? out[0] : out).output.map(chunk => chunk.code ?? '').join('\n')).length;
  console.log(`viewcube gzip: ${gzip} B`); assert.ok(gzip < 3500, `${gzip} B`);
});
