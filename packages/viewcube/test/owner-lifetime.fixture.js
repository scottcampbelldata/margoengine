// The node adapter has no document: there the widgets get a small stand-in DOM whose nodes are EventTargets, so every
// listener they add is still watched; in a browser they get a real container on the page.
class Node extends EventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.attributes = new Map();
    this.className = this.textContent = this.title = this.type = '';
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  closest(selector) {
    for (let n = this; n; n = n.parentElement) if (n.tagName.toLowerCase() === selector) return n;
    return null;
  }
  querySelector() {
    return null;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 80, bottom: 80, width: 80, height: 80 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() {
    return false;
  }
}
class Doc extends EventTarget {
  activeElement = null;
  defaultView = Object.assign(new EventTarget(), {
    innerWidth: 640,
    innerHeight: 480,
    getComputedStyle: () => ({ position: 'static' }),
  });
  body = new Node(this, 'body');
  createElement(tag) {
    return new Node(this, tag);
  }
}
const container = () => {
  if (globalThis.document) {
    const div = document.createElement('div');
    div.style.cssText = 'position:relative;width:64px;height:32px';
    document.body.append(div);
    return { element: div, remove: () => div.remove() };
  }
  const doc = new Doc();
  return { element: doc.createElement('div'), remove() {} };
};

export async function fixtures(load = (entry) => import(entry)) {
  const { ViewCube } = await load('../dist/index.js');
  const { AxisTriad } = await load('../dist/axes.js');
  const { UpViewCube } = await load('../dist/up.js');
  const { FitViewCube } = await load('../dist/fit.js');
  const { ViewCompass } = await load('../dist/compass.js');
  const entries = [];
  const own = (name, make) =>
    entries.push({
      name,
      create({ engine }) {
        const box = container(),
          cube = make(engine, box.element);
        return { dispose: () => cube.dispose(), cleanup: () => box.remove() };
      },
    });
  own('ViewCube', (engine, element) => new ViewCube(engine, { container: element, home: true, roll: true }));
  own('ViewCube.attach', (engine, element) => ViewCube.attach(engine, { container: element, duration: 0 }));
  own('AxisTriad', (engine, element) => new AxisTriad(engine, { container: element }));
  own('UpViewCube', (engine, element) => new UpViewCube(engine, { container: element, up: 'z' }));
  own(
    'FitViewCube',
    (engine, element) => new FitViewCube(engine, { container: element, bounds: { min: [-1, -1, -1], max: [1, 1, 1] } }),
  );
  // A compass rides on a cube the caller made, a dependency here; with its menu it listens on the document and window.
  for (const menu of [false, true])
    entries.push({
      name: 'ViewCompass' + (menu ? ' menu' : ''),
      create({ engine, scene, dependency }) {
        const box = container();
        const cube = dependency(() => new ViewCube(engine, { container: box.element }));
        const compass = ViewCompass.attach(cube, { menu, north: 0.5 });
        return {
          dependencies: [scene.plugins.get(cube.name)],
          dispose: () => compass.dispose(),
          cleanup: () => {
            cube.dispose();
            box.remove();
          },
        };
      },
    });
  return entries;
}
