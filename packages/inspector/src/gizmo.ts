/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { engineRuntime, meshRuntime, type Engine, type Scene } from '@margoengine/core/extension';
import { TransformControls, type TransformControlsOptions } from '@margoengine/controls/transform';
import type { ControlElement } from '@margoengine/controls';
import type { Inspector } from './index.js';
import { fault } from '../../shared/errors.js';

/** Selection gizmo options; all transform controls options retain their defaults. */
export interface InspectorGizmoOptions extends TransformControlsOptions {
  /** Toolbar parent. Default the inspector's shadow root; null hides the toolbar. */
  parent?: HTMLElement | ShadowRoot | null;
  /** Camera controls disabled during a gizmo drag and restored afterward. Default none. */
  cameraControls?: { enabled: boolean };
  /** W/E/R, Q, +/- and Escape shortcuts on the canvas. Default true; the canvas becomes focusable. */
  keyboard?: boolean;
  signal?: AbortSignal;
}
const components = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'] as const;
let nextGizmo = 0;

/** Inspector selection -> existing transform controls, with one shared undo step per completed drag. */
export class InspectorGizmo {
  readonly controls: TransformControls;
  readonly element: HTMLFieldSetElement;
  private readonly pluginName = `inspector:gizmo:${++nextGizmo}`;
  private readonly runtime: Engine;
  private readonly scene: Scene;
  private readonly observer?: MutationObserver;
  private readonly stopHistory: () => void;
  private readonly stopToolbar: () => void;
  private readonly canvas: HTMLCanvasElement;
  private readonly oldTabIndex: string | null;
  private before?: { mesh: Mesh; pose: number[] };
  private cameraEnabled?: boolean;
  private disposed = false;
  private wasConnected = false;
  private readonly abort = () => this.dispose();

