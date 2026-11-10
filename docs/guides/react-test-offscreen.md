# React component tests and worker canvas

`@margoengine/react/test` exports `createTestRenderer`, `TestRenderer` and `act`.
It mounts ordinary React components with `react-dom/client.createRoot` and awaits
`act` for commits, frame advances and events. There is no custom reconciler.
Use a browser or install a DOM such as jsdom in the test runner before importing
the bindings. Set `IS_REACT_ACT_ENVIRONMENT = true` in the test setup, as required
by React. The entry does not install DOM or GPU globals. React 19 uses React's
`act`; React 18 can use the React DOM test utility fallback.

The default stage is `createNullStage` from `@margoengine/headless/null`. It
requests no GPU and uses real engine meshes, scenes, transforms and plugins.
Creation accepts the null stage's width, height, capacity, camera, signal and
onError options. Width and height default to 1. A supplied `container` keeps its
existing children; the renderer owns only the canvas and mount it adds. Without
one it appends and owns a div in document.body. A supplied manually driven
headless `stage` is borrowed and survives unmount; otherwise the stage is owned.
GPU-only bindings need a rendering stage and their usual dependencies; shadows
that require the Canvas shadow controller need a real Canvas. Null stages cannot
prove GPU rendering, GPU deformation or pixel output.

The renderer exposes `stage`, `scene`, `container`, `disposed`, `findAll`,
`update`, `advanceFrames`, `fireEvent` and `unmount`, and supports async disposal.
`findAll` filters live meshes from every engine scene, in insertion order.
`advanceFrames` defaults to one frame at 1/60 second. It runs React frame hooks,
native ticks and plugins, respecting frame priorities. Counts must be nonnegative
safe integers and delta must be in 0..1 seconds. `fireEvent` takes an explicit
live mesh or null hit, a DOM event type, and optional pointer/wheel initialization.
It uses the Canvas dispatcher for bubbling, hover, capture, missed events and
propagation. Synthetic pointer capture is local to this renderer. Events default
to primary pointer 1; a click is a pointerdown followed by pointerup. Await each
helper before starting another. Pointer handler failures reject the helper.
Unmount flushes effects and releases the cache, event listeners and owned stage.

A test helper that mounts any element (for example `createElement(Mesh, null, createElement(BoxGeometry))`),
advances two frames, clicks the first mesh and counts the meshes, then releases the owned null stage:

```ts
import { createTestRenderer } from '@margoengine/react/test';

export async function clickAndCount(element: Parameters<typeof createTestRenderer>[0]): Promise<number> {
  const renderer = await createTestRenderer(element, { width: 64, height: 64 });
  try {
    await renderer.advanceFrames(2, 1 / 60);
    const [first] = renderer.findAll();
    await renderer.fireEvent(first ?? null, 'pointerdown');
    await renderer.fireEvent(first ?? null, 'pointerup');
    return renderer.findAll().length;
  } finally {
    await renderer.unmount();
  }
}
```

`@margoengine/react/offscreen` exports `OffscreenCanvas`. React and its DOM
children stay on the main thread. The required `scene` URL names a module that
exports `createScene(context)`, following `@margoengine/worker/auto`. The module
receives canvas, structured-cloneable data, signal, selected mode and attach.
Call attach for each engine and return a dispose owner. React mesh components
are tested with the test entry; offscreen scenes use native engine/package APIs.
React elements, functions and context are never transferred to a worker.

Mode defaults to auto: probe worker support before canvas transfer and fall back
to the page if workers, OffscreenCanvas or renderer capabilities are unavailable.
Mode page forces the page; mode worker reports missing support. Runtime failures
after transfer are reported without replaying the scene. Backend defaults to auto;
data defaults to undefined; transfer defaults to none; signal defaults to none;
startup and cleanup timeout defaults to 30000 ms. The optional worker factory is
owned by the running scene. Worker bootstrap assets must be served by the bundler;
a factory can supply a CSP-hosted worker. These are the worker package's existing
shared-scene contracts, including size, visibility and input forwarding.

Backing width and height default to 300 and 150; the scene owns subsequent render
size. Style defaults to display block and 100% width/height. Class name defaults
to none and accessible label to Margo scene. Presentation props update without
restarting the scene. Changing the scene URL, dimensions or startup options creates
a fresh canvas, since transferred canvases cannot be reused. Keep data, transfer
and worker factory identities stable between unrelated React renders. Transfer
lists detach their contents; use fresh data when deliberately restarting a scene.
`onCreated` receives the AutoScene owner and selected mode. Startup/cleanup failures
reach `onError` if supplied, and startup failures appear in an alert. Unmount aborts
startup and disposes the scene/worker, including during StrictMode effect replay.

Evidence: `packages/react/tests/test-renderer.test.js`, `offscreen.test.js` and
`scripts/test-test-offscreen-browser.mjs` in that package. The browser fixture
compares a component-rendered cube to the shared native scene pixel for pixel,
checks worker, explicit page, automatic selection, missing transfer and missing
workers, keeps React state interactive on the page, and checks cleanup. These
synthetic mathematical controls are tests, not new demo artwork or speed claims.
