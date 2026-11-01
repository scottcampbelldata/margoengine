import { createContext, forwardRef, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { FrameCallback, Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh, Vec3 } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { sceneWorldBounds } from './center.js';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { live, report, useMesh, useScene } from './internal.js';

/** Props of `<Bounds>`; every prop is optional. */
export interface BoundsProps extends MeshProps {
  /** Frame the content once it has any, including content that loads later. Default false. */
  fit?: boolean;
  /** Also set the camera's near and far around the content on every fit. Default false. */
  clip?: boolean;
  /** Frame it again when the canvas changes size. Default false. */
  observe?: boolean;
  /** Space around the content; 1 touches the edges. Default 1.2. */
  margin?: number;
  /** Seconds the camera takes to get there. Default 0.3. */
  duration?: number;
  /** Called when a fit fails, for example with a far plane too near. The Canvas's onError hears it too. */
  onError?: (error: unknown) => void;
}
/** What `useBounds` returns. */
export interface BoundsApi {
  /** Frames `mesh`, default the whole `<Bounds>`. Returns false when it has no geometry yet. */
  fit(mesh?: MeshHandle): boolean;
}
const BoundsContext = createContext<BoundsApi | null>(null);
/** The enclosing `<Bounds>`, to frame it or one of its meshes from an event handler. */
export function useBounds(): BoundsApi {
  const api = useContext(BoundsContext);
  if (!api) throw new MargoError('state', 'useBounds needs a <Bounds> above it; wrap the component in <Bounds>');
  return api;
}
type Options = Pick<BoundsProps, 'fit' | 'clip' | 'observe' | 'margin' | 'duration' | 'onError'>;
function BoundsBinding({ children, ...options }: Options & { children?: ReactNode }) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(options);
  latest.current = options;
  const api = useMemo<BoundsApi>(() => {
    const box = new Float32Array(6);
    return {
      fit(mesh) {
        const { engine } = scene,
          root = (mesh as unknown as EngineMesh | undefined) ?? live(registry);
        if (!root || !sceneWorldBounds(scene, root, box)) return false;
        const { clip = false, margin = 1.2, duration = 0.3 } = latest.current,
          camera = engine.camera,
          canvas = engine.canvas,
          aspect = canvas.clientWidth && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : 1;
        if (clip) {
          // The distance core's fit moves to; near and far go first because it refuses bounds beyond far.
          const radius = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2,
            angle = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, aspect)),
            distance = (radius * margin) / Math.sin(angle);
          if (radius > 0) {
            camera.near = Math.max(radius / 100, (distance - radius) / 2);
            camera.far = (distance + radius) * 2;
          }
        }
        camera.fitToBoundingBox(
          [box[0], box[1], box[2]] as unknown as Vec3,
          [box[3], box[4], box[5]] as unknown as Vec3,
          { aspect, duration, padding: margin },
        );
        return true;
      },
    };
  }, [scene, registry]);
  useEffect(() => {
    const canvas = scene.engine.canvas;
    let pending = !!latest.current.fit,
      width = canvas.clientWidth,
      height = canvas.clientHeight;
    const frame: FrameCallback = () => {
      if (latest.current.observe && (canvas.clientWidth !== width || canvas.clientHeight !== height)) pending = true;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (!pending) return;
      try {
        pending = !api.fit();
      } catch (error) {
        pending = false;
        report(scene, error, latest.current.onError);
      }
    };
    scene.frames.callbacks.add(frame);
    return () => {
      scene.frames.callbacks.delete(frame);
    };
  }, [scene, api]);
  return <BoundsContext.Provider value={api}>{children}</BoundsContext.Provider>;
}
/** Frames its content in the camera: on mount with `fit`, or from `useBounds().fit()`. Keeps the viewing direction. */
export const Bounds = forwardRef<MeshRef, BoundsProps>(function Bounds(
  { fit, clip, observe, margin, duration, onError, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <BoundsBinding fit={fit} clip={clip} observe={observe} margin={margin} duration={duration} onError={onError}>
        {children}
      </BoundsBinding>
    </Mesh>
  );
});
