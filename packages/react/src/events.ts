import type { Engine, Mesh as EngineMesh } from '@margoengine/core/extension';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Frames, Listeners, MargoPointerEvent, PointerHandlers, Resources } from './internal.js';

/** Every pointer handler prop, in the order the README lists them. */
export const pointerKinds = [
  'onClick',
  'onDoubleClick',
  'onContextMenu',
  'onPointerDown',
  'onPointerUp',
  'onPointerMove',
  'onPointerOver',
  'onPointerOut',
  'onPointerEnter',
  'onPointerLeave',
  'onWheel',
  'onPointerMissed',
] as const satisfies readonly (keyof PointerHandlers)[];
type Kind = (typeof pointerKinds)[number];
type Dispatched = Exclude<Kind, 'onPointerMissed'>;
/** The DOM name of each handler's event, as `event.type`. */
const types: Record<Dispatched, string> = {
  onClick: 'click',
  onDoubleClick: 'dblclick',
  onContextMenu: 'contextmenu',
  onPointerDown: 'pointerdown',
  onPointerUp: 'pointerup',
  onPointerMove: 'pointermove',
  onPointerOver: 'pointerover',
  onPointerOut: 'pointerout',
  onPointerEnter: 'pointerenter',
  onPointerLeave: 'pointerleave',
  onWheel: 'wheel',
};

/** True when `props` holds any pointer handler. */
export function hasPointerHandlers(props: PointerHandlers): boolean {
  for (const kind of pointerKinds) if (props[kind]) return true;
  return false;
}
/** Splits `props` into its pointer handlers and the rest, for components that pass the handlers to a `<Mesh>`. */
export function splitPointerHandlers<P extends PointerHandlers>(props: P): [PointerHandlers, Omit<P, Kind>] {
  const handlers: PointerHandlers = {},
    rest = { ...props };
  for (const kind of pointerKinds)
    if (kind in rest) {
      (handlers as Record<Kind, unknown>)[kind] = rest[kind];
      delete rest[kind];
    }
  return [handlers, rest];
}
/**
 * One handlers record for the life of a mount, reading the current props through `latest`, so a new handler function
 * needs no re-registration. `owner` is the mesh handlers see as `currentTarget` (a model's root for all its nodes).
 */
export function liveHandlers(latest: { readonly current: PointerHandlers }, owner?: MeshHandle): Listeners {
  const listeners: Listeners = { owner };
  for (const kind of pointerKinds)
    Object.defineProperty(listeners, kind, { enumerable: true, get: () => latest.current[kind] });
  return listeners;
}

interface Request {
  x: number;
  y: number;
  /** Set for a captured pointer: the target without a pick. */
  fixed?: EngineMesh | null;
  /** `known` is false when nothing could be picked (no handler wants it, or the backend cannot pick). */
  receive: (mesh: EngineMesh | null, known: boolean) => void;
}
/** Nearest first: the hit mesh, then each parent, as [mesh, its handlers] (a handlers record once, at its first mesh). */
type Path = [EngineMesh, Listeners][];

/**
 * Wires the canvas's DOM pointer events to the mesh handlers: one GPU pick per event (a burst of moves, or of wheel
 * turns, collapses to the latest), then the event goes to the hit mesh and bubbles up its parents, as the DOM's does,
 * until a handler calls `stopPropagation()`. Returns the cleanup.
 */
