import { forwardRef, useEffect, useRef, useState } from 'react';
import type { Sky as SkyPlugin, SkyOptions } from '@margoengine/sky';
import { useScene, useCommit, useLiveRef, assignRef, report } from './internal.js';
import { optionalPeer } from './optional.js';

interface ErrorProps {
  onError?: (error: unknown) => void;
}

/** Props of the Sky component; every prop is optional unless noted. */
export interface SkyProps extends SkyOptions, ErrorProps {}
/** The sky component. */
export const Sky = forwardRef<SkyPlugin, SkyProps>(function Sky({ onError, ...props }, ref) {
  // The sky is the only light of many scenes, so it supplies the fallback environment (metals are black without one).
  const options: SkyOptions = { environment: true, ...props },
    scene = useScene(),
    latest = useRef({ options, onError }),
    [sky, setSky] = useState<SkyPlugin | null>(null),
    handle = useRef(ref);
  handle.current = ref;
  latest.current = { options, onError };
  useEffect(() => {
    let active = true,
      current: SkyPlugin | undefined;
    optionalPeer('@margoengine/sky', () => import('@margoengine/sky'))
      .then(({ Sky }) => {
        if (!active || scene.engine.disposed) return;
        current = new Sky({ ...latest.current.options });
        scene.engine.use(current);
        assignRef(handle.current, current);
        setSky(current);
      })
      .catch((error) => {
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      if (current) {
        const made = current;
        assignRef(handle.current, null);
        setSky((state) => (state === made ? null : state));
        scene.engine.removePlugin(made.name);
        made.dispose();
      }
    };
  }, [scene.engine]);
  useCommit(() => {
    if (!sky) return;
    for (const key of Object.keys(sky.options)) delete (sky.options as Record<string, unknown>)[key];
    Object.assign(sky.options, options);
  });
  useLiveRef(ref, sky);
  return null;
});
