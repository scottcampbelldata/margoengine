import { useRef, useState } from 'react';
import type { Texture } from '@margoengine/materials';
import { useFrame } from './components.js';
import { useResourceEffect, useScene, report } from './internal.js';
import { optionalPeer } from './optional.js';
import { fault, rangeError } from '../../shared/errors.js';

/** Options of `useFBO`; every one is optional. */
export interface FBOOptions {
  /** Colour format; any renderable colour format. Default 'rgba8unorm'. */
  format?: GPUTextureFormat;
  /**
   * Also make a depth texture the views draw into (in the scene's depth format and sample count), as drei's
   * `depthBuffer` with a readable `depthTexture`. Default false: core draws into its own depth.
   */
  depth?: boolean;
  /** Called when a target cannot be made (the hook then returns null). Default: the Canvas's onError. */
  onError?: (error: unknown) => void;
}
/** A render target of `useFBO`: draw into it with `<RenderView target={fbo.target} />`, sample it through `texture`. */
export interface FBO {
  /** The colour texture as a material texture of `@margoengine/materials`, for a map. */
  readonly texture: Texture;
  /** The view target: the colour texture, and the depth texture with `depth`. */
  readonly target: { readonly color: GPUTexture; readonly depth?: GPUTexture };
  /** Size in texels. */
  readonly width: number;
  readonly height: number;
}
const COLOR_USAGE = 0x01 | 0x04 | 0x10; // COPY_SRC | TEXTURE_BINDING | RENDER_ATTACHMENT
let serial = 0;
/**
 * drei's useFBO: an owned render target, sized to the canvas's backing pixels (and following its resizes) unless
 * `width` and `height` are given, recreated after device restoration and freed on unmount. Returns null until the
 * materials package has loaded. Each new target is a new object, so a component that uses it re-renders.
 */
export function useFBO(width?: number, height?: number, options?: FBOOptions): FBO | null;
export function useFBO(options?: FBOOptions): FBO | null;
export function useFBO(a?: number | FBOOptions, b?: number, c?: FBOOptions): FBO | null {
  const [width, height, options] = typeof a === 'object' ? [undefined, undefined, a] : [a, b, c];
  for (const size of [width, height])
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 1))
      throw rangeError('useFBO sizes must be positive integers; pass texel sizes or omit them for the canvas size', 'react-arguments');
  const scene = useScene(),
    [fbo, setFBO] = useState<FBO | null>(null),
    resize = useRef<(() => void) | null>(null),
    latest = useRef(options);
  latest.current = options;
  const format = options?.format ?? 'rgba8unorm',
    depth = options?.depth ?? false;
  useResourceEffect(
    (lease) => {
      const engine = scene.engine,
        world = scene.world ?? engine.scene,
        name = `react-fbo:${++serial}`;
      let current: { fbo: FBO; device: GPUDevice } | undefined,
        closed = false,
        installed = false;
      const free = (made: FBO) => {
        made.texture.dispose();
        made.target.color.destroy();
        made.target.depth?.destroy();
      };
      void optionalPeer('@margoengine/materials', () => import('@margoengine/materials'))
        .then((api) => {
          if (closed || !lease.active || engine.disposed) return;
          const make = (force: boolean) => {
            const device = engine.gpu;
            if (!device)
              throw fault('unsupported', 'useFBO requires a WebGPU or compatibility device; use the WebGL2 compatibility device entry', 'react-usage');
            const w = width ?? Math.max(1, engine.canvas.width),
              h = height ?? Math.max(1, engine.canvas.height),
              limit = device.limits.maxTextureDimension2D;
            if (w > limit || h > limit) throw rangeError('useFBO exceeds device limits; reduce width or height', 'react-arguments');
            if (!force && current && current.device === device && current.fbo.width === w && current.fbo.height === h) return;
            const color = device.createTexture({ size: [w, h], format, usage: COLOR_USAGE });
            let texture: Texture, depthTexture: GPUTexture | undefined;
            try {
              if (depth) {
                const shape = engine.renderTarget;
                if (!shape) throw fault('unsupported', 'useFBO depth needs the WebGPU canvas pass; omit depth', 'react-usage');
                depthTexture = device.createTexture({
                  size: [w, h],
                  format: shape.depthFormat,
                  sampleCount: shape.samples,
                  usage: 0x04 | 0x10,
                });
              }
              texture = new api.Texture(color, { wrapS: 'clamp', wrapT: 'clamp' });
            } catch (error) {
              color.destroy();
              depthTexture?.destroy();
              throw error;
            }
            const previous = current?.fbo,
              made: FBO = { texture, target: depthTexture ? { color, depth: depthTexture } : { color }, width: w, height: h };
            current = { fbo: made, device };
            setFBO(made);
            // The old target may still be bound to a view drawing this frame; free it once React has moved on.
            if (previous) queueMicrotask(() => free(previous));
          };
          const guarded = (force: boolean) => {
            try {
              make(force);
            } catch (error) {
              report(scene, error, latest.current?.onError);
            }
          };
          make(false);
          resize.current = () => guarded(false);
          world.use({ name, setup() {}, onDeviceRestored: () => guarded(true) });
          installed = true;
        })
        .catch((error) => {
          if (!closed && lease.active && !engine.disposed) report(scene, error, latest.current?.onError);
        });
      return () => {
        closed = true;
        resize.current = null;
        if (installed && !engine.disposed && engine.scenes.has(world)) world.removePlugin(name);
        if (current) {
          const made = current.fbo;
          current = undefined;
          setFBO((state) => (state === made ? null : state));
          free(made);
        }
      };
    },
    [scene.engine, scene.world, width, height, format, depth],
  );
  // A canvas-sized target follows the canvas before the frame's views draw.
  useFrame(() => {
    if (width === undefined || height === undefined) resize.current?.();
  }, -100);
  return fbo;
}
