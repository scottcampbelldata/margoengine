// Per-frame GPU resources for optional packages that draw one object for several views of a frame (viewports, probe
// faces). `queue.writeBuffer` runs before any command recorded but not yet submitted, so a uniform buffer rewritten
// for a later view would show its values to the earlier view's draws too; and a resource destroyed while a later view
// or a draw callback is recording is still referenced by the unsubmitted commands. Core records and submits a frame
// synchronously, without yielding, so a frame here is one synchronous JS task, closed by a microtask after the last
// submit. A frame with a single view behaves exactly like plain writes and destroys.
// Every package bundles its own copy of this module, so the state lives on globalThis, one per device: a resource
// retired by one package waits for a frame another package recorded on the same device, and a lost device's pending
// resources and uniform copies are dropped without touching any other device. Keep the shape.
const devices = (globalThis[Symbol.for('margoengine.frame-resources')] ??= { devices: new WeakMap() }).devices;

function stateOf(device) {
  let state = devices.get(device);
  if (!state) {
    devices.set(
      device,
      (state = {
        frame: 0,
        open: false,
        lost: false,
        views: new Set(),
        drawing: 0,
        retired: [],
        written: new WeakMap(),
      }),
    );
    // A lost device's resources are already invalid: nothing of it is destroyed or reused later.
    device.lost?.then?.(() => {
      state.lost = true;
      state.retired = [];
      state.written = new WeakMap();
    });
  }
  return state;
}

/** The current frame number on `device`, opening a frame when none is recording; `view` draws in it. */
export function currentFrame(device, view) {
  const state = stateOf(device);
  if (!state.open) {
    state.open = true;
    state.frame++;
    queueMicrotask(() => {
      state.open = false;
      state.views.clear();
      const list = state.retired;
      state.retired = [];
      for (const resource of list) resource.destroy();
    });
  }
  if (view) state.views.add(view);
  return state.frame;
}

/** True while a frame with more than one view records on `device`: an earlier view's commands still wait for submit. */
export function recording(device) {
  const state = devices.get(device);
  return !!state?.open && state.views.size > 1;
}

/** Marks a draw recording on `device` until `endDraw`, so a callback that releases resources meanwhile defers them. */
export function beginDraw(device, view) {
  currentFrame(device, view);
  stateOf(device).drawing++;
}
export function endDraw(device) {
  stateOf(device).drawing--;
}

/**
 * Destroys `resource`, created on `device`, together with the copies `writeUniform` made of it: at once, as a plain
 * destroy, unless commands that may use it still wait for the frame's submit (another view of this frame, or a draw in
 * progress); then at the end of the task.
 */
export function retire(device, resource) {
  if (!resource) return;
  const state = stateOf(device);
  if (state.lost) return;
  const list = [resource, ...(state.written.get(resource)?.extras ?? [])];
  state.written.delete(resource);
  if (state.open && (state.views.size > 1 || state.drawing > 0)) state.retired.push(...list);
  else for (const item of list) item.destroy();
}

/**
 * Writes one draw's uniform `data` (a Float32Array) for `view` (the pass context's view, else the context itself).
 * The first write of `buffer` in a frame, and every write from that same view, goes to `buffer` itself and returns
 * undefined, exactly as a plain `queue.writeBuffer`. A write with other values from another view of the same frame
 * (a second viewport, a probe face) goes to the n-th extra copy of `buffer` and returns its binding, so the earlier
 * view's draws keep their values. Copies are reused every frame and released with `retire(device, buffer)`.
 */
export function writeUniform(device, buffer, data, view) {
  const now = currentFrame(device, view),
    state = stateOf(device);
  let entry = state.written.get(buffer);
  if (entry?.values.length !== data.length) {
    if (entry) state.retired.push(...entry.extras);
    state.written.set(
      buffer,
      (entry = { frame: 0, view: undefined, uses: 0, values: new Float32Array(data.length), extras: [] }),
    );
  }
  let same = entry.frame === now && entry.view !== view;
  for (let i = 0; same && i < data.length; i++) same = entry.values[i] === data[i];
  if (entry.frame !== now || entry.view === view || same) {
    if (entry.frame !== now) Object.assign(entry, { frame: now, view, uses: 0 });
    entry.values.set(data);
    device.queue.writeBuffer(buffer, 0, data);
    return undefined;
  }
  const extra = (entry.extras[entry.uses++] ??= device.createBuffer({
    label: 'frame uniform copy',
    size: buffer.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  }));
  device.queue.writeBuffer(extra, 0, data);
  return { buffer: extra };
}

/**
 * Bind groups built around the uniform `buffer`: `make({ buffer })` runs at once, as a plain group would, and
 * `get(copy)` returns those groups, or for a `writeUniform` copy `make(copy)` built on its first use and cached, so
 * steady multi-view frames create no groups. Build a new set when the other resources in the groups change.
 */
export function uniformGroups(buffer, make) {
  const cache = new Map([[buffer, make({ buffer })]]);
  return {
    get(copy) {
      const target = copy?.buffer ?? buffer;
      let value = cache.get(target);
      if (!value) cache.set(target, (value = make({ buffer: target })));
      return value;
    },
  };
}
