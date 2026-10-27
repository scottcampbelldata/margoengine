import { forwardRef, useRef } from 'react';
import type { EngineKernel } from '@margoengine/core';
import type { SectionOptions, SectionPlanes as SectionPlugin } from '@margoengine/machinery/section';
import { useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

interface ErrorProps {
  /** Loading the optional package or attaching failed. */
  onError?: (error: unknown) => void;
}

/** Props of `<SectionPlanes>`. */
export interface SectionPlanesProps extends SectionOptions, ErrorProps {
  /** Clip while true; switching does not recompile. Default true. */
  enabled?: boolean;
}
/**
 * Cuts the scene with up to 6 planes `[a, b, c, d]` (points with a x + b y + c z + d < 0 are cut away) and caps the
 * cut faces of closed solids (`@margoengine/machinery`'s SectionPlanes). Plane values update every frame from the
 * props; the number of planes, `cap`, `capOpenShells`, `color` and `hatch` are fixed and recreate it when changed.
 * WebGPU only.
 */
export const SectionPlanes = forwardRef<SectionPlugin, SectionPlanesProps>(function SectionPlanes(
  { planes, enabled = true, cap, capOpenShells, color, hatch, onError },
  ref,
) {
  const scene = useScene(),
    latest = useRef(planes);
  latest.current = planes;
  const section = useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/machinery', () => import('@margoengine/machinery/section')),
      create: (api) =>
        api.SectionPlanes.attach(scene.engine as unknown as EngineKernel, {
          planes: latest.current,
          cap,
          capOpenShells,
          color,
          hatch,
        }),
      dispose: (value) => value.dispose(),
      ref,
      onError,
    },
    [planes.length, cap, capOpenShells, typeof color === 'object' ? color?.join() : color, hatch],
  );
  useCommit(() => {
    if (!section) return;
    section.options.planes = planes;
    section.enabled = enabled;
  });
  return null;
});
