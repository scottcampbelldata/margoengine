import { createElement, type ReactNode } from 'react';
import * as React from 'react';
import { act as legacyAct } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type { Mesh, EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import type { NullStageOptions } from '@margoengine/headless/null';
import type { HeadlessStage } from '@margoengine/headless/stage';
import { Context, createViews, type Scene } from './internal.js';
import { MargoContext, type MargoContextValue } from './components.js';
import { createAssetCache, activateAssetCache, disposeAssetCache } from './assets.js';
import { FrameCallbacks, advanceFrames, bridgeFrames } from './frame-priority.js';
import { attachPointerEvents } from './events.js';
import { fault, rangeError } from '../../shared/errors.js';
import { optionalPeer } from './optional.js';

/** React act, with the React DOM fallback for React 18 component tests. */
export const act: typeof legacyAct = React.act ?? legacyAct;
/** Browser or caller-installed DOM (for example jsdom); no globals are installed by this entry. */
export interface TestRendererOptions extends NullStageOptions {
  /** Existing DOM element. Default a newly appended div in document.body. */
  container?: Element;
  /** Borrow a manually driven stage for pixel tests. Default an owned GPU-free null stage. */
  stage?: HeadlessStage;
}
/** Ordinary React DOM mount, with real engine scenes and deterministic frame/event helpers. */
export class TestRenderer {
  declare [Symbol.asyncDispose]: () => Promise<void>;
  private closed = false;
  private hit: Mesh | null = null;
  private readonly eventErrors: unknown[] = [];
  private readonly removeEvents: () => void;
  private readonly unbridge: () => void;
  /** @internal Use createTestRenderer. */
  constructor(
    readonly stage: HeadlessStage,
    readonly container: Element,
    private readonly root: Root,
    private readonly context: Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly mount: HTMLDivElement,
    private readonly ownedStage: boolean,
    private readonly ownedContainer: boolean,
  ) {
    this.unbridge = bridgeFrames(context.engine, context.frames);
    // Inject only the selected test hit; dispatch, bubbling, capture and missed events use the real Canvas dispatcher.
    const engine = context.engine;
    const picker = {
      get disposed() { return engine.disposed; },
      meshes: engine.meshes, store: engine.store,
      pick: async () => this.hit,
      onError: (error: unknown) => { this.eventErrors.push(error); },
    } as unknown as Engine;
    this.removeEvents = attachPointerEvents(picker, canvas, context.pointerHandlers, context.resources, context.frames, () => true, () => undefined);
  }
  get scene(): EngineKernel['scene'] { return this.stage.engine.scene; }
  get disposed(): boolean { return this.closed; }
  private check(): void {
    if (this.closed) throw fault('disposed', 'Test renderer disposed; create another mount', 'disposed');
  }
  /** All live meshes across default and named scenes, filtered in insertion order. */
  findAll(predicate: (mesh: Mesh) => boolean = () => true): Mesh[] {
    this.check();
    return [...this.context.engine.meshes.values()].map(mesh => mesh as unknown as Mesh).filter(predicate);
  }
  /** Commit a new tree with React DOM and flush its effects. */
  async update(children: ReactNode): Promise<void> {
    this.check();
    const context = this.context, engine = this.stage.engine;
    const value: MargoContextValue = {
      stage: this.stage, ready: true, canvas: this.canvas, camera: engine.camera, gl: engine,
      size: { width: this.canvas.width, height: this.canvas.height },
      get clock() { return context.frames.elapsed; }, invalidate: () => { advanceFrames(context.frames, context.engine, 0, true); this.stage.step(0); },
    };
    await act(async () => {
      this.root.render(createElement(MargoContext.Provider, { value }, createElement(Context.Provider, { value: context }, children)));
    });
  }
  /** Advance frame hooks, native ticks and plugins. Default one frame at 1/60 second. */
  async advanceFrames(count = 1, delta = 1 / 60): Promise<void> {
    this.check();
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(delta) || delta < 0 || delta > 1)
      throw rangeError('Test frames need a nonnegative integer count and delta in 0..1', 'arguments');
    await act(async () => {
      for (let i = 0; i < count; i++) {
        advanceFrames(this.context.frames, this.context.engine, delta, true);
        this.stage.step(delta);
      }
    });
  }
  /** Dispatch a DOM event against an explicitly selected hit (null for a miss), using normal Canvas semantics. */
  async fireEvent(target: Mesh | null, type: string, init: PointerEventInit & WheelEventInit = {}): Promise<void> {
    this.check();
    if (target && !this.findAll(mesh => mesh === target).length)
      throw fault('state', 'Event target must be a live mesh in this test renderer', 'state');
    this.hit = target;
    const view = this.canvas.ownerDocument.defaultView!;
    const EventType = type === 'wheel' ? view.WheelEvent : (view.PointerEvent ?? view.MouseEvent);
    const event = new EventType(type, { bubbles: true, pointerId: 1, isPrimary: true, ...init });
    if (!('pointerId' in event)) Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
    await act(async () => { this.canvas.dispatchEvent(event); });
    if (type === 'pointerup' || type === 'pointercancel') this.canvas.releasePointerCapture(init.pointerId ?? 1);
    if (this.eventErrors.length) throw Object.assign(fault('failed', 'Test pointer handler failed; inspect cause and repair the handler', 'failed'), { cause: this.eventErrors.splice(0) });
  }
  /** Unmount effects, release caches and the owned stage. A borrowed stage stays alive. Idempotent. */
  async unmount(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await act(async () => this.root.unmount()); }
    finally {
      this.removeEvents(); this.unbridge(); disposeAssetCache(this.context.assetCache);
      this.canvas.remove(); this.mount.remove();
      if (this.ownedContainer) this.container.remove();
      if (this.ownedStage) this.stage.dispose();
    }
  }
  [(Symbol.asyncDispose ?? Symbol()) as symbol](): Promise<void> { return this.unmount(); }
}
/** Mount components with createRoot plus act; requires a DOM, but never requests a GPU by default. */
export async function createTestRenderer(children: ReactNode, options: TestRendererOptions = {}): Promise<TestRenderer> {
  const { container: supplied, stage: borrowed, ...settings } = options;
  const doc = supplied?.ownerDocument ?? globalThis.document;
  if (!doc?.body) throw fault('unsupported', 'Component tests need a browser DOM or jsdom installed by the caller', 'unsupported');
  settings.signal?.throwIfAborted();
  const stage = borrowed ?? await (await optionalPeer('@margoengine/headless/null', () => import('@margoengine/headless/null'))).createNullStage(settings);
  const container = supplied ?? doc.body.appendChild(doc.createElement('div'));
  const canvas = container.appendChild(doc.createElement('canvas'));
  // Synthetic pointers are not active OS pointers. Keep capture local even in a real browser, with no DOM globals changed.
  const captures = new Set<number>();
  canvas.setPointerCapture = id => { captures.add(id); };
  canvas.releasePointerCapture = id => { captures.delete(id); };
  canvas.hasPointerCapture = id => captures.has(id);
  const mount = container.appendChild(doc.createElement('div'));
  canvas.width = settings.width ?? stage.canvas.width; canvas.height = settings.height ?? stage.canvas.height;
  const engine = stage.engine as unknown as Engine;
  const assetCache = createAssetCache(stage.engine);
  activateAssetCache(assetCache);
  const context: Scene = {
    engine, registry: null, resources: { models: new Set(), lighting: new Map() }, shadows: null,
    requestShadows: () => { throw fault('unsupported', 'GPU shadows require a rendering Canvas', 'unsupported'); },
    cameraOverrides: new Set(), pointerHandlers: new Map(),
    frames: { elapsed: 0, last: null, mode: 'demand', callbacks: new FrameCallbacks() },
    assetCache, world: null, views: createViews(engine),
  };
  const renderer = new TestRenderer(stage, container, createRoot(mount), context, canvas, mount, !borrowed, !supplied);
  try { await renderer.update(children); return renderer; }
  catch (error) { await renderer.unmount(); throw error; }
}
