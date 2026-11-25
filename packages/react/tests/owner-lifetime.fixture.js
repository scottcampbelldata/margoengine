// Owner/lifetime fixture of the React bindings. A representative tree (a mesh with its geometry and material, a glTF
// model, an Environment, OrbitControls, a Bloom effect and an Html label) is mounted into the harness's engine with the
// test renderer, as a Canvas mounts it into its own, and unmounted: every mesh, plugin, GPU resource, frame callback and
// listener the tree made must be gone. The React root and the listeners React DOM keeps on its container for good are
// the application's (`app`), as they are in a page; everything the Margo components make is the owner's.
import * as React from 'react';
import { ownedByEngine, lifetimeFault } from '../../../tests/support/owner-shell.js';

const h = React.createElement;

// On the CPU there is no page: one jsdom document stands in for it while a tree is mounted, with the globals React DOM
// and the components read. The browser leaf runs in a real page and installs nothing but React's act flag.
let dom = null,
  users = 0,
  saved = null;
const GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
];
async function page() {
  if (globalThis.document && !dom) return null;
  if (!dom) {
    const name = 'jsdom';
    const { JSDOM } = await import(/* @vite-ignore */ name);
    dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    // jsdom's selector engine listens on the document from its first query: the page's, made here, not an owner's.
    dom.window.document.querySelector('body');
  }
  return dom;
}
function install() {
  if (users++) return;
  saved = Object.fromEntries(GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  if (dom) {
    const { window } = dom;
    for (const key of GLOBALS.slice(0, -2)) {
      const value = key === 'window' ? window : window[key];
      set(key, typeof value === 'function' && !/^[A-Z]/.test(key) ? value.bind(window) : value);
    }
  }
  set('IS_REACT_ACT_ENVIRONMENT', true);
  // The model and environment files, served from memory: the glTF loader takes only HTTP(S) URLs.
  const real = saved.fetch?.value ?? globalThis.fetch;
  set('fetch', async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = String(input instanceof Request ? input.url : input),
      file = FILES.get(url);
    return file ? new Response(file.body, { headers: { 'content-type': file.type } }) : real(input, init);
  });
}
const FILES = new Map();
let mounts = 0;
function uninstall() {
  if (--users) return;
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  saved = null;
}

