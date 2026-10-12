import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { StrictMode } from "react";
import { renderToString } from "react-dom/server";

const instances = [],
  pending = [];
let defer = false;
mock.module("@margoengine/core/extension", {
  namedExports: {
    Engine: {
      async create(canvas) {
        const engine = {
          canvas,
          camera: {},
          use() {},
          disposed: false,
          callbacks: new Set(),
          starts: 0,
          disposals: 0,
          start() {
            this.starts++;
          },
          dispose() {
            this.disposals++;
            this.disposed = true;
            this.callbacks.clear();
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
    Mesh: class {},
    box() {},
    PbrMaterial: class {},
    engineRuntime: (engine) => engine,
    meshRuntime: (mesh) => mesh,
  },
});
const { MargoCanvas, Canvas, useMargoStage, useFrame } =
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