  static attach(engine: EngineKernel, inspector: Inspector, options: InspectorGizmoOptions = {}): InspectorGizmo {
    return new InspectorGizmo(engine, inspector, options);
  }
  constructor(
    readonly engine: EngineKernel,
    readonly inspector: Inspector,
    private readonly options: InspectorGizmoOptions = {},
  ) {
    options.signal?.throwIfAborted();
    this.runtime = engineRuntime(engine);
    if (!this.runtime.sceneOf(inspector)) throw fault('state', 'Attach the inspector to this engine before its gizmo');
    this.canvas = engine.canvas;
    this.oldTabIndex = this.canvas.getAttribute?.('tabindex') ?? null;
    const target = options.element ?? this.canvas;
    // Controls must receive a handle press before the inspector's canvas picker or camera controls.
    // Forward native getters/method receivers, but register the input handlers in the capture phase.
    const capture = new Proxy(target, {
      get: (object, key) => {
        if (key === 'addEventListener' || key === 'removeEventListener')
          return (type: string, listener: EventListener) => object[key](type, listener, true);
        const value = Reflect.get(object, key, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    }) as ControlElement;
    const scene = (this.scene = this.runtime.sceneOf(inspector)!);
    // Own the lifecycle in the inspector's scene, including engine disposal.
    let controls: TransformControls | undefined;
    scene.use({
      name: this.pluginName,
      setup: () => {
        controls = TransformControls.attach(engine, { ...options, element: capture });
      },
      onPreUpdate: () => this.sync(),
      dispose: () => this.dispose(),
    });
    this.controls = controls!;
    this.controls.addEventListener('mouseDown', this.begin);
    this.controls.addEventListener('mouseUp', this.end);
    this.controls.addEventListener('objectChange', this.changed);
    this.element = inspector.element.ownerDocument.createElement('fieldset');
    const legend = this.element.ownerDocument.createElement('legend');
    legend.textContent = 'Transform gizmo';
    this.element.append(legend);
    for (const [label, mode] of [
      ['Move', 'translate'],
      ['Rotate', 'rotate'],
      ['Scale', 'scale'],
    ] as const) {
      const button = this.element.ownerDocument.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => this.controls.setMode(mode));
      this.element.append(button);
    }
    const space = this.element.ownerDocument.createElement('select');
    space.setAttribute('aria-label', 'Gizmo space');
    for (const value of ['world', 'local']) {
      const option = space.ownerDocument.createElement('option');
      option.value = value;
      option.textContent = value;
      space.append(option);
    }
    space.value = this.controls.space;
    space.addEventListener('change', () => this.controls.setSpace(space.value as 'world' | 'local'));
    this.element.append(space);
    const update = () => {
      for (const [i, mode] of ['translate', 'rotate', 'scale'].entries())
        this.element.querySelectorAll('button')[i].setAttribute('aria-pressed', String(this.controls.mode === mode));
      space.value = this.controls.space;
    };
    this.controls.addEventListener('mode-changed', update);
    this.controls.addEventListener('space-changed', update);
    this.stopToolbar = () => {
      this.controls.removeEventListener('mode-changed', update);
      this.controls.removeEventListener('space-changed', update);
    };
    update();
    (options.parent === undefined ? inspector.root : options.parent)?.append(this.element);
    if (options.keyboard !== false) {
      if (!this.canvas.hasAttribute('tabindex')) this.canvas.tabIndex = 0;
      this.controls.listenToKeyEvents(this.canvas);
    }
    this.stopHistory = inspector.history.onChange(() => this.sync());
    const Observer = inspector.element.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      this.observer = new Observer(() => this.sync());
      this.observer.observe(inspector.root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-selected'],
      });
      this.observer.observe(inspector.element.parentNode!, { childList: true });
    }
    options.signal?.addEventListener('abort', this.abort, { once: true });
    this.sync();
  }
  private live(mesh: Mesh): boolean {
    return !this.runtime.disposed && this.runtime.meshes.get(meshRuntime(mesh).id) === meshRuntime(mesh);
  }
  private pose(mesh: Mesh): number[] {
    const { id } = meshRuntime(mesh),
      values = this.runtime.store.transforms;
    return components.map((component) => values[component][id]);
  }
  private apply(mesh: Mesh, pose: number[]): void {
    // Old history entries never target a recycled entity id.
    if (!this.live(mesh)) return;
    mesh.setPosition([pose[0], pose[1], pose[2]]).setQuaternion(pose.slice(3, 7)).setScale([pose[7], pose[8], pose[9]]);
    this.inspector.refresh();
  }
  private readonly begin = (): void => {
    const mesh = this.controls.object;
    if (!mesh || !this.live(mesh)) return;
    this.before = { mesh, pose: this.pose(mesh) };
    if (this.options.cameraControls) {
      this.cameraEnabled = this.options.cameraControls.enabled;
      this.options.cameraControls.enabled = false;
    }
  };
  private readonly end = (): void => {
    const before = this.before;
    this.before = undefined;
    if (this.cameraEnabled !== undefined && this.options.cameraControls) {
      this.options.cameraControls.enabled = this.cameraEnabled;
      this.cameraEnabled = undefined;
    }
    if (!before || !this.live(before.mesh)) return;
    const after = this.pose(before.mesh);
    if (before.pose.every((v, i) => v === after[i])) return;
    this.inspector.history.record({
      label: `${this.controls.mode} ${before.mesh.name || 'entity'}`,
      undo: () => this.apply(before.mesh, before.pose),
      redo: () => this.apply(before.mesh, after),
    });
    this.inspector.refresh();
  };
  private readonly changed = (): void => {
    this.inspector.refresh();
  };
  /** Follows selection synchronously (also called before every frame and on tree mutations). */
  sync(): void {
    if (this.disposed) return;
    if (this.wasConnected && !this.inspector.element.isConnected) {
      this.dispose();
      return;
    }
    this.wasConnected ||= this.inspector.element.isConnected;
    const mesh = this.inspector.selected;
    const selected = mesh && this.live(mesh) ? mesh : null;
    if (selected === this.controls.object) return;
    if (selected) this.controls.attach(selected);
    else this.controls.detach();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.controls?.object && this.live(this.controls.object)) this.controls.cancelDrag();
    this.end();
    this.observer?.disconnect();
    this.stopHistory?.();
    this.stopToolbar?.();
    this.options.signal?.removeEventListener('abort', this.abort);
    this.controls?.removeEventListener('mouseDown', this.begin);
    this.controls?.removeEventListener('mouseUp', this.end);
    this.controls?.removeEventListener('objectChange', this.changed);
    this.controls?.dispose();
    this.element?.remove();
    if (this.options.keyboard !== false) {
      if (this.oldTabIndex === null) this.canvas.removeAttribute?.('tabindex');
      else this.canvas.setAttribute?.('tabindex', this.oldTabIndex);
    }
    this.scene.removePlugin(this.pluginName);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