// A lit triangle in one embedded buffer: a glTF file as a data URL, so no server is needed on either leaf.
function gltfURL() {
  const position = new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]),
    normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    bytes = new Uint8Array(position.byteLength + normal.byteLength);
  bytes.set(new Uint8Array(position.buffer), 0);
  bytes.set(new Uint8Array(normal.buffer), position.byteLength);
  const base64 = (data) => btoa(String.fromCharCode(...data));
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${base64(bytes)}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: position.byteLength },
      { buffer: 0, byteOffset: position.byteLength, byteLength: normal.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.6, -0.6, 0], max: [0.6, 0.6, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    nodes: [{ mesh: 0, name: 'triangle' }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  FILES.set('https://owner-lifetime.example/triangle.gltf', { body: JSON.stringify(doc), type: 'model/gltf+json' });
  return 'https://owner-lifetime.example/triangle.gltf';
}
// A 4 x 2 Radiance HDR (flat RGBE scanlines, too short for run-length encoding): a grey sky over a dark ground.
function hdrURL() {
  const header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n',
    head = Array.from(header, (c) => c.charCodeAt(0)),
    pixels = [...Array(4).fill([128, 128, 128, 129]).flat(), ...Array(4).fill([64, 64, 64, 128]).flat()];
  FILES.set('https://owner-lifetime.example/sky.hdr', {
    body: new Uint8Array([...head, ...pixels]),
    type: 'application/octet-stream',
  });
  return 'https://owner-lifetime.example/sky.hdr';
}

export async function fixtures(load = (entry) => import(entry)) {
  const window = (await page())?.window;
  const { Mesh, BoxGeometry, PbrMaterial } = await load('../dist/index.js');
  const { Model } = await load('../dist/gltf.js');
  const { Environment } = await load('../dist/environment.js');
  const { OrbitControls } = await load('../dist/controls.js');
  const { EffectComposer, Bloom } = await load('../dist/post.js');
  const { Html } = await load('../dist/html.js');
  const { createTestRenderer, act } = await load('../dist/test.js');
  const model = gltfURL(),
    hdr = hdrURL();
  const tree = (on, label) =>
    h(
      React.Fragment,
      null,
      h(
        Mesh,
        { position: [0, 0, 0] },
        h(BoxGeometry, { args: [1, 1, 1] }),
        h(PbrMaterial, { color: '#ff8800', roughness: 0.4 }),
        h(Html, { position: [0, 1, 0] }, h('span', { className: label }, 'label')),
      ),
      h(React.Suspense, { fallback: null }, h(Model, { src: model, onLoad: on('model'), onError: on.fail })),
      h(React.Suspense, { fallback: null }, h(Environment, { src: hdr, onError: on.fail })),
      h(OrbitControls),
      h(EffectComposer, { onError: on.fail }, h(Bloom, { onReady: on('bloom'), onError: on.fail })),
    );
  return [
    {
      name: 'Canvas tree',
      // React DOM listens on every portal container it mounts into (the Html label's element) and never stops; the
      // component removes that element from the page on unmount, and the listeners go with it.
      detachedNodes: 'React DOM keeps its delegated listeners on a portal container; Html removes the container',
      eventTargets: () => (window ? [window.EventTarget.prototype] : []),
      async create({ engine, scene, app }) {
        install();
        let renderer, container;
        try {
          const document = globalThis.document,
            before = new Set(engine.meshes.values());
          const lighting = {
            direction: Array.from(engine.lighting.direction),
            radiance: Array.from(engine.lighting.radiance),
          };
          container = document.body.appendChild(document.createElement('div'));
          // A stage borrowed by the test renderer: the harness's engine, drawn by the harness itself.
          const stage = { engine, canvas: { width: 64, height: 32 }, step() {}, dispose() {} };
          renderer = await app(() => createTestRenderer(null, { stage, container }));
          const done = new Set(),
            failures = [];
          const on = (what) => () => {
            done.add(what);
          };
          on.fail = (error) => {
            failures.push(error);
          };
          const label = `owner-label-${++mounts}`;
          await renderer.update(tree(on, label));
          // Loads settle on promises (data URLs, lazy entries); frames let the components that wait on them commit.
          // The first mount in a page also fetches the lazy entries and compiles pipelines: a hard limit of 30 s.
          // The Environment is done when its background, attached after its lighting, is in the scene it renders into.
          const ready = () => {
            if (engine.scene.plugins.has('environment:background')) done.add('environment');
            return done.size === 3;
          };
          for (const end = performance.now() + 30000; !ready() && !failures.length && performance.now() < end; ) {
            // Inside act: a suspended load that resolves commits there, as a test renderer expects.
            await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
            await renderer.advanceFrames(1);
          }
          if (failures.length) throw failures[0];
          if (done.size < 3)
            lifetimeFault(
              `React tree did not finish loading: ${[...done].join(', ') || 'nothing'} of model, environment, bloom`,
            );
          if (!document.querySelector(`.${label}`)) lifetimeFault('the Html label never reached the page');
          const made = [...engine.meshes.values()].filter((mesh) => !before.has(mesh));
          if (made.length < 2) lifetimeFault(`the tree made ${made.length} meshes, expected the box and the model`);
          let released = false;
          const release = () => {
            if (released) return undefined;
            released = true;
            return renderer.unmount().finally(() => container.remove());
          };
          return ownedByEngine(scene, 'react:canvas-tree', release, {
            check({ phase }) {
              if (phase !== 'disposed') return;
              const left = made.filter((mesh) => engine.meshes.get(mesh.id) === mesh);
              if (left.length) lifetimeFault(`an unmounted tree leaves ${left.length} mesh(es) in the engine`);
              if (document.querySelector(`.${label}`))
                lifetimeFault('an unmounted tree leaves its Html label in the page');
              if (
                !engine.disposed &&
                (lighting.direction.some((v, i) => engine.lighting.direction[i] !== v) ||
                  lighting.radiance.some((v, i) => engine.lighting.radiance[i] !== v))
              )
                lifetimeFault('an unmounted Environment leaves its light on the scene');
            },
            cleanup() {
              if (this.cleaned) return;
              this.cleaned = true;
              uninstall();
            },
          });
        } catch (error) {
          await renderer?.unmount();
          container?.remove();
          uninstall();
          throw error;
        }
      },
    },
  ];
}