export function attachPointerEvents(
  engine: Engine,
  element: HTMLCanvasElement,
  handlers: Map<number, Listeners>,
  resources: Resources,
  frames: Frames,
  canPickHere: () => boolean,
  missed: () => ((event: PointerEvent) => void) | undefined,
): () => void {
  let active = true,
    hover: EngineMesh | null = null,
    hoverRequest = 0,
    picking = false,
    pendingHover: Request | null = null,
    pendingWheel: Request | null = null;
  let down: { id: number; x: number; y: number; movement: number; hit: EngineMesh | null; primary: boolean } | null =
    null;
  const ordered: Request[] = [],
    captures = new Map<number, EngineMesh>(),
    pressed = new Set<number>();
  const alive = (mesh: EngineMesh | null): mesh is EngineMesh =>
    !!mesh && !engine.disposed && engine.meshes.get(mesh.id) === mesh;
  const parentOf = (mesh: EngineMesh) => {
    const id = engine.store.parents[mesh.id];
    return id >= 0 ? (engine.meshes.get(id) ?? null) : null;
  };
  /** The mesh and each of its parents, nearest first. */
  const ancestors = (mesh: EngineMesh | null) => {
    const list: EngineMesh[] = [];
    for (let node = alive(mesh) ? mesh : null; node; node = parentOf(node)) list.push(node);
    return list;
  };
  const path = (mesh: EngineMesh | null): Path => {
    const list: Path = [],
      seen = new Set<Listeners>();
    for (const node of ancestors(mesh)) {
      const record = handlers.get(node.id);
      if (record && !seen.has(record)) {
        seen.add(record);
        list.push([node, record]);
      }
    }
    return list;
  };
  // engine.pick and the handlers' x/y are relative to the padding box (the box clientWidth measures), while
  // getBoundingClientRect is the border box (CSSOM View), so the border widths come off.
  const coordinates = (event: MouseEvent) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left - (element.clientLeft || 0),
      y: event.clientY - bounds.top - (element.clientTop || 0),
    };
  };
  const pointerOf = (event: MouseEvent) => ('pointerId' in event ? (event as PointerEvent).pointerId : 1);
  /** Calls `kind` on each entry of `list` in order, stopping after a handler that stops propagation. */
  const fire = (kind: Dispatched, hit: EngineMesh, event: MouseEvent, list: Path, delta = 0) => {
    let stopped = false;
    const point = coordinates(event),
      object = hit as unknown as MeshHandle;
    for (const [node, record] of list) {
      const handler = record[kind] as ((event: MargoPointerEvent<MouseEvent>) => void) | undefined;
      if (!handler) continue;
      const current = record.owner ?? (node as unknown as MeshHandle),
        pointer = pointerOf(event);
      handler({
        type: types[kind],
        nativeEvent: event,
        object,
        mesh: object,
        target: object,
        currentTarget: current,
        eventObject: current,
        clientX: event.clientX,
        clientY: event.clientY,
        ...point,
        delta,
        get stopped() {
          return stopped;
        },
        stopPropagation() {
          stopped = true;
        },
        setPointerCapture() {
          // Picking is asynchronous: a pointer already released has nothing left to capture.
          if (!pressed.has(pointer)) return;
          captures.set(pointer, node);
          element.setPointerCapture(pointer);
        },
        releasePointerCapture() {
          if (captures.get(pointer) !== node) return;
          captures.delete(pointer);
          if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
        },
        hasPointerCapture() {
          return captures.get(pointer) === node;
        },
      });
      if (stopped || engine.disposed) return;
    }
  };
  const bubble = (kind: Dispatched, hit: EngineMesh | null, event: MouseEvent, delta = 0) => {
    if (alive(hit)) fire(kind, hit, event, path(hit), delta);
  };
  const setHover = (mesh: EngineMesh | null, event: MouseEvent) => {
    if (hover === mesh) return;
    const previous = alive(hover) ? hover : null,
      from = path(previous),
      to = path(mesh);
    hover = mesh;
    const leaving = from.filter(([, record]) => !to.some(([, other]) => other === record)),
      entering = to.filter(([, record]) => !from.some(([, other]) => other === record));
    // The DOM's order: out on the old target (bubbling), leave on each left element from the deepest, then over on the
    // new target (bubbling) and enter on each entered element from the outermost.
    if (previous) {
      fire('onPointerOut', previous, event, from);
      for (const entry of leaving) fire('onPointerLeave', previous, event, [entry]);
    }
    if (alive(mesh)) {
      fire('onPointerOver', mesh, event, to);
      for (const entry of entering.reverse()) fire('onPointerEnter', mesh, event, [entry]);
    }
  };
  const nextPick = () => {
    if (picking || !active || engine.disposed) return;
    const request = ordered.shift() ?? pendingHover ?? pendingWheel;
    if (!request) return;
    if (request === pendingHover) pendingHover = null;
    if (request === pendingWheel) pendingWheel = null;
    picking = true;
    let known = true;
    // One request at a time: presses and clicks keep their order, and a burst of moves or wheel turns collapses.
    void Promise.resolve()
      .then(async () => {
        if (request.fixed !== undefined) return request.fixed;
        if (!active || engine.disposed || !canPickHere()) {
          known = false;
          return null;
        }
        if (resources.models.size) await resources.picking?.prepare(engine, resources, frames);
        return active && !engine.disposed ? engine.pick(request.x, request.y) : null;
      })
      .then((mesh) => {
        if (active && !engine.disposed) request.receive(mesh, known);
      })
      .catch((error) => {
        if (active && !engine.disposed) engine.onError(error);
      })
      .finally(() => {
        picking = false;
        nextPick();
      });
  };
  type Slot = 'ordered' | 'hover' | 'wheel';
  /** The mesh holding `pointer`'s capture while it is pressed, else undefined. */
  const capturedBy = (pointer: number) => (pressed.has(pointer) ? captures.get(pointer) : undefined);
  const pick = (slot: Slot, event: MouseEvent, receive: Request['receive'], fixed = capturedBy(pointerOf(event))) => {
    const captured = fixed;
    if (!captured && !canPickHere()) {
      receive(null, false);
      return;
    }
    const request: Request = { ...coordinates(event), receive, fixed: captured };
    if (slot === 'ordered') ordered.push(request);
    else if (slot === 'hover') pendingHover = request;
    else pendingWheel = request;
    nextPick();
  };
  const move = (event: PointerEvent) => {
    if (!down || down.id !== event.pointerId) return;
    down.movement += Math.hypot(event.clientX - down.x, event.clientY - down.y);
    down.x = event.clientX;
    down.y = event.clientY;
  };
  const release = (pointer: number) => {
    pressed.delete(pointer);
    captures.delete(pointer);
  };
  const pointerdown = (event: PointerEvent) => {
    pressed.add(event.pointerId);
    const press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      movement: 0,
      hit: null as EngineMesh | null,
      primary: event.button === 0 && event.isPrimary !== false,
    };
    if (press.primary) down = press;
    pick('ordered', event, (mesh) => {
      press.hit = mesh;
      bubble('onPointerDown', mesh, event);
    });
  };
  const pointerup = (event: PointerEvent) => {
    const pointer = event.pointerId,
      press = down?.id === pointer ? down : null,
      captured = capturedBy(pointer);
    if (press) {
      move(event);
      down = null;
    }
    // The release goes to the capturing mesh; events sent after it are not captured. Events sent before it still are
    // when their picks finish later, so the capture itself ends once the release has been delivered.
    pressed.delete(pointer);
    pick(
      'ordered',
      event,
      (mesh, known) => {
        bubble('onPointerUp', mesh, event, press?.movement ?? 0);
        if (!pressed.has(pointer) && captures.get(pointer) === captured) captures.delete(pointer);
        // Without a pick nobody knows what the click hit, so nothing is missed either.
        if (!known || !press?.primary || press.movement > 3) return;
        // The click goes to the nearest mesh both the press and the release hit, or their nearest shared parent.
        const pressedOn = ancestors(press.hit),
          target = ancestors(mesh).find((node) => pressedOn.includes(node));
        const list = target ? path(target) : [];
        if (target) fire('onClick', mesh!, event, list, press.movement);
        for (const record of new Set(handlers.values()))
          if (record.onPointerMissed && !list.some(([, other]) => other === record)) record.onPointerMissed(event);
        if (!alive(mesh)) missed()?.(event);
      },
      captured,
    );
  };
  const pointermove = (event: PointerEvent) => {
    move(event);
    const request = ++hoverRequest,
      captured = capturedBy(event.pointerId) !== undefined;
    pick(captured ? 'ordered' : 'hover', event, (mesh) => {
      // The DOM's order: over and enter first, then the move.
      if (!captured && request === hoverRequest) setHover(mesh, event);
      bubble('onPointerMove', mesh, event, down?.id === event.pointerId ? down.movement : 0);
    });
  };
  const pointerleave = (event: PointerEvent) => {
    ++hoverRequest;
    pendingHover = null;
    if (capturedBy(event.pointerId)) return;
    if (down?.id === event.pointerId) down = null;
    setHover(null, event);
  };
  const pointercancel = (event: PointerEvent) => {
    if (down?.id === event.pointerId) down = null;
    release(event.pointerId);
    pointerleave(event);
  };
  const dblclick = (event: MouseEvent) => pick('ordered', event, (mesh) => bubble('onDoubleClick', mesh, event));
  const contextmenu = (event: MouseEvent) => pick('ordered', event, (mesh) => bubble('onContextMenu', mesh, event));
  const wheel = (event: WheelEvent) => pick('wheel', event, (mesh) => bubble('onWheel', mesh, event));
  const listeners = { pointerdown, pointerup, pointermove, pointerleave, pointercancel, dblclick, contextmenu, wheel };
  for (const [name, listener] of Object.entries(listeners))
    element.addEventListener(name, listener as EventListener, name === 'wheel' ? { passive: true } : undefined);
  return () => {
    active = false;
    ++hoverRequest;
    down = null;
    hover = null;
    pendingHover = null;
    pendingWheel = null;
    ordered.length = 0;
    captures.clear();
    pressed.clear();
    for (const [name, listener] of Object.entries(listeners))
      element.removeEventListener(name, listener as EventListener);
  };
}
