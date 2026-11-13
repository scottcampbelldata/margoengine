import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useMargoStage } from '@margoengine/react';
import { SectionPlanes as SectionPlugin, type SectionOptions } from './section.js';

// Built on the public @margoengine/react hooks only (useMargoStage plus React effects). The engine's own React
// subpath has its own internal useCreated / useCommit / useScene helpers, which this entry does not reach into.
interface ErrorProps {
  /** Attaching failed (for example without WebGPU). Without it the error is thrown during the effect. */
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
  const engine = useMargoStage(),
    latest = useRef(planes),
    [section, setSection] = useState<SectionPlugin | null>(null);
  latest.current = planes;
  const colorKey = typeof color === 'object' ? color?.join() : color;
  useEffect(() => {
    let value: SectionPlugin | null = null;
    try {
      value = SectionPlugin.attach(engine, { planes: latest.current, cap, capOpenShells, color, hatch });
    } catch (error) {
      if (!onError) throw error;
      onError(error);
    }
    setSection(value);
    return () => {
      value?.dispose();
      setSection(null);
    };
    // Recreated only when the plane count or a fixed option changes, as before.
  }, [engine, planes.length, cap, capOpenShells, colorKey, hatch]);
  useImperativeHandle(ref, () => section as SectionPlugin, [section]);
  useLayoutEffect(() => {
    if (!section) return;
    section.options.planes = planes;
    section.enabled = enabled;
  });
  return null;
});
