import { useEffect, useMemo, useRef, useState } from 'react';
import type { Engine } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { Shadows } from '@margoengine/shadows';
import type { ShadowsLoader, World } from './internal.js';
import { sceneScope } from '../../shared/scene-scope.js';

/**
 * The cascaded shadows of one `<Scene>`: they shadow that scene's meshes (the Canvas's own shadows belong to the
 * default scene), made once a `<Shadows>` or `<ContactShadows>` inside the scene asks for them.
 */
export function useSceneShadows(engine: Engine, world: World | null) {
  const [requests, setRequests] = useState(0),
    [shadow, setShadow] = useState<Shadows | null>(null),
    loader = useRef<ShadowsLoader | null>(null),
    requestShadows = useMemo(
      () => (load: ShadowsLoader) => {
        loader.current ??= load;
        setRequests((count) => count + 1);
        return () => setRequests((count) => count - 1);
      },
      [],
    ),
    enabled = requests > 0;
  useEffect(() => {
    setShadow(null);
    if (!world || !enabled) return;
    let cancelled = false,
      effect: Shadows | undefined;
    loader.current!()
      .then(({ Shadows }) => {
        if (cancelled || engine.disposed) return;
        effect = sceneScope(engine, world).run(() => Shadows.attach(engine as unknown as EngineKernel));
        setShadow(effect);
      })
      .catch((error) => {
        if (!cancelled) engine.onError(error);
      });
    return () => {
      cancelled = true;
      effect?.dispose();
    };
  }, [engine, world, enabled]);
  return { requestShadows, shadows: enabled && shadow?.owner === engine ? shadow : null };
}
