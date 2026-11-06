# @margoengine/worker

Runs the engine inside a Web Worker on an `OffscreenCanvas`, so a heavy scene never blocks the page's main thread and a busy page never stalls the scene. The helper moves the canvas and keeps the worker told of the page's canvas: its size, position, pixel ratio and visibility, and the input events the worker listens for. Core needs no change and no option: `Engine.create`, `engine.pick`, the frame loop, control packages and the `@margoengine/webgl` fallback run on the received canvas as they do on the page.

Two entries, one per side. `@margoengine/worker` goes in the page and `@margoengine/worker/canvas` in the worker, so neither side downloads the other's code.

```ts
// page.ts
import { transferCanvas, workerCanvasSupported } from '@margoengine/worker';

const canvas = document.querySelector('canvas')!;
if (!workerCanvasSupported()) throw new Error('Run the scene on the page here');
const worker = new Worker(new URL('./scene-worker.js', import.meta.url), { type: 'module' });
const view = await transferCanvas(canvas, worker, { data: { level: 'plaza' } });

// Later: `view.dispose()` disposes the engine in the worker, then the worker is yours to end.
addEventListener('pagehide', () => {
  view.dispose();
  worker.terminate();
});
```

```ts
// scene-worker.ts
import { box, Engine, PbrMaterial } from '@margoengine/core';
import { OrbitControls } from '@margoengine/controls';
import { receiveCanvas } from '@margoengine/worker/canvas';

const received = await receiveCanvas();
const engine = await Engine.create(received.canvas);
received.attach(engine);
engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#84d6bd' }));
const controls = new OrbitControls(engine.camera, received.canvas);
engine.onFrame((_, delta) => controls.update(delta));
engine.start();
```

## Page side

`transferCanvas(canvas, worker, options)` resolves with a `WorkerCanvas` once the worker holds the canvas. Either side may start first.

| Option | Default | Meaning |
| --- | --- | --- |
| `data` | `undefined` | Anything structured clone accepts, read in the worker as `received.data`. |
| `transfer` | `[]` | Objects in `data` to transfer instead of copy. |
| `signal` | none | Aborts the wait. A canvas that had not moved yet stays usable. |
| `timeout` | `30000` | Milliseconds to wait for the worker to call `receiveCanvas`. |

It rejects with a `MargoError` whose `code` is `unsupported` (the browser cannot move a canvas), `state` (the canvas has a context or already moved), `failed` (the worker's script failed) or `timeout`.

`view.dispose()`, or `using`, stops forwarding, aborts `received.signal` and disposes an engine that used `received`. A canvas cannot come back from a worker, and the worker keeps running until you call `worker.terminate()`. `workerCanvasSupported()` says whether the browser can do this at all.

Your own `worker.postMessage` traffic is left alone: the link runs on a `MessageChannel` of its own after a short handshake whose messages carry the key `margo-worker-canvas`. Errors in the worker reach `worker.addEventListener('error', ...)`; the engine's default `onError` reports them there.

## Worker side

`receiveCanvas({signal, timeout})` resolves with a `ReceivedCanvas`:

| Member | Meaning |
| --- | --- |
| `canvas` | The `OffscreenCanvas`, with `clientWidth`, `clientHeight`, `getBoundingClientRect`, `style` and the pointer capture methods of the page's canvas. Typed as an element, so it passes to `Engine.create` and to controls. |
| `data` | The page's `data` option. |
| `hidden` | True while the page is hidden. |
| `signal` | Aborts when the page disposes its end. |

`received.attach(engine)` makes the first frame after a background tab step 0, as on the page, and lets the page dispose the engine.

Because `clientWidth` follows the page and the page's `devicePixelRatio` and `margoLow` are copied to the worker, the engine picks the same drawing-buffer size as on the page, and `engine.pick` takes CSS pixels. With `exactSize` the worker owns `canvas.width` and `canvas.height`.

Input events arrive on `received.canvas`, as plain events with the values of the real ones (`clientX`, `pointerId`, `deltaY`, `key`, ...). The page only forwards a type once something in the worker listens for it. Pointer, mouse, wheel, click, context menu and focus events come from the canvas; key events come from the document, since an unfocused canvas gets none, and they land on `received.canvas`, which is where controls listen when an element has no document. A `style` written in the worker (`touchAction`, `cursor`) is set on the page's canvas.

## What differs from the page

- `event.preventDefault()` in a worker comes too late to change anything. The page stops the default of `wheel` and `contextmenu` for you once the worker listens for them, and of nothing else, so keys keep their browser meaning.
- The page captures the pointer on every `pointerdown` the worker listens for, so a drag goes on outside the canvas. `setPointerCapture` in the worker only records it.
- Pointer lock, `document` and anything else from the DOM stay on the page. `PointerLockControls` needs the page.
- `mount` from `@margoengine/stage` builds its canvas in a page. In a worker create the engine and pass it to `new Stage(engine)`.
- Input reaches the worker one message later, and a worker stuck in a long task reads it when the task ends.

## Browser support

The worker needs `OffscreenCanvas` and WebGPU (or WebGL2) in workers and `requestAnimationFrame` in workers. Proved on Chromium (`npm run test:gpu` in this package, real GPU); other browsers follow the same standards but have not been run. Keep a page path behind `workerCanvasSupported()` for browsers without them.
