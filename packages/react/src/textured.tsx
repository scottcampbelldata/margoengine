import { useEffect, useRef } from 'react';
import type { Mesh as MeshHandle, EngineKernel } from '@margoengine/core';
import type { GeometryData } from '@margoengine/geometry';
import type { Model } from '@margoengine/gltf';
import { parseColor } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
import type { PbrMaterialProps } from './components.js';
import { live, report, useMesh, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { trackedFetch } from './assets.js';

/** A texture image: a URL (fetched through the Canvas asset cache, counted by `useProgress`) or the PNG or JPEG bytes. */
export type TextureSource = string | URL | Blob | ArrayBuffer | ArrayBufferView;

type ShapeKind = 'boxGeometry' | 'sphereGeometry' | 'planeGeometry';
/** Props of the textured shape body: the shape, its `args`, the map and the material numbers. */
export interface TexturedShapeProps extends PbrMaterialProps {
  kind: ShapeKind;
  args: readonly number[];
  map: TextureSource;
  castShadow?: boolean;
  receiveShadow?: boolean;
  onError?: (error: unknown) => void;
}
/**
 * The geometry and material of a `Box`, `Sphere` or `Plane` with a `map`: one light-loader glTF primitive (core mesh,
 * `@margoengine/gltf/textured` draws its base colour texture) parented to the enclosing `<Mesh>`, so it moves, picks
 * and disposes with it. Rebuilt when the shape, map or material changes.
 */
export function TexturedShape({
  kind,
  args,
  map,
  color = '#ffffff',
  roughness = 0.5,
  metalness = 0,
  castShadow = false,
  receiveShadow = true,
  onError,
}: TexturedShapeProps): null {
  const scene = useScene(),
    registry = useMesh(),
    error = useRef(onError);
  error.current = onError;
  const key = JSON.stringify(args),
    colorKey = typeof color === 'string' ? color : color.join();
  useEffect(() => {
    if (scene.world) {
      report(
        scene,
        new MargoError(
          'unsupported',
          'A textured Box, Sphere or Plane draws in the Canvas default scene only; move it out of <Scene name>, or load the shape as a glTF <Model>.',
        ),
        error.current,
      );
      return;
    }
    const abort = new AbortController();
    let model: Model | undefined,
      removeShadows: (() => void)[] = [];
    const attach = () => {
      if (model) registry.register(model.root as never);
    };
    (async () => {
      const [{ texturedDocument }, geometry, gltf, extension, image] = await Promise.all([
        import('./textured-document.js'),
        optionalPeer('@margoengine/geometry', () => import('@margoengine/geometry')),
        optionalPeer('@margoengine/gltf', () => import('@margoengine/gltf')),
        optionalPeer('@margoengine/gltf/textured', () => import('@margoengine/gltf/textured')),
        Promise.all([import('./textured-document.js'), trackedFetch(scene.assetCache)]).then(([{ bytesOf }, fetcher]) =>
          bytesOf(map, fetcher, abort.signal),
        ),
      ]);
      if (abort.signal.aborted || scene.engine.disposed) return;
      const create = geometry[kind] as (...args: number[]) => GeometryData;
      const linear = parseColor(color, [1, 1, 1, 1]) as ArrayLike<number>;
      const { doc, buffer } = texturedDocument(create(...args), image, {
        color: [linear[0], linear[1], linear[2], 1],
        roughness,
        metalness,
      });
      const loaded = await gltf.parseGLTFAsync(scene.engine as unknown as EngineKernel, doc, [buffer], {
        extensions: [extension.textured],
        signal: abort.signal,
      });
      if (abort.signal.aborted || scene.engine.disposed) {
        loaded.dispose();
        return;
      }
      model = loaded;
      registry.attachments.add(attach);
      if (live(registry)) attach();
      if (scene.shadows && (castShadow || !receiveShadow))
        removeShadows = loaded.meshes.map((mesh) =>
          scene.shadows!.add(mesh as unknown as MeshHandle, { castShadow, receiveShadow }),
        );
    })().catch((cause) => {
      if (!abort.signal.aborted && !scene.engine.disposed) report(scene, cause, error.current);
    });
    return () => {
      abort.abort();
      registry.attachments.delete(attach);
      for (const remove of removeShadows) remove();
      if (model) {
        registry.unregister(model.root as never);
        model.dispose();
      }
    };
  }, [scene.engine, scene.world, scene.shadows, registry, kind, key, map, colorKey, roughness, metalness, castShadow, receiveShadow]);
  return null;
}
