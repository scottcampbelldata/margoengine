// Owner/lifetime fixture for @margoengine/inspector. Every panel and tool here attaches to an engine (an engine plugin
// through `attach`, or an object tied to the app's AbortSignal) and holds listeners (on its own elements, the canvas, the
// page's window and the app's signal), timers (the package editor's refresh, the shader editor's debounce, the remote
// target's stats interval), mounted DOM and, for the frame debugger and texture capture, patches on the engine's device.
// After disposal all of it must be gone: no listener, no element left in the page, the device's own methods back, the
// app's signal untouched. The DOM entries need the page's window and document, so they run in the browser leaves only
// (Node has no page; jsdom's event targets are not the ones the observer patches). FrameDebugger (no panel) and the
// remote target and viewer run in Node too. Not entries: `/gl` is WebGL2-only (GLInspector and captureGLFrame throw on
// the WebGPU engine these cases run on; test/gl-browser.mjs covers them); `describeEngine`, `snapshotMeshes`,
// `restoreSnapshot`, `parseSnapshot`, `describeObject`, `findPackageObjects`, `editProperty`, `texelBytes`,
// `textureBytes`, `recompileShader` and `captureGLFrame` hold nothing after they return, and `createRemoteRelay` (an HTTP
// server) is its own Node entry below.
import { PbrMaterial, box } from '../../core/dist/index.js';
import { ownedByEngine, lifetimeFault, watchTimers } from '../../../tests/support/owner-shell.js';

const page = !!globalThis.document?.body;

