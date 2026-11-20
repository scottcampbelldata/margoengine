import { useEffect, useRef } from 'react';
import { report, useScene, type Scene } from './internal.js';

/** Props of `<Preload>`; every prop is optional. */
export interface PreloadProps {
  /** Draws hidden meshes too, so their pipelines and textures are ready before they are shown. Default false. */
  all?: boolean;
  /** Gets a failed warm-up draw. Default: the Canvas onError. */
  onError?: (error: unknown) => void;
}
function warm(scene: Scene, all: boolean): void {
  const { engine } = scene;
  if (engine.disposed) return;
  const shown: { visible: boolean }[] = [];
  if (all)
    for (const mesh of engine.meshes.values())
      if (!mesh.visible) {
        mesh.visible = true;
        shown.push(mesh);
      }
  try {
    // Culling off: every mesh and model is drawn once, so its pipelines compile and its buffers and textures upload.
    engine.render({ culling: false, delta: 0 });
  } finally {
    for (const mesh of shown) mesh.visible = false;
  }
}
/**
 * Warms the Canvas up, as drei's `<Preload>`: draws the whole scene once with frustum culling off when it mounts, and
 * again on the next frame after loading (`useProgress`) settles with a new model in the Canvas, so every pipeline is
 * compiled and every buffer and texture uploaded before the camera first turns to it. `all` also draws hidden meshes.
 * Place it after the content it should cover.
 */
export function Preload({ all = false, onError }: PreloadProps): null {
  const scene = useScene(),
    latest = useRef({ all, onError });
  latest.current = { all, onError };
  useEffect(() => {
    const { resources, assetCache } = scene;
    let models = resources.models.size;
    const run = () => {
      models = resources.models.size;
      try {
        warm(scene, latest.current.all);
      } catch (error) {
        report(scene, error, latest.current.onError);
      }
    };
    // A model joins the Canvas a few awaits after its file loads: check each frame, which costs one comparison.
    const frame = () => {
      if (resources.models.size > models && !assetCache.tracker?.state.active) run();
      else if (resources.models.size < models) models = resources.models.size;
    };
    run();
    scene.frames.callbacks.add(frame);
    return () => {
      scene.frames.callbacks.delete(frame);
    };
  }, [scene]);
  return null;
}
