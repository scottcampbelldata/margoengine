// Minimal DOM and engine doubles for Node: enough surface for LabelRenderer, with style-write counting.
export class FakeElement {
  constructor(document, tag = 'div') {
    this.ownerDocument = document; this.tagName = tag.toUpperCase();
    this.children = []; this.parentElement = null; this.dataset = {}; this.className = '';
    this.styleWrites = 0; this.fixedRect = null;
    const element = this;
    this.style = new Proxy({}, {set(target, key, value) {target[key] = value; element.styleWrites++; return true;}});
  }
  appendChild(child) {child.remove(); child.parentElement = this; this.children.push(child); return child;}
  insertBefore(child, reference) {
    child.remove(); child.parentElement = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
  get firstChild() {return this.children[0] ?? null;}
  get nextSibling() {const parent = this.parentElement; return parent ? parent.children[parent.children.indexOf(this) + 1] ?? null : null;}
  get isConnected() {let node = this; while (node.parentElement) node = node.parentElement; return node === this.ownerDocument.body;}
  remove() {const parent = this.parentElement; if (parent) {parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;}}
  getBoundingClientRect() {
    if (this.fixedRect) return {...this.fixedRect};
    const parent = this.parentElement?.getBoundingClientRect() ?? {left: 0, top: 0};
    return {left: parent.left + (parseFloat(this.style.left) || 0), top: parent.top + (parseFloat(this.style.top) || 0)};
  }
  descendants() {return this.children.flatMap(child => [child, ...child.descendants()]);}
}

export class FakeDocument {
  constructor() {this.body = new FakeElement(this, 'body');}
  createElement(tag) {return new FakeElement(this, tag);}
}

/** Engine double exposing what LabelRenderer reads: canvas, camera, backend, meshes and the transform store. */
export function fakeEngine(Camera, {width = 800, height = 400, backend = 'webgpu', capacity = 16, camera = {position: [0, 0, 5], target: [0, 0, 0]}} = {}) {
  const document = new FakeDocument();
  const container = document.body.appendChild(document.createElement('div'));
  const canvas = container.appendChild(document.createElement('canvas'));
  Object.assign(canvas, {clientWidth: width, clientHeight: height, width, height, clientLeft: 0, clientTop: 0, offsetLeft: 30, offsetTop: 20});
  canvas.fixedRect = {left: 30, top: 20};
  const passes = [];
  const engine = {
    canvas, backend, disposed: false, document, container,
    camera: new Camera(camera),
    meshes: new Map(),
    store: {matrices: new Float32Array(capacity * 16), parents: new Float32Array(capacity).fill(-1), hidden: new Uint8Array(capacity)},
    graph: {add(pass) {passes.push(pass); return () => {};}},
    passes,
    frame() {engine.camera.update(width / height, backend === 'webgpu'); for (const pass of passes) pass.execute({});},
    createMesh(position = [0, 0, 0]) {
      const id = engine.meshes.size, mesh = {id};
      engine.meshes.set(id, mesh);
      engine.move(mesh, position);
      return mesh;
    },
    move(mesh, [x, y, z], linear = [1, 0, 0, 0, 1, 0, 0, 0, 1]) {
      const m = engine.store.matrices, o = mesh.id * 16;
      m.set([linear[0], linear[1], linear[2], 0, linear[3], linear[4], linear[5], 0, linear[6], linear[7], linear[8], 0, x, y, z, 1], o);
    },
  };
  return engine;
}
