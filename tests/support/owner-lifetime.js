// Clean-room lifecycle model shared by inert and real-GPU adapters. No package-specific assertions live here.
export function invariant(ok, message) {
  if (!ok) throw new Error(`OWNER_LIFETIME: ${message}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A view's own state: numbers, strings and number arrays by value, every object (a camera, a device on the WebGL2
// layer) by identity. JSON would throw on the device's cycles and miss a swapped object.
export const viewState = (view) => view && Object.entries(view).map(([key, value]) =>
  [key, Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : value]);
export const sameView = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every(([key, value], i) =>
  key === b[i][0] && (Array.isArray(value) ? same(value, b[i][1]) : Object.is(value, b[i][1]))));

export class LifetimeObserver {
  owner = null;
  context = null;
  resources = new Set();
  listeners = new Set();
  undo = [];
  draws = 0;
  hooks = new Set();
  executions = 0;
  executionCounts = new Map();
  watched = new WeakSet();
  devices = new WeakSet();
  scope(owner, fn) {
    const previous = this.owner;
    this.owner = owner;
    try {
      return fn();
    } finally {
      this.owner = previous;
    }
  }
  // An async factory keeps its owner until it settles: work after its first await (constructors, buffers,
  // listeners, plugin registration) belongs to it. The harness starts nothing else while one is pending.
  async hold(owner, start) {
    const previous = this.owner;
    this.owner = owner;
    try {
      return await start();
    } finally {
      this.owner = previous;
    }
  }
  patch(object, name, replace) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    const original = object[name];
    object[name] = replace(original);
    this.undo.push(() => {
      if (descriptor) Object.defineProperty(object, name, descriptor);
      else delete object[name];
    });
  }
  watchEvents(prototype = EventTarget.prototype) {
    const observer = this;
    const nativeAdd = prototype.addEventListener, nativeRemove = prototype.removeEventListener;
    const capture = (options) => typeof options === 'boolean' ? options : !!options?.capture;
    const find = (target, type, listener, options) => [...observer.listeners].find((r) =>
      r.target === target && r.type === type && r.listener === listener && r.capture === capture(options));
    const forget = (record) => {
      observer.listeners.delete(record);
      if (record.signal) nativeRemove.call(record.signal, 'abort', record.abort);
    };
    this.patch(prototype, 'addEventListener', () => function (type, listener, options) {
      if (!listener || options?.signal?.aborted) return nativeAdd.call(this, type, listener, options);
      const prior = find(this, type, listener, options);
      if (prior) return nativeAdd.call(this, type, prior.wrapped, options);
      if (!observer.owner) return nativeAdd.call(this, type, listener, options);
      const record = { target: this, type, listener, capture: capture(options), owner: observer.owner,
        signal: options?.signal };
      record.wrapped = function (event) {
        if (options?.once) forget(record);
        return observer.scope(record.owner, () => typeof listener === 'function'
          ? listener.call(this, event) : listener.handleEvent(event));
      };
      record.abort = () => forget(record);
      nativeAdd.call(this, type, record.wrapped, options);
      observer.listeners.add(record);
      if (record.signal) nativeAdd.call(record.signal, 'abort', record.abort, { once: true });
    });
    this.patch(prototype, 'removeEventListener', () => function (type, listener, options) {
      const record = find(this, type, listener, options);
      nativeRemove.call(this, type, record?.wrapped ?? listener, options);
      if (record) forget(record);
    });
    // Failure cleanup is after the leak assertion, never a way to make it pass.
    this.undo.push(() => {
      for (const record of [...observer.listeners]) {
        nativeRemove.call(record.target, record.type, record.wrapped, record.capture);
        forget(record);
      }
    });
  }
  watchDevice(device) {
    if (!device || this.devices.has(device)) return;
    this.devices.add(device);
    const observer = this;
    for (const method of ['createBuffer', 'createTexture', 'createQuerySet']) {
      if (!device[method]) continue;
      this.patch(device, method, (original) => function (...args) {
        const object = original.apply(this, args);
        if (observer.owner) {
          const record = { object, device, owner: observer.owner, method };
          observer.resources.add(record);
          observer.patch(object, 'destroy', (destroy) => function (...values) {
            const result = destroy.apply(this, values);
            observer.resources.delete(record);
            return result;
          });
        }
        return object;
      });
    }
    this.patch(device, 'createCommandEncoder', (original) => function (...args) {
      const encoder = original.apply(this, args);
      const begin = encoder.beginRenderPass;
      encoder.beginRenderPass = function (descriptor) {
        const pass = begin.call(this, descriptor), context = observer.context;
        if (observer.owner && context && descriptor.colorAttachments?.some((a) => a?.view === context.color))
          observer.watchPass(pass, context);
        return pass;
      };
      return encoder;
    });
  }
  watchPass(pass, context) {
    const expected = context.view;
    if (!expected?.viewport) return;
    let viewport, scissor;
    const setViewport = pass.setViewport, setScissor = pass.setScissorRect;
    pass.setViewport = function (...args) { viewport = args; return setViewport.apply(this, args); };
    pass.setScissorRect = function (...args) { scissor = args; return setScissor.apply(this, args); };
    for (const method of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
      if (!pass[method]) continue;
      const original = pass[method], observer = this;
      pass[method] = function (...args) {
        invariant(same(viewport, [...expected.viewport, 0, 1]), 'draw restores the current viewport');
        invariant(same(scissor, expected.scissor ?? expected.viewport), 'draw restores the current scissor');
        observer.draws++;
        return original.apply(this, args);
      };
    }
  }
  watchEngine(engine, owner) {
    this.watchDevice(engine.gpu);
    const observer = this;
    this.patch(engine, 'use', (original) => function (plugin, ...args) {
      observer.watchPlugin(plugin, observer.owner ?? owner);
      return original.call(this, plugin, ...args);
    });
  }
  watchPlugin(plugin, owner) {
    if (this.watched.has(plugin)) return;
    this.watched.add(plugin);
    for (const method of ['setup', 'onPreUpdate', 'onDeviceRestored', 'dispose']) {
      if (!plugin[method]) continue;
      const observer = this;
      this.patch(plugin, method, (original) => function (...args) {
        observer.hooks.add(method);
        if (method === 'onDeviceRestored') observer.watchDevice(args[0]?.gpu);
        return observer.scope(owner, () => original.apply(this, args));
      });
    }
  }
  watchScene(scene, owner) {
    const observer = this;
    this.patch(scene.frameGraph, 'add', (original) => function (entry) {
      const execute = entry.execute, registeredOwner = observer.owner ?? owner;
      return original.call(this, { ...entry, execute(context) {
        observer.executions++;
        observer.executionCounts.set(registeredOwner, (observer.executionCounts.get(registeredOwner) ?? 0) + 1);
        const previous = observer.context, view = viewState(context.view);
        observer.context = context;
        try {
          return observer.scope(registeredOwner, () => execute(context));
        } finally {
          observer.context = previous;
          invariant(sameView(viewState(context.view), view), `${entry.name} preserves view state`);
        }
      } });
    });
  }
  lost(device) {
    for (const record of this.resources) if (record.device === device) this.resources.delete(record);
  }
  assertReleased(owner) {
    invariant(![...this.listeners].some((r) => r.owner === owner), 'no leaked event listeners');
    invariant(![...this.resources].some((r) => r.owner === owner), 'no leaked GPU buffers, textures or query sets');
  }
  close() {
    for (const record of [...this.resources]) record.object.destroy();
    for (const undo of this.undo.reverse()) undo();
    this.undo.length = 0;
  }
}

// Each case has independent engines; a failure cannot contaminate a following case.
export const lifecycleCases = ['direct', 'detach', 'scene', 'engine', 'loss-attached', 'loss-detached'];
export async function exerciseLifetime(fixture, adapter, { target = 'secondary', mode = 'direct' } = {}) {
  const observer = new LifetimeObserver(), token = {}, peerToken = {}, dependencyToken = {}, hosts = [];
  let handle, peer;
  observer.watchEvents();
  try {
    for (let i = 0; i < 2; i++) hosts.push(await adapter.create());
    const [host, foreign] = hosts, { engine } = host;
    const scene = target === 'default' ? engine.scene : engine.createScene('owner-lifetime');
    const other = target === 'default' ? engine.createScene('neighbor') : engine.scene;
    observer.watchEngine(engine, token);
    observer.watchScene(scene, token);
    observer.watchEngine(foreign.engine, peerToken);
    observer.watchScene(foreign.engine.scene, peerToken);
    const dependency = (fn) => observer.scope(dependencyToken, fn);
    let pendingPeer;
    const peerScope = { name: 'owner-lifetime:peer', setup() {
      pendingPeer = observer.scope(peerToken, () => fixture.create({ engine: foreign.engine,
        scene: foreign.engine.scene, host: foreign, dependency }));
    } };
    peer = await observer.hold(peerToken, () => {
      foreign.engine.use(peerScope);
      foreign.engine.removePlugin(peerScope.name);
      return pendingPeer;
    });
    invariant(peer && typeof peer.dispose === 'function', `${fixture.name} provides peer disposal`);
    if (peer.plugin && !foreign.engine.sceneOf(peer.plugin)) foreign.engine.use(peer.plugin);
    const peerInstalled = [...foreign.engine.plugins.values()].filter((p) => !peer.dependencies?.includes(p));
    invariant(peerInstalled.length > 0, 'second engine exercises a real instance');
    const initial = new Map(scene.plugins), neighbors = new Map(other.plugins);
    const views = [
      { id: 'owner-a', scene, camera: engine.camera, viewport: [0, 0, 32, 32], scissor: [0, 0, 16, 32], pixels: true },
      { id: 'owner-b', scene, camera: host.camera(), viewport: [32, 0, 32, 32], scissor: [40, 0, 16, 32], pixels: true },
    ];
    await host.render(views);
    const baseline = await host.pixels?.();
    let pending;
    const scope = { name: 'owner-lifetime:create', setup() {
      pending = observer.scope(token, () => fixture.create({ engine, scene, host, dependency }));
    } };
    handle = await observer.hold(token, () => {
      scene.use(scope);
      scene.removePlugin(scope.name);
      return pending;
    });
    invariant(handle && typeof handle.dispose === 'function', `${fixture.name} provides dispose`);
    if (handle.plugin && !engine.sceneOf(handle.plugin)) scene.use(handle.plugin);
    if (handle.plugin) invariant(engine.sceneOf(handle.plugin) === scene, 'async factory retains its originating scene');
    const installed = [...scene.plugins.values()].filter((p) => !initial.has(p.name) && !handle.dependencies?.includes(p));
    invariant(installed.length > 0, `${fixture.name} exercises a real registration`);
    const sentinels = installed.map((p) => ({ name: p.name, setup() {}, dispose() {
      this.removed = true;
    } }));
    for (const sentinel of sentinels) {
      other.use(sentinel);
      if (!foreign.engine.plugins.has(sentinel.name)) foreign.engine.use({ name: sentinel.name, setup() {} });
    }
    const foreignRegistry = [...foreign.engine.plugins];
    const render = async () => {
      const foreignCamera = Array.from(foreign.engine.camera.position);
      await host.render(views);
      // A foreign scene is drawn too, then both owner views again. Stable ids retain per-view histories.
      await host.render([{ scene: other, camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true }]);
      await host.render(views.toReversed());
      if (baseline) {
        const pixels = await host.pixels();
        let visible = 0;
        for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
          const inside = views.some(({ scissor: [sx, sy, sw, sh] }) => x >= sx && x < sx + sw && y >= sy && y < sy + sh);
          const i = (y * 64 + x) * 4;
          for (let c = 0; c < 4; c++) {
            if (!inside) invariant(pixels[i + c] === baseline[i + c],
              `no pixel writes outside either view scissor (${x},${y},${c}: ${baseline[i + c]} -> ${pixels[i + c]})`);
            else visible += pixels[i + c] !== baseline[i + c];
          }
        }
        if (fixture.visible && engine.sceneOf(handle.plugin)) invariant(visible > 0, 'fixture changes real visible pixels');
      }
      invariant(engine.plugins === engine.scene.plugins, 'render restores the active scene');
      invariant(foreign.engine.plugins.size === foreignRegistry.length &&
        foreignRegistry.every(([name, plugin]) => foreign.engine.plugins.get(name) === plugin), 'no cross-engine registration changes');
      invariant(same(Array.from(foreign.engine.camera.position), foreignCamera), 'no cross-engine camera writes');
      await foreign.render([{ camera: foreign.engine.camera, viewport: [0, 0, 64, 32],
        scissor: [8, 0, 48, 32], pixels: true }]);
      for (const sentinel of sentinels)
        invariant(other.plugins.get(sentinel.name) === sentinel && !sentinel.removed, 'same-name neighbor survives');
      await handle.check?.({ phase: 'render', host, views });
    };
    await render();
    if (mode === 'loss-attached') {
      await host.lose(observer);
      await render();
      for (const plugin of installed) invariant(engine.sceneOf(plugin) === scene, 'restore retains the owner');
    }
    if (mode === 'detach') for (const plugin of installed) scene.removePlugin(plugin.name);
    else if (mode === 'scene') scene.dispose();
    else if (mode === 'engine') engine.dispose();
    else handle.dispose();
    for (const plugin of installed) invariant(!engine.sceneOf(plugin), `${fixture.name} releases its registration`);
    // A dependency may own lazily allocated shared pages. Its caller lifetime ends at cleanup, below.
    if (!handle.dependencies?.length) observer.assertReleased(token);
    if (mode !== 'engine' && !(target === 'default' && mode === 'scene')) {
      for (const sentinel of sentinels)
        invariant(other.plugins.get(sentinel.name) === sentinel && !sentinel.removed, 'disposal preserves neighbor identity');
    }
    if (!['scene', 'engine'].includes(mode)) {
      const replacements = installed.map((p) => ({ name: p.name, setup() {} }));
      for (const replacement of replacements) scene.use(replacement);
      handle.dispose();
      if (mode === 'loss-detached') await host.lose(observer);
      const executions = observer.executionCounts.get(token) ?? 0;
      // Check the detached graph alone; the peer still has its own live passes.
      await host.render(views);
      invariant((observer.executionCounts.get(token) ?? 0) === executions, 'no retained frame graph passes after disposal');
      await render();
      for (const replacement of replacements)
        invariant(scene.plugins.get(replacement.name) === replacement, 'stale disposal preserves replacement');
      for (const replacement of replacements) scene.removePlugin(replacement.name);
      if (!handle.dependencies?.length) observer.assertReleased(token);
    }
    if (fixture.viewDraws) invariant(observer.draws > 0, `${fixture.name} exercised viewport/scissor draws`);
    invariant(scene.plugins.size === (mode === 'scene' || mode === 'engine'
      ? 0 : initial.size + (handle.dependencies?.length ?? 0)), 'no extra registrations');
    invariant(other.plugins.size === (mode === 'engine' ? 0 : neighbors.size + sentinels.length), 'no neighbor leaks');
    await handle.check?.({ phase: 'disposed', host, views });
    for (const plugin of peerInstalled)
      invariant(foreign.engine.sceneOf(plugin) === foreign.engine.scene, 'peer instance survives owner disposal');
    peer.dispose();
    for (const plugin of peerInstalled) invariant(!foreign.engine.sceneOf(plugin), 'peer releases registration');
    await peer.cleanup?.();
    await handle.cleanup?.();
    observer.assertReleased(token);
    observer.assertReleased(peerToken);
    observer.assertReleased(dependencyToken);
    return { fixture: fixture.name, target, mode, draws: observer.draws, hooks: [...observer.hooks] };
  } finally {
    try {
      for (const host of hosts) host.engine.dispose();
      await handle?.cleanup?.();
      await peer?.cleanup?.();
    } finally {
      observer.close();
      for (const host of hosts) await host.close?.();
    }
  }
}