export async function fixtures(load = (entry) => import(entry)) {
  const { Inspector } = await load('../dist/index.js');
  const { FrameDebugger } = await load('../dist/frame.js');
  const { RemoteTarget, RemoteInspector, channelTransport } = await load('../dist/remote.js');
  const { MeshDebugView } = await load('../dist/mesh-debug.js');
  const entries = [];

  entries.push({
    // Patches on the engine's device (to count buffers and textures) and a frame-capture session; the device's own
    // methods are back after disposal.
    name: 'FrameDebugger',
    create({ engine }) {
      const device = engine.gpu,
        before = device?.createBuffer;
      const debug = FrameDebugger.attach(engine, { parent: null });
      return {
        plugin: debug,
        dispose: () => debug.dispose(),
        check({ phase }) {
          if (phase === 'disposed' && device && device.createBuffer !== before)
            lifetimeFault('a disposed debugger restores the device');
        },
      };
    },
  });

  entries.push({
    // The target's stats interval and its listener on the channel; the viewer's pending requests.
    name: 'RemoteTarget',
    create({ engine, dependency }) {
      // Two ends of an in-process channel made of plain event targets (a Node MessagePort carries listeners of its own).
      const end = () =>
        Object.assign(new EventTarget(), {
          peer: null,
          postMessage(data) {
            queueMicrotask(() => this.peer.dispatchEvent(new MessageEvent('message', { data })));
          },
        });
      const near = end(),
        far = end(),
        timers = watchTimers();
      near.peer = far;
      far.peer = near;
      const target = timers.scope(() =>
        RemoteTarget.attach(engine, {
          transport: channelTransport(near),
          token: 'owner-lifetime-token',
          statsIntervalMs: 100,
        }),
      );
      // The page on the other end is the app's, released after the checks.
      const viewer = dependency(
        () => new RemoteInspector({ transport: channelTransport(far), token: 'owner-lifetime-token', parent: null }),
      );
      return {
        plugin: target,
        dispose: () => target.dispose(),
        cleanup: () => viewer.dispose(),
        check({ phase }) {
          if (phase === 'disposed') timers.expectNone('RemoteTarget');
        },
      };
    },
  });

  // The view's uniform and storage copies go with it; the mesh it draws is the caller's.
  for (const factory of [false, true])
    entries.push({
      name: 'MeshDebugView' + (factory ? '.attach' : ''),
      create({ engine, scene, dependency }) {
        const mesh = dependency(() =>
          scene
            .createMesh()
            .setGeometry(box(1, 1, 1))
            .setMaterial(new PbrMaterial()),
        );
        let plugin;
        if (factory) plugin = MeshDebugView.attach(engine, { mode: 'material-ids' });
        else scene.use((plugin = new MeshDebugView()));
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
      },
    });

  if (!page && typeof process !== 'undefined' && process.versions?.node) {
    const { createRemoteRelay } = await load('../dist/remote-relay.js');
    entries.push({
      name: 'createRemoteRelay',
      async create({ scene }) {
        const relay = await createRemoteRelay({ port: 0 });
        return ownedByEngine(scene, 'createRemoteRelay', () => relay.close());
      },
    });
  }

  if (!page) return entries;

  const { SceneEditor } = await load('../dist/edit.js');
  const { InspectorGizmo } = await load('../dist/gizmo.js');
  const { TweakPanel } = await load('../dist/tweak.js');
  const { PackageEditor } = await load('../dist/packages.js');
  const { ShaderEditor } = await load('../dist/shaders.js');
  const { CameraTools } = await load('../dist/tools.js');
  const { AnimationPanel } = await load('../dist/animation.js');
  const { TextureCapture, TextureViewer } = await load('../dist/textures.js');

  // A panel is mounted in a host the app made; after release nothing of it may stay in the page.
  const host = () => {
    const element = document.createElement('div');
    document.body.append(element);
    return element;
  };
  // An Inspector (a panel, a Lines overlay, the engine's click picking) is the app's dependency of the tools on top.
  // Its own host, so the panel under test is the only thing in its parent; the host goes with the inspector.
  // Its timers are the dependency's: recorded under a scope of their own, not the panel's.
  const inspector = (engine, _parent, dependency) =>
    watchTimers().scope(() =>
      dependency(() => {
        const own = host(),
          view = Inspector.attach(engine, { parent: own }),
          dispose = view.dispose.bind(view);
        view.dispose = () => {
          dispose();
          own.remove();
        };
        return view;
      }),
    );
  const panel = (name, make) =>
    entries.push({
      name,
      detachedNodes: 'a panel takes its own elements out of the page, with the listeners on them',
      create({ engine, scene, dependency }) {
        const parent = host(),
          controller = new AbortController(),
          timers = watchTimers();
        const made = timers.scope(() => make({ engine, scene, parent, signal: controller.signal, dependency }));
        const release = () => timers.scope(() => made.release());
        return ownedByEngine(scene, name, release, {
          dependencies: made.dependencies,
          cleanup() {
            made.cleanup?.();
            parent.remove();
          },
          check({ phase }) {
            if (phase !== 'disposed') return;
            if (parent.children.length) lifetimeFault(`a disposed ${name} leaves its panel mounted`);
            if (controller.signal.aborted) lifetimeFault(`${name} aborts the app signal`);
            timers.expectNone(name);
          },
        });
      },
    });

  panel('Inspector', ({ engine, scene, parent }) => {
    const mesh = scene
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setMaterial(new PbrMaterial());
    const view = Inspector.attach(engine, { parent, effects: { exposure: 0, bloom: 0.5 } });
    return {
      release: () => {
        view.dispose();
        mesh.dispose();
      },
    };
  });
  panel('InspectorGizmo', ({ engine, parent, signal, dependency }) => {
    const view = inspector(engine, parent, dependency),
      gizmo = InspectorGizmo.attach(engine, view, { signal });
    return { release: () => gizmo.dispose(), cleanup: () => view.dispose(), dependencies: [view] };
  });
  panel('SceneEditor', ({ engine, parent, signal, dependency }) => {
    const view = inspector(engine, parent, dependency),
      editor = SceneEditor.attach(engine, view, { signal });
    return { release: () => editor.dispose(), cleanup: () => view.dispose(), dependencies: [view] };
  });
  panel('TweakPanel', ({ parent, signal }) => {
    const settings = { exposure: 1, name: 'a', on: true },
      tweak = new TweakPanel({ parent, signal, title: 'Owner' });
    tweak.add(settings, 'exposure', { min: 0, max: 2 });
    tweak.add(settings, 'on');
    tweak.addFolder('more').add(settings, 'name');
    return { release: () => tweak.dispose() };
  });
  panel('PackageEditor', ({ engine, parent, dependency }) => {
    const view = inspector(engine, parent, dependency),
      settings = { gain: 1 };
    const editor = PackageEditor.attach(engine, { parent, history: view.history, objects: { Settings: settings } });
    return { release: () => editor.dispose(), cleanup: () => view.dispose(), dependencies: [view] };
  });
  panel('ShaderEditor', ({ engine, parent }) => {
    const editor = ShaderEditor.attach(engine, { parent, meshes: [] });
    return { release: () => editor.dispose() };
  });
  panel('CameraTools', ({ engine, parent }) => {
    const tools = CameraTools.attach(engine, { parent });
    return { release: () => tools.dispose() };
  });
  panel('AnimationPanel', ({ engine, parent, signal }) => {
    const animation = AnimationPanel.attach(engine, [], { parent, signal });
    return { release: () => animation.dispose() };
  });
  panel('TextureViewer', ({ engine, parent, signal }) => {
    const capture = TextureCapture.start({ gpu: null, signal });
    capture.watchDevice(engine.gpu);
    const viewer = TextureViewer.attach(capture, { parent, signal });
    return {
      release: () => {
        viewer.dispose();
        capture.dispose();
      },
    };
  });
  return entries;
}
