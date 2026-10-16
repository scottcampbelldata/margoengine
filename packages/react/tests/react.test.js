import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import React, { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { transformWithOxc } from "vite";

const instances = [],
  pending = [],
  shadows = [];
let defer = false;
class Material {
  constructor(options = {}) {
    Object.assign(this, options);
  }
}
class EngineMesh {
  constructor(engine) {
    this.engine = engine;
    this.id = engine.createdMeshes.length;
    this.parent = null;
    this.children = new Set();
    this.geometry = null;
    this.material = new Material();
    this.position = [0, 0, 0];
    this.rotation = [0, 0, 0];
    this.scale = [1, 1, 1];
    this.disposals = 0;
  }
  check() {
    assert.equal(this.engine.disposed, false);
    assert.equal(this.engine.meshes.get(this.id), this);
  }
  setPosition(value) {
    this.check();
    this.position = [...value];
    return this;
  }
  setRotation(value) {
    this.check();
    this.rotation = [...value];
    return this;
  }
  setScale(value) {
    this.check();
    this.scale = [...value];
    return this;
  }
  setParent(parent) {
    this.check();
    parent?.check();
    this.parent?.children.delete(this);
    this.parent = parent;
    parent?.children.add(this);
    return this;
  }
  setGeometry(geometry) {
    this.check();
    if (this.geometry === geometry) return this;
    const references = this.engine.geometryReferences;
    if (this.geometry) {
      const count = references.get(this.geometry) - 1;
      if (count) references.set(this.geometry, count);
      else references.delete(this.geometry);
    }
    this.geometry = geometry;
    if (geometry) references.set(geometry, (references.get(geometry) ?? 0) + 1);
    return this;
  }
  setMaterial(material) {
    this.check();
    this.material = material;
    return this;
  }
  dispose() {
    if (this.engine.meshes.get(this.id) !== this) return;
    this.disposals++;
    this.setGeometry(null);
    this.setParent(null);
    for (const child of this.children) child.setParent(null);
    this.engine.meshes.delete(this.id);
  }
}
mock.module("@margoengine/core/extension", {
  namedExports: {
    Engine: {
      async create(canvas, options) {
        const engine = {
          canvas,
          camera: { ...options.camera },
          meshes: new Map(),
          createdMeshes: [],
          geometryReferences: new Map(),
          plugins: new Map(),
          createMesh() {
            assert.equal(this.disposed, false);
            const mesh = new EngineMesh(this);
            this.meshes.set(mesh.id, mesh);
            this.createdMeshes.push(mesh);
            return mesh;
          },
          use(plugin) {
            assert.equal(this.disposed, false);
            assert.equal(this.plugins.has(plugin.name), false);
            this.plugins.set(plugin.name, plugin);
            return this;
          },
          removePlugin(name) {
            const plugin = this.plugins.get(name);
            this.plugins.delete(name);
            plugin?.dispose?.();
          },
          disposed: false,
          callbacks: new Set(),
          starts: 0,
          disposals: 0,
          start() {
            this.starts++;
          },
          dispose() {
            if (this.disposed) return;
            this.disposals++;
            for (const name of this.plugins.keys()) this.removePlugin(name);
            for (const mesh of this.meshes.values()) mesh.dispose();
            this.callbacks.clear();
            this.disposed = true;
          },
          onFrame(fn) {
            this.callbacks.add(fn);
            return () => this.callbacks.delete(fn);
          },
        };
        instances.push(engine);
        if (defer) await new Promise((resolve) => pending.push(resolve));
        return engine;
      },
    },
    Mesh: EngineMesh,
    box: (...args) => ({ args }),
    PbrMaterial: Material,
    engineRuntime: (engine) => engine,
    meshRuntime: (mesh) => mesh,
  },
});
mock.module("@margoengine/shadows", {
  namedExports: {
    Shadows: class {
      static attach(engine) {
        const effect = new this();
        effect.owner = engine;
        effect.name = "shadows";
        effect.disposals = 0;
        engine.use(effect);
        shadows.push(effect);
        return effect;
      }
      dispose() {
        if (this.disposals) return;
        this.disposals++;
        this.owner.removePlugin(this.name);
      }
    },
  },
});
const { MargoCanvas, MargoContext, Canvas, Stage, Mesh, BoxGeometry, PbrMaterial,
  mesh, boxGeometry, meshStandardMaterial, useMargo, useMargoStage, useFrame } =
  await import("../dist/index.js");
test("SSR renders an accessible native canvas without creating an engine", () => {
  assert.equal(Canvas, MargoCanvas);
  assert.match(
    renderToString(React.createElement(MargoCanvas)),
    /aria-label="Interactive 3D scene"/,
  );
  assert.equal(instances.length, 0);
});
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "HTMLCanvasElement",
  "navigator",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    observers.push(this);
  }
  observe(element) {
    this.element = element;
  }
  disconnect() {
    this.disconnected = true;
  }
};
const { render, act, cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  defer = false;
  for (const engine of instances) {
    assert.equal(engine.disposals, 1);
    assert.equal(engine.callbacks.size, 0);
    assert.equal(engine.meshes.size, 0);
    assert.equal(engine.geometryReferences.size, 0);
    assert.equal(engine.plugins.size, 0);
    for (const mesh of engine.createdMeshes) {
      assert.equal(mesh.disposals, 1);
      assert.equal(mesh.parent, null);
      assert.equal(mesh.children.size, 0);
    }
  }
  assert.ok(shadows.every((effect) => effect.disposals === 1));
  assert.ok(observers.every((observer) => observer.disconnected));
});
async function loadTsx(source) {
  const { code } = await transformWithOxc(source, "react-example.tsx", {
    jsx: { runtime: "automatic" },
  });
  const resolved = code
    .replaceAll("@margoengine/react", new URL("../dist/index.js", import.meta.url).href)
    .replaceAll("react/jsx-runtime", import.meta.resolve("react/jsx-runtime"));
  return import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
}
test("lowercase exports are the existing React components", () => {
  assert.equal(mesh, Mesh);
  assert.equal(boxGeometry, BoxGeometry);
  assert.equal(meshStandardMaterial, PbrMaterial);
});
test("the exact integration-doc snippet mounts and disposes through repeated StrictMode cycles", async () => {
  const documentation = await readFile(new URL("../../../docs/react-integration.md", import.meta.url), "utf8");
  const source = /```tsx\r?\n([\s\S]*?)```/.exec(documentation)?.[1];
  assert.ok(source, "the integration guide must retain its executable TSX example");
  const { App } = await loadTsx(source);
  for (let cycle = 0; cycle < 3; cycle++) {
    const beforeEngines = instances.length, beforeShadows = shadows.length;
    const view = render(React.createElement(StrictMode, null, React.createElement(App)));
    await act(async () => {});
    assert.equal(instances.length, beforeEngines + 1, "Stage must reuse the Canvas engine");
    const engine = instances.at(-1);
    assert.equal(engine.starts, 1);
    assert.equal(engine.createdMeshes.length, 2, "StrictMode replays the mesh mount effect");
    assert.equal(engine.createdMeshes[0].disposals, 1);
    assert.equal(engine.meshes.size, 1);
    const node = engine.meshes.values().next().value;
    assert.deepEqual(node.position, [0, 1, 0]);
    assert.deepEqual(node.geometry.args, [1, 1, 1]);
    assert.equal(node.material.color, "#84d6bd");
    assert.equal(engine.geometryReferences.get(node.geometry), 1);
    assert.deepEqual(engine.camera.position, [0, 2, 5]);
    assert.equal(shadows.length, beforeShadows + 1);
    assert.equal(engine.plugins.get("shadows"), shadows.at(-1));
    assert.equal(view.container.querySelectorAll("canvas").length, 1);
    assert.equal(view.container.querySelectorAll("mesh, boxGeometry, meshStandardMaterial").length, 0);
    view.unmount();
    assert.equal(engine.disposals, 1);
    assert.equal(engine.meshes.size, 0);
    assert.equal(engine.geometryReferences.size, 0);
    assert.equal(engine.plugins.size, 0);
    assert.ok(engine.createdMeshes.every((mesh) => mesh.disposals === 1 && mesh.parent === null && mesh.children.size === 0));
    assert.equal(view.container.childNodes.length, 0);
  }
});
test("namespace JSX aliases build the same nested scene and release it when Stage children are removed", async () => {
  const { App } = await loadTsx(`
    import * as Margo from '@margoengine/react';
    export function App({ show = true }) {
      return <Margo.Canvas><Margo.Stage>{show &&
        <Margo.mesh position={[1, 2, 3]}>
          <Margo.boxGeometry args={[2, 3, 4]} />
          <Margo.meshStandardMaterial color="#123456" roughness={0.2} metalness={0.7} />
          <Margo.mesh position={[0, 1, 0]} />
        </Margo.mesh>
      }</Margo.Stage></Margo.Canvas>;
    }
  `);
  const tree = (show) => React.createElement(StrictMode, null, React.createElement(App, { show }));
  const view = render(tree(true));
  await act(async () => {});
  const engine = instances.at(-1), nodes = [...engine.meshes.values()];
  assert.equal(nodes.length, 2);
  const parent = nodes.find((node) => node.geometry), child = nodes.find((node) => !node.geometry);
  assert.deepEqual(parent.geometry.args, [2, 3, 4]);
  assert.equal(parent.material.color, "#123456");
  assert.equal(parent.material.roughness, 0.2);
  assert.equal(parent.material.metalness, 0.7);
  assert.equal(child.parent, parent);
  assert.deepEqual([...parent.children], [child]);
  view.rerender(tree(false));
  await act(async () => {});
  assert.equal(engine.disposed, false, "removing Stage children keeps the Canvas engine alive");
  assert.equal(engine.meshes.size, 0);
  assert.equal(engine.geometryReferences.size, 0);
  assert.ok(engine.createdMeshes.every((node) => node.disposals === 1 && node.parent === null && node.children.size === 0));
  view.unmount();
});
test("Stage waits for a ready, live context stage before rendering or configuring it", async () => {
  const engine = { camera: {}, disposed: false }, stage = { engine };
  const tree = (value) => React.createElement(MargoContext.Provider, { value },
    React.createElement(Stage, { camera: { position: [1, 2, 3] } }, React.createElement("span", null, "ready")));
  const view = render(tree({ stage: null, ready: false, canvas: null }));
  assert.equal(view.container.textContent, "");
  view.rerender(tree({ stage, ready: false, canvas: null }));
  assert.equal(view.container.textContent, "");
  assert.deepEqual(engine.camera, {});
  view.rerender(tree({ stage: null, ready: true, canvas: null }));
  assert.equal(view.container.textContent, "");
  view.rerender(tree({ stage, ready: true, canvas: null }));
  await act(async () => {});
  assert.equal(view.container.textContent, "ready");
  assert.deepEqual(engine.camera.position, [1, 2, 3]);
  engine.disposed = true;
  engine.camera.position = [7, 8, 9];
  view.rerender(tree({ stage, ready: true, canvas: null }));
  assert.equal(view.container.textContent, "");
  assert.deepEqual(engine.camera.position, [7, 8, 9]);
});
test("Stage camera props override Canvas defaults and update the existing engine", async () => {
  const before = instances.length;
  let received;
  function Child() {
    received = useMargo().stage;
    return null;
  }
  const tree = (canvasCamera, camera) => React.createElement(StrictMode, null,
    React.createElement(Canvas, { camera: canvasCamera },
      React.createElement(Stage, { camera }, React.createElement(Child))));
  const camera = { position: [1, 2, 3] };
  const view = render(tree({ position: [9, 9, 9], fov: 70 }, camera));
  await act(async () => {});
  const engine = instances.at(-1);
  assert.equal(received.engine, engine);
  assert.deepEqual(engine.camera.position, [1, 2, 3]);
  assert.equal(engine.camera.fov, 70);
  view.rerender(tree({ position: [6, 6, 6], fov: 60 }, camera));
  await act(async () => {});
  assert.deepEqual(engine.camera.position, [1, 2, 3]);
  assert.equal(engine.camera.fov, 60);
  view.rerender(tree({ fov: 60 }, {
    position: [4, 5, 6], target: [0, 1, 0], fov: 42, near: 0.2, far: 200,
  }));
  await act(async () => {});
  assert.deepEqual(engine.camera, {
    position: [4, 5, 6], target: [0, 1, 0], fov: 42, near: 0.2, far: 200,
  });
  assert.equal(instances.length, before + 1);
  assert.equal(engine.starts, 1);
  view.unmount();
});
test("Stage shadow requests share the Canvas effect and release the last request", async () => {
  const before = shadows.length;
  const tree = (canvasShadows, first, second) => React.createElement(StrictMode, null,
    React.createElement(Canvas, { shadows: canvasShadows },
      React.createElement(Stage, { key: "first", shadows: first }),
      React.createElement(Stage, { key: "second", shadows: second })));
  const view = render(tree(false, true, true));
  await act(async () => {});
  const engine = instances.at(-1), effect = shadows.at(-1);
  assert.equal(shadows.length, before + 1);
  assert.equal(engine.plugins.get("shadows"), effect);
  view.rerender(tree(false, false, true));
  await act(async () => {});
  assert.equal(engine.plugins.get("shadows"), effect);
  assert.equal(effect.disposals, 0);
  view.rerender(tree(true, false, false));
  await act(async () => {});
  assert.equal(engine.plugins.get("shadows"), effect);
  view.rerender(tree(false, false, false));
  await act(async () => {});
  assert.equal(effect.disposals, 1);
  assert.equal(engine.plugins.has("shadows"), false);
  view.rerender(tree(true, true, false));
  await act(async () => {});
  assert.equal(shadows.length, before + 2);
  const current = shadows.at(-1);
  view.rerender(tree(false, true, false));
  await act(async () => {});
  assert.equal(engine.plugins.get("shadows"), current);
  assert.equal(current.disposals, 0);
  view.unmount();
  assert.equal(current.disposals, 1);
});
test("StrictMode, resize, stable frame callbacks and unmount release resources", async () => {
  let received,
    first = 0,
    second = 0;
  function Child({ callback }) {
    received = useMargoStage();
    useFrame(callback);
    return null;
  }
  const tree = (callback) =>
    React.createElement(
      StrictMode,
      null,
      React.createElement(
        MargoCanvas,
        null,
        React.createElement(Child, { callback }),
      ),
    );
  const view = render(tree(() => first++));
  await act(async () => {});
  const engine = instances.at(-1),
    callback = [...engine.callbacks][0];
  assert.equal(received, engine);
  assert.equal(engine.callbacks.size, 1);
  view.rerender(tree(() => second++));
  assert.equal([...engine.callbacks][0], callback);
  callback(engine, 1 / 60);
  assert.equal(first, 0);
  assert.equal(second, 1);
  const canvas = view.container.querySelector("canvas");
  canvas.getBoundingClientRect = () => ({ width: 410, height: 220 });
  observers.at(-1).callback();
  assert.equal(canvas.width, 410);
  assert.equal(canvas.height, 220);
  view.unmount();
  assert.equal(engine.disposals, 1);
  assert.equal(engine.callbacks.size, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
});
test("late async initialization after unmount is disposed and never started", async () => {
  defer = true;
  const view = render(React.createElement(MargoCanvas));
  await act(async () => {});
  const engine = instances.at(-1);
  view.unmount();
  await act(async () => pending.shift()());
  assert.equal(engine.disposals, 1);
  assert.equal(engine.starts, 0);
  defer = false;
});
test("effect recreation serializes initialization and disposes superseded engines", async () => {
  defer = true;
  const view = render(React.createElement(MargoCanvas, { capacity: 4 }));
  await act(async () => {});
  const old = instances.at(-1);
  view.rerender(React.createElement(MargoCanvas, { capacity: 8 }));
  await act(async () => pending.shift()());
  assert.equal(old.disposals, 1);
  assert.equal(old.starts, 0);
  const current = instances.at(-1);
  await act(async () => pending.shift()());
  assert.equal(current.starts, 1);
  view.unmount();
  assert.equal(current.disposals, 1);
  defer = false;
});
test("initialization errors are visible and dispose the engine", async () => {
  const errors = [],
    view = render(
      React.createElement(MargoCanvas, {
        onCreated() {
          throw new Error("setup failed");
        },
        onError: (error) => errors.push(error),
      }),
    );
  await act(async () => {});
  assert.match(view.getByRole("alert").textContent, /setup failed/);
  assert.equal(instances.at(-1).disposals, 1);
  assert.equal(errors.length, 1);
  cleanup();
});
