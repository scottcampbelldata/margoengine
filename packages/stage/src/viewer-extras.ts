/// <reference lib="esnext.disposable" preserve="true" />
import type { Animation } from '@margoengine/animation';
import type { Label, LabelOptions, LabelRenderer } from '@margoengine/labels';
import type { PickHit, Picking } from '@margoengine/selection';
import type { Stage } from './index.js';
import type { XRButton, XRButtonOptions } from './xr.js';
import { addViewer, type Viewer, type ViewerOptions } from './viewer.js';
import { optionalPackage, stageSignal } from './feature.js';
import { Cleanup } from '../../shared/cleanup.js';
import { fault, typeError } from '../../shared/errors.js';

export { registerViewerElement } from './viewer-element.js';
export type { ModelViewerElement, ViewerElementOptions } from './viewer-element.js';

/** An HTML annotation. Mesh offsets follow node animation; positions are in world metres. */
export interface ViewerHotspot extends LabelOptions {
  element: HTMLElement;
}
/** Viewer settings plus optional interaction. No optional package loads until its feature is needed. */
export interface ViewerExtrasOptions extends ViewerOptions {
  /** Overlay parent. Default the canvas parent. */
  parent?: HTMLElement;
  /** Initial annotations; more can be added with addHotspot. Default none. */
  hotspots?: readonly ViewerHotspot[];
  /** Start the first or selected clip. Default false. Skins and morphs still get their resting pose. */
  autoplay?: boolean;
  /** Clip name or index. Default first clip. */
  animationName?: string | number;
  /** Initial material variant. Default the file's original materials. */
  variant?: string | number;
  /** Enable canvas click picking and pick(). Default true. Drags do not emit picks. */
  picking?: boolean;
  /** Image shown during loading; removed on failure or dispose. Default none. */
  poster?: string | URL;
  /** Hide the poster after the first model render, or on its accessible button. Default auto. */
  reveal?: 'auto' | 'manual';
  /** Accessible model description, also used by the poster button. Default '3D model'. */
  alt?: string;
  /** Add an immersive AR launch button using stage/xr. Default false. */
  ar?: boolean | Omit<XRButtonOptions, 'mode' | 'parent' | 'signal'>;
}
/** A product viewer with annotations, animation, variants, picking, poster and an optional AR button. */
export interface ViewerExtras extends Viewer {
  readonly animation: Animation | null;
  readonly picking: Picking | null;
  readonly ar: XRButton | null;
  readonly poster: HTMLButtonElement | null;
  /** play, pause, variant-change, pick and poster-dismissed CustomEvents with detail. */
  readonly events: EventTarget;
  /** Retains a caller's element and restores its DOM location and inline style on removal/dispose. */
  addHotspot(hotspot: ViewerHotspot): Promise<Label>;
  removeHotspot(element: HTMLElement): void;
  /** Play/resume the selected clip; passing a name or index selects and restarts it. */
  play(clip?: string | number): void;
  pause(): void;
  seek(seconds: number): void;
  selectVariant(variant?: string | number): void;
  /** Pick this model at canvas-relative CSS pixels. Other scene models return null. */
  pick(x: number, y: number): Promise<PickHit | null>;
  dismissPoster(): void;
}

const pickers = new WeakMap<Picking, { users: number; owned: boolean }>();
let nextOverlay = 0;

