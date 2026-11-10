import type { EngineKernel, Mesh } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import type { Inspector } from '@margoengine/inspector';
import type { InspectorGizmo, InspectorGizmoOptions } from '@margoengine/inspector/gizmo';
import { MargoError } from '@margoengine/math/errors';
import type { TransformKey } from './document.js';
import type { ItemRef, TimelineEditor, TimelineModel } from './editor.js';

/** Inserts or replaces a transform key at its exact time, creating its track when absent. One validated undo step. */
export function keyTransform(model: TimelineModel, track: string, target: string, key: TransformKey): ItemRef {
  const found = model.document.tracks.find((t) => t.id === track);
  if (!found) {
    model.addTrack({ type: 'transform', id: track, target, keys: [key] });
    return { track, index: 0 };
  }
  if (found.type !== 'transform' || found.target !== target)
    throw new RangeError('Viewport track must transform this target; choose a matching track id');
  const index = found.keys.findIndex((k) => k.time === key.time);
  if (index < 0) return model.addItem(track, key as unknown as Record<string, unknown>);
  const ref = model.updateItem({ track, index }, key as unknown as Record<string, unknown>);
  if (!ref) throw new RangeError('Transform key was refused; pass finite transforms and a unit quaternion');
  return ref;
}

/** Options for selecting and keying meshes with the inspector gizmo. */
export interface ViewportKeyingOptions {
  /** Borrow an existing inspector gizmo; default attach one owned by this tool. */
  gizmo?: InspectorGizmo;
  /** Options of an owned gizmo; ignored when gizmo is supplied. */
  gizmoOptions?: InspectorGizmoOptions;
  /** Map a mesh to saved track id and target. Default its nonempty name, otherwise mesh-<runtime id>. */
  binding?: (mesh: Mesh) => { track: string; target: string };
  /** Key after a completed gizmo drag that changed the pose. Default false. */
  autoKey?: boolean;
  /** Where the key button and auto-key toggle go. Default the timeline panel. */
  parent?: HTMLElement | ShadowRoot;
  /** Dispose on abort. An already aborted signal throws before attachment. */
  signal?: AbortSignal;
}
const pose = (mesh: Mesh): number[] => {
  mesh.check();
  const runtime = meshRuntime(mesh),
    values = runtime.engine.store.transforms,
    id = runtime.id;
  return ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((k) => values[k as 'x'][id]);
};

/** Picks through an attached Inspector, manipulates with its gizmo and keys local transforms at the editor playhead. */
export class ViewportKeying {
  readonly gizmo: InspectorGizmo;
  readonly element: HTMLFieldSetElement;
  /** Whether the end of each changed drag records a transform key. Default false. */
  autoKey: boolean;
  private before?: { mesh: Mesh; values: number[] };
  private disposed = false;
  private readonly abort = new AbortController();
  /** Loads the inspector gizmo only when attaching. An aborted signal leaves no owned tool behind. */
  static async attach(
    engine: EngineKernel,
    editor: TimelineEditor,
    inspector: Inspector,
    options: ViewportKeyingOptions = {},
  ): Promise<ViewportKeying> {
    options.signal?.throwIfAborted();
    const module = options.gizmo ? undefined : await import('@margoengine/inspector/gizmo');
    options.signal?.throwIfAborted();
    const gizmo = options.gizmo ?? module!.InspectorGizmo.attach(engine, inspector, options.gizmoOptions);
    try {
      return new ViewportKeying(engine, editor, inspector, options, gizmo);
    } catch (error) {
      if (!options.gizmo) gizmo.dispose();
      throw error;
    }
  }
  private constructor(
    readonly engine: EngineKernel,
    readonly editor: TimelineEditor,
    readonly inspector: Inspector,
    private readonly options: ViewportKeyingOptions,
    gizmo: InspectorGizmo,
  ) {
    this.dispose = this.dispose.bind(this);
    options.signal?.throwIfAborted();
    if (options.gizmo && (options.gizmo.engine !== engine || options.gizmo.inspector !== inspector))
      throw new RangeError('Viewport gizmo must belong to this engine and inspector; pass their gizmo');
    this.gizmo = gizmo;
    this.autoKey = options.autoKey ?? false;
    const doc = editor.element.ownerDocument;
    this.element = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = 'Viewport keying';
    this.element.append(legend);
    const key = doc.createElement('button');
    key.type = 'button';
    key.textContent = 'Key transform';
    key.addEventListener('click', () => this.key(), { signal: this.abort.signal });
    this.element.append(key);
    const label = doc.createElement('label'),
      toggle = doc.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = this.autoKey;
    toggle.addEventListener(
      'change',
      () => {
        this.autoKey = toggle.checked;
      },
      { signal: this.abort.signal },
    );
    label.append(toggle, ' Auto key');
    this.element.append(label);
    (options.parent ?? editor.element).append(this.element);
    this.gizmo.controls.addEventListener('mouseDown', this.start);
    this.gizmo.controls.addEventListener('mouseUp', this.end);
    engine.canvas.addEventListener('keydown', this.shortcut, { signal: this.abort.signal });
    options.signal?.addEventListener('abort', this.dispose, { once: true });
  }
  /** Records the current selection. Replaces an existing key at the playhead, preserving its easing. */
  key(): ItemRef {
    if (this.disposed) throw new MargoError('disposed', 'Viewport keying is disposed; attach a new tool');
    const mesh = this.inspector.selected;
    if (!mesh) throw new MargoError('state', 'Select a scene object before keying its transform');
    const values = pose(mesh),
      name = mesh.name || `mesh-${meshRuntime(mesh).id}`;
    const { track, target } = this.options.binding?.(mesh) ?? { track: name, target: name };
    const ref = keyTransform(this.editor.model, track, target, {
      time: this.editor.time,
      position: values.slice(0, 3) as [number, number, number],
      rotation: values.slice(3, 7) as [number, number, number, number],
      scale: values.slice(7, 10) as [number, number, number],
    });
    this.editor.selection = [ref];
    return ref;
  }
  private readonly start = (): void => {
    const mesh = this.inspector.selected;
    this.before = mesh ? { mesh, values: pose(mesh) } : undefined;
  };
  private readonly end = (): void => {
    const before = this.before;
    this.before = undefined;
    if (!this.autoKey || !before || before.mesh !== this.inspector.selected) return;
    if (pose(before.mesh).some((v, i) => v !== before.values[i])) this.key();
  };
  private readonly shortcut = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() !== 'k' || event.ctrlKey || event.metaKey || event.altKey || !this.inspector.selected)
      return;
    event.preventDefault();
    this.key();
  };
  /** Removes keying UI/listeners and disposes only an owned gizmo. The editor, inspector and scene are borrowed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.options.signal?.removeEventListener('abort', this.dispose);
    this.gizmo.controls.removeEventListener('mouseDown', this.start);
    this.gizmo.controls.removeEventListener('mouseUp', this.end);
    if (!this.options.gizmo) this.gizmo.dispose();
    this.element.remove();
    this.before = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
