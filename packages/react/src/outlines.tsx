import { createElement, useContext, useEffect, useRef, type ReactElement } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf/pbr';
import type { MeshOutline, MeshOutlineOptions } from '@margoengine/toon/outline';
import type { ModelOutlines } from '@margoengine/toon/models';
import { colorKey, live, ModelContext, ModelScope, report, useMesh, useScene } from './internal.js';
import { inScene } from './scene-owner.js';
import { optionalPeer } from './optional.js';
import { subscribeFrame } from './frame-priority.js';
import { rangeError } from '../../shared/errors.js';

/** Props of `<Outlines>`: drei's names, every one optional. */
export interface OutlinesProps extends Omit<MeshOutlineOptions, 'mesh' | 'geometry' | 'color'> {
  /** Line colour: `#rgb`/`#rrggbb` (sRGB) or linear RGB numbers 0 or more. Default black. */
  color?: string | readonly [number, number, number];
  /** Called with the native `MeshOutline` of `@margoengine/toon/outline` once it is attached. */
  onReady?: (outline: MeshOutline) => void;
  /**
   * Inside a `<Model>`: the glTF node name whose primitives (its own and its descendants') are outlined. Default the
   * whole model. Needs a `<Model>` parent.
   */
  node?: string;
  /** Inside a `<Model>`: called with the native `ModelOutlines` of `@margoengine/toon/models` once it is attached. */
  onModelReady?: (outlines: ModelOutlines) => void;
  onError?: (error: unknown) => void;
}

const srgb = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** `color` as linear RGB: a hex string is sRGB, numbers pass through. */
export function outlineRGB(color: OutlinesProps['color']): [number, number, number] {
  if (color === undefined) return [0, 0, 0];
  if (typeof color !== 'string') return [color[0], color[1], color[2]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex)
    throw rangeError(
      `Outlines color '${color}' is not #rgb or #rrggbb; pass a hex colour or three numbers`,
      'react-arguments',
    );
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => srgb(parseInt(full.slice(i, i + 2), 16) / 255)) as [number, number, number];
}

/**
 * drei's `Outlines`: an inverted-hull outline around the enclosing mesh (`<Box><Outlines /></Box>`), drawn by
 * `MeshOutline` of `@margoengine/toon/outline`. It follows the mesh's transform, geometry and visibility; a prop change
 * applies live (`renderOrder` re-attaches). Needs WebGPU or the WebGL2 compatibility layer and `@margoengine/toon`.
 * Directly inside a `<Model>` (drei's outlined `skinnedMesh`) it outlines the model's posed, skinned and morphed
 * vertices of each frame with `ModelOutlines` of `@margoengine/toon/models` (WebGPU only), the whole model or `node`.
 */
export function Outlines(props: OutlinesProps): ReactElement {
  const scene = useScene(),
    scope = useContext(ModelScope),
    model = useContext(ModelContext);
  // The model is the nearest parent when no <Mesh> inside it replaced the registry it sits in.
  return scope !== undefined && scope === scene.registry
    ? createElement(ModelHull, { ...props, model: model ?? null })
    : createElement(MeshHull, props);
}

/** What `ModelOutlines` cannot draw yet: refused, never ignored. */
function unsupported(props: OutlinesProps): string | undefined {
  if (props.transparent) return 'transparent';
  if (props.toneMapped === false) return 'toneMapped={false}';
  if (props.polygonOffset) return 'polygonOffset';
  if (props.renderOrder) return 'renderOrder';
  if (props.angle !== undefined && props.angle !== 0 && props.angle !== Math.PI) return `angle ${props.angle}`;
  return undefined;
}
/** The live `ModelOutlines` settings of these props on `model`; throws on a prop it cannot draw or an unknown node. */
function modelSettings(model: PBRModel, props: OutlinesProps) {
  const refused = unsupported(props);
  if (refused)
    throw rangeError(
      `Outlines inside a <Model> cannot draw ${refused} yet; remove it, or outline a <Mesh> (angle takes 0 or pi)`,
      'react-arguments',
    );
  const nodes = props.node === undefined ? undefined : model.nodes.filter((n) => n.name === props.node);
  if (nodes && !nodes.length)
    throw rangeError(
      `Outlines node '${props.node}' is not a node of the model; pass one of its glTF node names`,
      'react-arguments',
    );
  return { outline: props.thickness ?? 0.05, color: outlineRGB(props.color), smooth: props.angle !== 0, nodes };
}

/** `<Outlines>` directly inside a `<Model>`: one `ModelOutlines` for that model. */
function ModelHull({
  model,
  onReady: _ready,
  onModelReady,
  onError,
  ...props
}: OutlinesProps & { model: PBRModel | null }): null {
  const scene = useScene(),
    latest = useRef({ props, onModelReady, onError }),
    hull = useRef<ModelOutlines | null>(null);
  latest.current = { props, onModelReady, onError };
  const key = JSON.stringify({ ...props, color: colorKey(props.color) });
  useEffect(() => {
    try {
      if (hull.current && model) Object.assign(hull.current, modelSettings(model, latest.current.props));
    } catch (error) {
      report(scene, error, latest.current.onError);
    }
  }, [key]);
  useEffect(() => {
    if (!model) return;
    let active = true,
      outline: ModelOutlines | null = null;
    const fail = (error: unknown) => {
      if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
    };
    optionalPeer<{ ModelOutlines: typeof ModelOutlines }>('@margoengine/toon', () =>
      props.screenspace ? import('@margoengine/toon/screen-outline') : import('@margoengine/toon/models'),
    )
      .then((api) => {
        if (!active || scene.engine.disposed || model.disposed) return;
        outline = hull.current = inScene(scene, () =>
          api.ModelOutlines.attach(scene.engine, {
            ...modelSettings(model, latest.current.props),
            models: [model],
          }),
        );
        latest.current.onModelReady?.(outline);
      })
      .catch(fail);
    return () => {
      active = false;
      outline?.dispose();
      hull.current = null;
    };
  }, [scene, model, props.screenspace]);
  return null;
}

/** `<Outlines>` inside a `<Mesh>` (or `<Instances>`): one `MeshOutline` per drawn mesh. */
function MeshHull({ onReady, onError, node, onModelReady: _model, ...props }: OutlinesProps): null {
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
    if (node !== undefined)
      report(
        scene,
        rangeError(
          `Outlines node '${node}' needs a <Model> parent; move the Outlines into the Model or drop node`,
          'react-arguments',
        ),
        latest.current.onError,
      );
  }, [node]);
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
          const o = inScene(scene, () => api!.MeshOutline.attach(scene.engine, options(m, true)));
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
          outline = plugin.current = inScene(scene, () => api.MeshOutline.attach(scene.engine, options(target, false)));
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
