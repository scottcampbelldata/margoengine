import type {Camera, EngineKernel} from '@margoengine/core';

/** The subset of an `HTMLElement` (normally the engine canvas) the controls use. Tests pass a plain object. */
export interface ControlElement {
  addEventListener(type: string, listener: (event: any) => void, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: (event: any) => void, options?: EventListenerOptions | boolean): void;
  readonly clientWidth: number;
  readonly clientHeight: number;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  hasPointerCapture?(pointerId: number): boolean;
  getBoundingClientRect?(): {left: number; top: number};
  style?: {touchAction: string};
  ownerDocument?: any;
  requestPointerLock?(): unknown;
}
/** Anything keyboard or document events can be listened on: an element, `document` or `window`. */
export interface EventTargetLike {
  addEventListener(type: string, listener: (event: any) => void, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: (event: any) => void, options?: EventListenerOptions | boolean): void;
}

export interface ControlEvent {type: string; target: unknown; [key: string]: unknown}
export type ControlListener = (event: ControlEvent) => void;

/** Minimal three.js-style `EventDispatcher`. */
export class EventDispatcher {
  private readonly handlers = new Map<string, Set<ControlListener>>();
  addEventListener(type: string, listener: ControlListener): void {
    let set = this.handlers.get(type); if (!set) this.handlers.set(type, set = new Set()); set.add(listener);
  }
  removeEventListener(type: string, listener: ControlListener): void {this.handlers.get(type)?.delete(listener);}
  hasEventListener(type: string, listener: ControlListener): boolean {return !!this.handlers.get(type)?.has(listener);}
  dispatchEvent(event: {type: string; [key: string]: unknown}): void {
    const set = this.handlers.get(event.type); if (!set) return;
    const full = {...event, target: this} as ControlEvent;
    for (const listener of [...set]) listener(full);
  }
}

type Binding = [EventTargetLike, string, (event: any) => void, AddEventListenerOptions | undefined];
let pluginCounter = 0;

const isEngine = (value: unknown): value is EngineKernel =>
  !!value && typeof value === 'object' && 'camera' in value && 'canvas' in value && typeof (value as EngineKernel).use === 'function';

/**
 * Shared base, mirroring three.js `Controls`: `connect`, `disconnect`, `enabled`, `update` and `dispose`.
 * Pass the engine to attach to its canvas and update automatically before each render, or pass a `Camera`
 * and an element and call `update(delta)` yourself.
 */
export abstract class Controls extends EventDispatcher {
  readonly camera: Camera;
  readonly engine: EngineKernel | null;
  element: ControlElement | null = null;
  enabled = true;
  private bindings: Binding[] = [];
  private pluginName: string | null = null;
  private disposed = false;

  constructor(source: Camera | EngineKernel, element?: ControlElement | null, autoUpdate = true) {
    super();
    if (isEngine(source)) {this.engine = source; this.camera = source.camera; element = element === undefined ? source.canvas as unknown as ControlElement : element;}
    else {
      if (!source || typeof source !== 'object' || !('position' in source) || !('target' in source)) throw new TypeError('Expected an Engine or a Camera');
      this.engine = null; this.camera = source;
    }
    if (this.engine && autoUpdate) {
      const name = `margoengine-controls:${this.kind}:${++pluginCounter}`;
      this.engine.use({name, setup() {}, onPreUpdate: delta => {if (this.enabled) this.update(delta);}, dispose: () => {this.pluginName = null; this.dispose();}});
      this.pluginName = name;
    }
    this.pending = element ?? null;
  }
  private pending: ControlElement | null;
  /** Subclasses call this at the end of their constructor, once their listener fields exist. */
  protected init(): void {const element = this.pending; this.pending = null; if (element) this.connect(element);}

  /** Short name used in plugin names. */
  protected get kind(): string {return 'controls';}
  /** Listeners to install on `connect`. Each control lists its own. */
  protected abstract bind(element: ControlElement): Array<[EventTargetLike, string, (event: any) => void, AddEventListenerOptions?]>;
  protected onDisconnect(): void {}

  connect(element: ControlElement): void {
    if (this.disposed) throw new Error('Controls are disposed');
    this.disconnect();
    this.element = element;
    for (const [target, type, listener, options] of this.bind(element)) {target.addEventListener(type, listener, options); this.bindings.push([target, type, listener, options]);}
  }
  disconnect(): void {
    this.onDisconnect();
    for (const [target, type, listener, options] of this.bindings) target.removeEventListener(type, listener, options);
    this.bindings = [];
    this.element = null;
  }
  /** Advances damping and continuous movement. Returns true when the camera changed. */
  abstract update(delta?: number): boolean;

  dispose(): void {
    if (this.disposed) return;
    this.disconnect();
    this.disposed = true;
    const name = this.pluginName; this.pluginName = null;
    if (name && this.engine && !this.engine.disposed && this.engine.hasPlugin(name)) this.engine.removePlugin(name);
  }

  /** Pointer position in CSS pixels relative to the element. */
  protected local(event: {clientX: number; clientY: number}): {x: number; y: number} {
    const rect = this.element?.getBoundingClientRect?.() ?? {left: 0, top: 0};
    return {x: event.clientX - rect.left, y: event.clientY - rect.top};
  }
  protected capture(id: number): void {try {this.element?.setPointerCapture?.(id);} catch {/* pointer already released */}}
  protected release(id: number): void {try {if (this.element?.hasPointerCapture?.(id) ?? true) this.element?.releasePointerCapture?.(id);} catch {/* already released */}}
}

/** Default key target: the element's document when there is one (key events do not reach an unfocused canvas), else the element. */
export const documentOf = (element: ControlElement): EventTargetLike => element.ownerDocument ?? element;
