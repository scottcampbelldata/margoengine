import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
// Static: every React DOM app has react-dom in its entry (react-dom/client imports it), so a lazy import() of it moved
// nothing and Vite and Rolldown warned INEFFECTIVE_DYNAMIC_IMPORT for it.
import { createPortal } from 'react-dom';
import type { Engine, Mesh as EngineMesh, Vec3 } from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import type * as HTMLModule from '@margoengine/html';
import { MargoError } from '@margoengine/math/errors';
import { useCommit, useScene, zero } from './internal.js';
import { optionalPeer } from './optional.js';

type HTMLOverlay = HTMLModule.HTML;
interface OverlayEntry {
  users: number;
  promise: Promise<HTMLOverlay>;
}
const overlays = new WeakMap<Engine, OverlayEntry>();
function acquireOverlay(engine: Engine): OverlayEntry {
  let entry = overlays.get(engine);
  if (!entry) {
    entry = {
      users: 0,
      promise: optionalPeer('@margoengine/html', () => import('@margoengine/html')).then(({ HTML }) => {
        if (engine.disposed)
          throw new MargoError('disposed', 'Canvas is disposed; render the component inside a live <Canvas>.');
        return HTML.attach(engine as unknown as EngineKernel);
      }),
    };
    overlays.set(engine, entry);
  }
  entry.users++;
  return entry;
}
function releaseOverlay(engine: Engine, entry: OverlayEntry): void {
  if (--entry.users) return;
  queueMicrotask(() => {
    if (entry.users || overlays.get(engine) !== entry) return;
    overlays.delete(engine);
    void entry.promise.then(
      (overlay) => overlay.dispose(),
      () => {},
    );
  });
}
/** Props of the Html component; every prop is optional unless noted. */
export interface HtmlProps {
  children?: ReactNode;
  /** World position, or the offset from the enclosing `<Mesh>`. Default [0, 0, 0]. */
  position?: Vec3;
  className?: string;
  style?: CSSProperties;
  /** Hide the label when scene geometry is in front of it (WebGPU depth). Default true. */
  occlude?: boolean;
  /** Point of the label placed on the anchor, in fractions of its size: [0.5, 0.5] centres it. Default [0.5, 0.5]. */
  anchor?: readonly [number, number];
  /** Scale with distance: a reference distance in world units (or `{ reference, min, max }`) at which scale is 1. */
  distanceScale?: number | { reference: number; min?: number; max?: number };
  /** Stack nearer labels above farther ones. Default false. */
  sort?: boolean;
  /** Hide the label when its anchor is outside the view. Default true. */
  frustumCulling?: boolean;
  /** Hide with an invisible enclosing mesh. Default true. */
  followVisibility?: boolean;
  /** Default true. */
  visible?: boolean;
  /** `'auto'` lets the label take clicks; default `'none'` lets them through to the canvas. */
  pointerEvents?: 'none' | 'auto';
  onError?: (error: unknown) => void;
}
/** Optional projected React DOM content, sharing one HTML plugin per canvas. */
export function Html({
  children,
  position = zero,
  className,
  style,
  occlude = true,
  anchor = [0.5, 0.5],
  distanceScale,
  sort = false,
  frustumCulling = true,
  followVisibility = true,
  visible = true,
  pointerEvents = 'none',
  onError,
}: HtmlProps) {
  const { engine, registry } = useScene();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const label = useRef<HTMLModule.Label | null>(null),
    latest = useRef({ position, occlude, onError });
  latest.current = { position, occlude, onError };
  const occlusion = useRef<HTMLModule.Label['occlude']>(null);
  useEffect(() => {
    let active = true,
      current: HTMLOverlay | undefined,
      item: HTMLModule.Label | undefined;
    const entry = acquireOverlay(engine),
      element = engine.canvas.ownerDocument.createElement('div');
    const attach = (mesh: EngineMesh) => {
      item?.setMesh(mesh as unknown as MeshHandle);
      item?.setOffset(latest.current.position);
    };
    entry.promise
      .then((overlay) => {
        if (!active || engine.disposed) return;
        current = overlay;
        const mesh = registry?.current,
          p = latest.current.position;
        item = overlay.add(element, {
          mesh: mesh as unknown as MeshHandle | null,
          position: p,
          offset: mesh ? p : zero,
        });
        label.current = item;
        occlusion.current = item.occlude;
        if (!latest.current.occlude) item.occlude = () => false;
        registry?.attachments.add(attach);
        setPortal(element);
      })
      .catch((error) => {
        if (active && !engine.disposed) {
          try {
            latest.current.onError?.(error);
          } finally {
            engine.onError(error);
          }
        }
      });
    return () => {
      active = false;
      registry?.attachments.delete(attach);
      if (item) current?.remove(item);
      label.current = null;
      element.remove();
      releaseOverlay(engine, entry);
    };
  }, [engine, registry]);
  useCommit(() => {
    const item = label.current;
    if (item) {
      if (registry?.current) item.setMesh(registry.current as unknown as MeshHandle).setOffset(position);
      else item.setPosition(position);
      item.occlude = occlude ? occlusion.current : () => false;
      // The label's live fields; pointer events are a style on the element this component owns.
      item.anchor = [anchor[0], anchor[1]];
      item.distanceScale = distanceScale ?? null;
      item.sort = sort;
      item.frustumCulling = frustumCulling;
      item.followVisibility = followVisibility;
      item.visible = visible;
      if (portal) portal.style.pointerEvents = pointerEvents;
    }
  }, [
    registry,
    portal,
    position[0],
    position[1],
    position[2],
    occlude,
    anchor[0],
    anchor[1],
    typeof distanceScale === 'object' ? JSON.stringify(distanceScale) : distanceScale,
    sort,
    frustumCulling,
    followVisibility,
    visible,
    pointerEvents,
  ]);
  return portal
    ? createPortal(
        <div className={className} style={style}>
          {children}
        </div>,
        portal,
      )
    : null;
}
