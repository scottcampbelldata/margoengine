import { forwardRef, useEffect, useRef } from 'react';
import type { StencilBuffer } from '@margoengine/materials';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { report, useScene, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { TextureMaterial } from './texture-material.js';
import { rangeError } from '../../shared/errors.js';

/** Props of `<Mask>`: a mesh that writes `id` into the stencil buffer where it covers the screen. */
export interface MaskProps extends MeshProps {
  /** Stencil value written where the mask draws, an integer 1..255. Required. */
  id: number;
  /** Draw the mask's own colour too. Default false (the mask is invisible). */
  colorWrite?: boolean;
  /** Write the mask's depth, so it hides what is behind it. Default false. */
  depthWrite?: boolean;
  onError?: (error: unknown) => void;
}
/** The stencil options `useMask` returns, to spread into a `<TextureMaterial>`. */
export interface MaskStencil {
  stencilWrite: true;
  stencilRef: number;
  stencilFunc: 'equal' | 'not-equal';
  stencilWriteMask: 0;
}
// One portable stencil attachment per scene, shared by every mounted Mask and removed with the last one.
const buffers = new WeakMap<object, { count: number; buffer?: StencilBuffer; done?: boolean }>();
function useStencilBuffer(scene: Scene, onError: ((error: unknown) => void) | undefined): void {
  const latest = useRef(onError);
  latest.current = onError;
  useEffect(() => {
    const owner = scene.world ?? scene.engine,
      gpu = Boolean((scene.engine as { gpu?: unknown }).gpu);
    if (!gpu) return;
    let entry = buffers.get(owner);
    if (!entry) buffers.set(owner, (entry = { count: 0 }));
    const held = entry;
    held.count++;
    if (held.count === 1)
      optionalPeer('@margoengine/materials', () => import('@margoengine/materials'))
        .then((api) => {
          if (!held.count || held.buffer || scene.engine.disposed) return;
          const buffer = new api.StencilBuffer();
          owner.use(buffer);
          held.buffer = buffer;
        })
        .catch((error) => {
          if (!scene.engine.disposed) report(scene, error, latest.current);
        });
    return () => {
      if (--held.count) return;
      held.buffer?.dispose();
      held.buffer = undefined;
      buffers.delete(owner);
    };
  }, [scene]);
}
function checkId(id: number): void {
  if (!Number.isInteger(id) || id < 1 || id > 255)
    throw rangeError(
      'Mask id must be an integer from 1 to 255; pass the stencil value the mask writes',
      'react-arguments',
    );
}
/**
 * drei's Mask: the geometry child draws `id` into the stencil buffer (invisible by default) before the scene's other
 * material meshes, and `useMask(id)` limits a `<TextureMaterial>` to where that mask drew (or, inverted, to everywhere
 * else). Needs WebGPU or the WebGL2 compatibility layer; the stencil buffer is attached while a Mask is mounted.
 */
export const Mask = /* @__PURE__ */ forwardRef<MeshRef, MaskProps>(function Mask(
  { id, colorWrite = false, depthWrite = false, onError, children, ...props },
  ref,
) {
  checkId(id);
  useStencilBuffer(useScene(), onError);
  return (
    <Mesh {...props} ref={ref}>
      {children}
      <TextureMaterial
        colorWrite={colorWrite}
        depthWrite={depthWrite}
        stencilWrite
        stencilRef={id}
        stencilFunc="always"
        stencilZPass="replace"
        renderOrder={-1}
        onError={onError}
      />
    </Mesh>
  );
});
/**
 * drei's useMask: stencil options for a `<TextureMaterial>` that draws only inside the `<Mask>` with this id, or only
 * outside it with `inverse`. Spread them: `<TextureMaterial color="red" {...useMask(1)} />`.
 */
export function useMask(id: number, inverse = false): MaskStencil {
  checkId(id);
  return { stencilWrite: true, stencilRef: id, stencilFunc: inverse ? 'not-equal' : 'equal', stencilWriteMask: 0 };
}