/** Loads the existing product viewer and composes extras without changing core or the stage root. */
export async function addViewerExtras(
  stage: Stage,
  url: string | URL,
  options: ViewerExtrasOptions = {},
): Promise<ViewerExtras> {
  for (const key of ['autoplay', 'picking'] as const)
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      throw typeError(`${key}: pass a boolean`, 'arguments');
  if (options.reveal !== undefined && !['auto', 'manual'].includes(options.reveal))
    throw typeError('reveal: auto or manual', 'arguments');
  const host = options.parent ?? stage.canvas.parentElement;
  if (!host?.ownerDocument.defaultView) throw fault('state', 'Viewer extras needs a canvas parent or parent option');
  const view = host.ownerDocument.defaultView,
    lifetime = new AbortController(),
    abort = stageSignal(stage, AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])])),
    events = new view.EventTarget(),
    emit = (name: string, detail?: unknown): void => {
      events.dispatchEvent(new view.CustomEvent(name, { detail }));
    },
    undo: (() => void)[] = [],
    hotspots = new Map<HTMLElement, () => void>();
  abort.throwIfAborted();
  let disposed = false,
    viewer: Viewer | undefined,
    animation: Animation | null = null,
    picking: Picking | null = null,
    ar: XRButton | null = null,
    labels: Promise<LabelRenderer> | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    abort.removeEventListener('abort', dispose);
    lifetime.abort();
    const cleanup = new Cleanup();
    for (const remove of undo.splice(0).reverse()) cleanup.run(remove);
    cleanup.finish();
  };
  const live = (): void => {
    if (disposed) throw fault('disposed', 'Viewer extras disposed; create another viewer');
    abort.throwIfAborted();
  };
  const own = (remove: () => void): void => {
    // An abort can run dispose between an awaited producer's resolution and this continuation.
    if (disposed) remove();
    else undo.push(remove);
  };
  const poster = options.poster ? host.ownerDocument.createElement('button') : null;
  let revealed = false;
  const dismissPoster = (): void => {
    live();
    if (!viewer || revealed) return;
    revealed = true;
    if (poster) poster.hidden = true;
    stage.canvas.removeAttribute('aria-hidden');
    emit('poster-dismissed');
  };
  if (poster) {
    const image = host.ownerDocument.createElement('img'),
      style = host.style.position,
      hidden = stage.canvas.getAttribute('aria-hidden');
    if (view.getComputedStyle(host).position === 'static') host.style.position = 'relative';
    poster.type = 'button';
    poster.setAttribute('aria-label', `Reveal ${options.alt ?? '3D model'}`);
    poster.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;z-index:2;cursor:pointer';
    image.src = String(options.poster);
    image.alt = options.alt ?? '3D model';
    image.style.cssText = 'width:100%;height:100%;object-fit:contain';
    poster.append(image);
    poster.disabled = true;
    poster.setAttribute('aria-busy', 'true');
    stage.canvas.setAttribute('aria-hidden', 'true');
    poster.addEventListener('click', dismissPoster);
    host.append(poster);
    undo.push(() => {
      poster.removeEventListener('click', dismissPoster);
      poster.remove();
      host.style.position = style;
      if (hidden === null) stage.canvas.removeAttribute('aria-hidden');
      else stage.canvas.setAttribute('aria-hidden', hidden);
    });
  }
  abort.addEventListener('abort', dispose, { once: true });
  const addHotspot = async ({ element, ...settings }: ViewerHotspot): Promise<Label> => {
    live();
    if (hotspots.has(element)) throw fault('state', 'Hotspot already exists; remove it before adding it again');
    // Reserve before awaiting so simultaneous additions cannot move one element twice.
    const reservation = (): void => {};
    hotspots.set(element, reservation);
    try {
      labels ??= optionalPackage('@margoengine/labels', () => import('@margoengine/labels'), abort).then(
        ({ LabelRenderer }) => {
          live();
          const renderer = LabelRenderer.attach(stage.engine, {
            parent: host,
            name: `stage-viewer-labels-${++nextOverlay}`,
          });
          undo.push(() => renderer.dispose());
          return renderer;
        },
      );
      const renderer = await labels;
      live();
      // removeHotspot may have cancelled this addition while the package was loading.
      if (hotspots.get(element) !== reservation) throw new DOMException('Hotspot removed', 'AbortError');
      const parent = element.parentNode,
        next = element.nextSibling,
        style = element.getAttribute('style'),
        label = renderer.add(element, { pointerEvents: 'auto', ...settings });
      let removed = false;
      const remove = (): void => {
        if (removed) return;
        removed = true;
        hotspots.delete(element);
        label.remove();
        if (style === null) element.removeAttribute('style');
        else element.setAttribute('style', style);
        if (parent) parent.insertBefore(element, next?.parentNode === parent ? next : null);
      };
      hotspots.set(element, remove);
      undo.push(remove);
      return label;
    } catch (error) {
      if (hotspots.get(element) === reservation) hotspots.delete(element);
      throw error;
    }
  };
  try {
    viewer = await addViewer(stage, url, { ...options, signal: abort });
    const baseDispose = viewer.dispose;
    own(baseDispose);
    live();
    const model = viewer.model,
      needsAnimation =
        !!model.asset.doc.animations?.length ||
        model.primitives.some(
          (primitive) =>
            primitive.weights.length > 0 || model.asset.doc.nodes?.[primitive.nodeIndex]?.skin !== undefined,
        );
    if (needsAnimation) {
      const { Animation } = await optionalPackage(
        '@margoengine/animation',
        () => import('@margoengine/animation'),
        abort,
      );
      animation = Animation.attach(model);
      undo.push(() => animation!.dispose());
      if (options.animationName !== undefined) animation.play(options.animationName);
      animation.playing = options.autoplay ?? false;
    } else if (options.animationName !== undefined || options.autoplay)
      throw fault('state', 'This model has no animation clips');
    const player = (): Animation => {
      live();
      if (!animation?.clips.length) throw fault('state', 'This model has no animation clips');
      return animation;
    };
    const selectVariant = (variant?: string | number): void => {
      live();
      model.selectVariant(variant);
      emit('variant-change', { variant: model.selectedVariant });
    };
    if (options.variant !== undefined) selectVariant(options.variant);
    for (const hotspot of options.hotspots ?? []) await addHotspot(hotspot);
    if (options.picking !== false) {
      const { Picking } = await optionalPackage(
          '@margoengine/selection',
          () => import('@margoengine/selection'),
          abort,
        ),
        existing = Picking.forEngine(stage.engine);
      picking = existing ?? Picking.attach(stage.engine);
      const shared = pickers.get(picking) ?? { users: 0, owned: !existing },
        held = picking;
      shared.users++;
      pickers.set(held, shared);
      undo.push(() => {
        if (--shared.users === 0) {
          pickers.delete(held);
          if (shared.owned) held.dispose();
        }
      });
    }
    const pick = async (x: number, y: number): Promise<PickHit | null> => {
      live();
      if (!picking) throw fault('state', 'Picking disabled; set picking: true');
      const hit = await picking.pick(x, y);
      live();
      const result =
        hit?.model === model || hit?.mesh === model.root || model.nodes.includes(hit?.mesh as never) ? hit : null;
      emit('pick', result);
      return result;
    };
    if (picking) {
      let down: { x: number; y: number; id: number } | undefined;
      const press = (event: PointerEvent): void => {
        down = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : undefined;
      };
      const release = (event: PointerEvent): void => {
        const start = down;
        down = undefined;
        if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)
          return;
        const rect = stage.canvas.getBoundingClientRect();
        void pick(
          ((event.clientX - rect.left) * stage.canvas.clientWidth) / rect.width,
          ((event.clientY - rect.top) * stage.canvas.clientHeight) / rect.height,
        ).catch((error: unknown) => {
          if (!abort.aborted) stage.engine.onError(error);
        });
      };
      const cancel = (): void => {
        down = undefined;
      };
      stage.canvas.addEventListener('pointerdown', press);
      stage.canvas.addEventListener('pointerup', release);
      stage.canvas.addEventListener('pointercancel', cancel);
      undo.push(() => {
        stage.canvas.removeEventListener('pointerdown', press);
        stage.canvas.removeEventListener('pointerup', release);
        stage.canvas.removeEventListener('pointercancel', cancel);
      });
    }
    if (options.ar) {
      const { addXRButton } = await import('./xr.js');
      ar = await addXRButton(stage, {
        ...(typeof options.ar === 'object' ? options.ar : {}),
        mode: 'immersive-ar',
        parent: host,
        signal: abort,
      });
      own(() => ar!.dispose());
    }
    live();
    undo.push(model.onDispose(dispose));
    stage.engine.render();
    if (poster) {
      poster.disabled = false;
      poster.removeAttribute('aria-busy');
    }
    if (options.reveal !== 'manual') dismissPoster();
    // Keep the underlying viewer's live turntable accessor rather than snapshotting it with spread.
    return Object.defineProperties(viewer, {
      animation: { value: animation },
      picking: { value: picking },
      ar: { value: ar },
      poster: { value: poster },
      events: { value: events },
      addHotspot: { value: addHotspot },
      removeHotspot: {
        value: (element: HTMLElement): void => {
          hotspots.get(element)?.();
          hotspots.delete(element);
        },
      },
      play: {
        value: (clip?: string | number): void => {
          const value = player();
          if (clip !== undefined) value.play(clip);
          else value.playing = true;
          emit('play', { clip: value.clips[value.clip].name });
        },
      },
      pause: {
        value: (): void => {
          live();
          if (animation) {
            animation.playing = false;
            emit('pause');
          }
        },
      },
      seek: {
        value: (seconds: number): void => {
          player().seek(seconds);
        },
      },
      selectVariant: { value: selectVariant },
      pick: { value: pick },
      dismissPoster: { value: dismissPoster },
      dispose: { value: dispose },
      [Symbol.dispose]: { value: dispose },
    }) as ViewerExtras;
  } catch (error) {
    new Cleanup(error).run(dispose).finish();
    throw error;
  }
}
