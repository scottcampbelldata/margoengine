import React, { useEffect, useRef } from 'react';
import type { InspectorOptions } from '@margoengine/inspector';
import type { StatsOptions } from '@margoengine/stats';
import type { EngineKernel } from '@margoengine/core';
import { panelsByDefault } from './dev-mode.js';
import { ownerHook } from './dev-names.js';
import { report, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

/** Props of `<DevTools>`; every prop is optional. Options are read when the panels open. */
export interface DevToolsProps {
  /** Show the panels. Default: everywhere but a production build. */
  enabled?: boolean;
  /** The scene tree, with each mesh's React component; `false` leaves it out. Default true. */
  inspector?: boolean | Omit<InspectorOptions, 'label'>;
  /** Frame time and draw calls; `false` leaves them out. Default true. */
  stats?: boolean | StatsOptions;
  /** Called when a panel's package fails to load. The Canvas's onError hears it too. */
  onError?: (error: unknown) => void;
}
// Which React components made each mesh. A production React has no owner stacks, and neither has React 18: their
// meshes simply have no component name.
const names = new WeakMap<object, string>();
const frame = /^\s*(?:at (?:new )?)?([A-Za-z_$][\w$.]*)(?: \(|@)/;
// From here on, each new mesh remembers its nearest two components above the rendering <Mesh>, nearest first. Set on
// import, so meshes rendered before <DevTools> count too.
ownerHook.capture = () => {
  const capture = (React as unknown as { captureOwnerStack?: () => string | null }).captureOwnerStack,
    found: string[] = [];
  for (const line of capture?.()?.split('\n') ?? []) {
    const name = frame.exec(line)?.[1];
    if (name && name !== 'Mesh') found.push(name);
    if (found.length === 2) break;
  }
  return found.length ? found.join(' in ') : undefined;
};
ownerHook.remember = (mesh, name) => {
  if (name) names.set(mesh, name);
};
const options = <T,>(value: boolean | T): T | undefined => (typeof value === 'object' ? (value as T) : undefined);
/**
 * Development panels for a Canvas: `@margoengine/inspector` with component names in its tree, and `@margoengine/stats`.
 * Render it anywhere inside `<Canvas>`. A mesh without a `name` shows the components that made it, such as
 * "Box in Car" (React 19 in development; other meshes keep "Entity 12").
 */
export function DevTools({
  enabled = panelsByDefault,
  inspector = true,
  stats = true,
  onError,
}: DevToolsProps) {
  const scene = useScene(),
    latest = useRef({ inspector, stats, onError });
  latest.current = { inspector, stats, onError };
  const showInspector = enabled && inspector !== false,
    showStats = enabled && stats !== false;
  useEffect(() => {
    const engine = scene.engine as unknown as EngineKernel,
      made: { dispose(): void }[] = [];
    let active = true;
    const failed = (error: unknown) => {
      if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
    };
    if (showInspector)
      optionalPeer('@margoengine/inspector', () => import('@margoengine/inspector'))
        .then(({ Inspector }) => {
          if (active && !scene.engine.disposed)
            made.push(
              Inspector.attach(engine, {
                ...options<Omit<InspectorOptions, 'label'>>(latest.current.inspector),
                label: (mesh: object) => names.get(mesh),
              }),
            );
        })
        .catch(failed);
    if (showStats)
      optionalPeer('@margoengine/stats', () => import('@margoengine/stats'))
        .then(({ Stats }) => {
          if (active && !scene.engine.disposed)
            made.push(Stats.attach(engine, options<StatsOptions>(latest.current.stats)));
        })
        .catch(failed);
    return () => {
      active = false;
      for (const panel of made) panel.dispose();
    };
  }, [scene, showInspector, showStats]);
  return null;
}
