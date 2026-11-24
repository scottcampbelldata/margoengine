import { useEffect, useRef } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { MeshOutline, MeshOutlineOptions } from '@margoengine/toon/outline';
import { colorKey, live, report, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { subscribeFrame } from './frame-priority.js';
import { rangeError } from '../../shared/errors.js';

/** Props of `<Outlines>`: drei's names, every one optional. */
export interface OutlinesProps
  extends Omit<MeshOutlineOptions, 'mesh' | 'geometry' | 'color'> {
  /** Line colour: `#rgb`/`#rrggbb` (sRGB) or linear RGB numbers 0 or more. Default black. */
  color?: string | readonly [number, number, number];
  /** Called with the native `MeshOutline` of `@margoengine/toon/outline` once it is attached. */
  onReady?: (outline: MeshOutline) => void;
  onError?: (error: unknown) => void;
}

const srgb = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** `color` as linear RGB: a hex string is sRGB, numbers pass through. */
export function outlineRGB(color: OutlinesProps['color']): [number, number, number] {
  if (color === undefined) return [0, 0, 0];
  if (typeof color !== 'string') return [color[0], color[1], color[2]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) throw rangeError(`Outlines color '${color}' is not #rgb or #rrggbb; pass a hex colour or three numbers`, 'react-arguments');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => srgb(parseInt(full.slice(i, i + 2), 16) / 255)) as [number, number, number];
}

/**
 * drei's `Outlines`: an inverted-hull outline around the enclosing mesh (`<Box><Outlines /></Box>`), drawn by
 * `MeshOutline` of `@margoengine/toon/outline`. It follows the mesh's transform, geometry and visibility; a prop change
 * applies live (`renderOrder` re-attaches). Needs WebGPU or the WebGL2 compatibility layer and `@margoengine/toon`.
 */
export function Outlines({ onReady, onError, ...props }: OutlinesProps): null {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef({ props, onReady, onError }),
    plugin = useRef<MeshOutline | null>(null),
    instanced = useRef(new Map<EngineMesh, MeshOutline>());
  latest.current = { props, onReady, onError };
  // Inside <Instances>, one outline per drawn instance mesh, each from that mesh's own (shared) geometry.
  const apply = (outline: MeshOutline, instance = false) => {
    const { color, renderOrder: _order, ...rest } = latest.current.props;
    Object.assign(outline, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), {
      color: outlineRGB(color),
      geometry: !instance && registry.geometryOverride ? (registry.geometry ?? null) : undefined,
    });
  };
  const key = JSON.stringify({ ...props, color: colorKey(props.color) });
  useEffect(() => {
    try {
      if (plugin.current) apply(plugin.current);
      for (const outline of instanced.current.values()) apply(outline, true);
    } catch (error) {
      report(scene, error, latest.current.onError);
    }
  }, [key]);
  useEffect(() => {
    let active = true,
      outline: MeshOutline | null = null,
      mesh: EngineMesh | null = null,
      api: typeof import('@margoengine/toon/outline') | null = null;
    const each = instanced.current;
    const fail = (error: unknown) => {
      if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
    };
    const options = (target: EngineMesh, instance: boolean) => {
      const { color, ...rest } = latest.current.props;
      return {
        ...(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as object),
        mesh: target as unknown as MeshHandle,
        color: outlineRGB(color),
        geometry: !instance && registry.geometryOverride ? (registry.geometry ?? null) : undefined,
      };
    };
    // Instance outlines follow the drawn instances: new ones attach, removed or hidden-by-limit ones are released.
    const follow = () => {
      const meshes = registry.instanceMeshes?.();
      if (!meshes || !api || !active || scene.engine.disposed) return;
      if (outline) {
        outline.dispose();
        outline = plugin.current = null;
      }
      const wanted = new Set(meshes);
      for (const [m, o] of each)
        if (!wanted.has(m)) {
          o.dispose();
          each.delete(m);
        }
      for (const m of meshes)
        if (!each.has(m)) {
          const o = api.MeshOutline.attach(scene.engine, options(m, true));
          each.set(m, o);
          latest.current.onReady?.(o);
        }
    };
    let loading: Promise<typeof import('@margoengine/toon/outline')> | undefined;
    const load = () =>
      (loading ??= optionalPeer('@margoengine/toon', () => import('@margoengine/toon/outline')).then((loaded) => {
        api = loaded;
        return loaded;
      }));
    const attach = (target: EngineMesh) => {
      mesh = target;
      outline?.dispose();
      outline = plugin.current = null;
      load()
        .then((api) => {
          if (!active || mesh !== target || scene.engine.disposed) return;
          if (registry.instanceMeshes) return follow();
          outline = plugin.current = api.MeshOutline.attach(scene.engine, options(target, false));
          latest.current.onReady?.(outline);
        })
        .catch(fail);
    };
    registry.attachments.add(attach);
    const current = live(registry);
    if (current) attach(current);
    // A material that draws the mesh itself (TextureMaterial) keeps the geometry on the binding: follow it each frame.
    const stop = subscribeFrame(
      scene.frames,
      () => {
        try {
          follow();
        } catch (error) {
          fail(error);
        }
        if (outline) outline.geometry = registry.geometryOverride ? (registry.geometry ?? null) : undefined;
      },
      -50,
    );
    return () => {
      active = false;
      stop();
      registry.attachments.delete(attach);
      outline?.dispose();
      plugin.current = null;
      for (const o of each.values()) o.dispose();
      each.clear();
    };
  }, [scene, registry, props.renderOrder]);
  return null;
}
