import { forwardRef, useMemo, type Ref } from 'react';
import { Camera, type CameraOptions, type Vec3 } from '@margoengine/core';
import type { CameraProjection, ProjectionOptions } from '@margoengine/cameras';
import { assignRef, useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

/** Perspective camera settings and an optional lease on the Canvas's default camera. */
export interface PerspectiveCameraProps extends CameraOptions {
  /** Configure the Canvas camera and restore its previous settings on unmount. Default false. */
  makeDefault?: boolean;
  up?: Vec3;
}
/** Camera pose plus native orthographic bounds, zoom and framing options. */
export interface OrthographicCameraProps
  extends PerspectiveCameraProps,
    Omit<ProjectionOptions, 'mode' | 'near' | 'far' | 'up'> {
  onError?: (error: unknown) => void;
}
type Settings = CameraOptions & { up: Vec3; project?: Camera['project'] };
interface Hold {
  camera: Camera;
  saved: Settings;
  descriptors: (PropertyDescriptor | undefined)[];
  projection?: CameraProjection;
  activate(): void;
  apply(): void;
}
const holds = new WeakMap<Camera, Hold[]>();
function settings(camera: Camera): Settings {
  return {
    position: camera.position,
    target: camera.target,
    up: camera.up,
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    project: camera.project,
  };
}
function pose(camera: Camera): Omit<Settings, 'project'> {
  const { project: _project, ...value } = settings(camera);
  return value;
}
const projectionFields = ['up', 'fixedOrthographic'] as const;
function useDefault(
  camera: Camera,
  makeDefault: boolean,
  ref: Ref<Camera> | undefined,
  revision: string,
  projection?: CameraProjection,
): void {
  const scene = useScene(),
    base = scene.engine.camera;
  useCommit(() => {
    if (!makeDefault) {
      if (!projection) return;
      projection.dispose();
      projection.attach(camera);
      return () => projection.dispose();
    }
    const stack = holds.get(base) ?? [];
    holds.set(base, stack);
    const previous = stack.at(-1);
    const saved = settings(base),
      descriptors = projectionFields.map((key) => Object.getOwnPropertyDescriptor(base, key));
    previous?.projection?.dispose();
    if (previous) Object.assign(previous.camera, pose(base));
    const hold: Hold = {
      camera,
      saved,
      descriptors,
      projection,
      activate: () => {
        projection?.dispose();
        Object.defineProperty(base, 'up', { configurable: true, enumerable: true, writable: true, value: camera.up });
        delete (base as { fixedOrthographic?: boolean }).fixedOrthographic;
        Object.assign(base, pose(camera));
        base.project = projection ? undefined : camera.project;
        projection?.attach(base);
      },
      apply: () => {
        if (stack.at(-1) === hold) Object.assign(base, pose(camera));
      },
    };
    stack.push(hold);
    scene.cameraOverrides.add(hold.apply);
    hold.activate();
    return () => {
      scene.cameraOverrides.delete(hold.apply);
      const index = stack.indexOf(hold),
        top = index === stack.length - 1;
      projection?.dispose();
      if (top) Object.assign(camera, pose(base));
      if (index >= 0) {
        // If an underlying mount disappears, the next mount must restore through it, never to a removed camera.
        if (!top) {
          stack[index + 1].saved = hold.saved;
          stack[index + 1].descriptors = hold.descriptors;
        }
        stack.splice(index, 1);
      }
      if (top) {
        Object.assign(base, hold.saved);
        projectionFields.forEach((key, i) => {
          const descriptor = hold.descriptors[i];
          if (descriptor) Object.defineProperty(base, key, descriptor);
          else delete (base as unknown as Record<string, unknown>)[key];
        });
        stack.at(-1)?.activate();
      }
      if (!stack.length) holds.delete(base);
    };
  }, [base, camera, makeDefault, projection, scene.cameraOverrides]);
  useCommit(() => {
    const active = holds.get(base)?.at(-1);
    if (makeDefault && active?.camera === camera) active.apply();
  }, [base, camera, makeDefault, revision]);
  useCommit(() => {
    assignRef(ref, makeDefault ? base : camera);
    return () => assignRef(ref, null);
  }, [base, camera, makeDefault, ref]);
}
function useCameraObject({
  position = [0, 2, 5],
  target = [0, 0, 0],
  fov = 60,
  near = 0.1,
  far = 1000,
  up = [0, 1, 0],
}: PerspectiveCameraProps): Camera {
  const camera = useMemo(() => new Camera(), []);
  useCommit(() => {
    Object.assign(camera, { position, target, fov, near, far, up });
  }, [...position, ...target, ...up, fov, near, far]);
  return camera;
}
/** A perspective camera; a non-default ref can be passed to RenderView. Default cameras retain the engine handle. */
export const PerspectiveCamera = forwardRef<Camera, PerspectiveCameraProps>(function PerspectiveCamera(props, ref) {
  const camera = useCameraObject(props);
  useDefault(camera, props.makeDefault ?? false, ref, JSON.stringify(props));
  return null;
});
/** Orthographic camera driven by the optional cameras package, with resize-aware height, bounds and zoom. */
export const OrthographicCamera = forwardRef<Camera, OrthographicCameraProps>(function OrthographicCamera(
  { makeDefault = false, onError, ...props },
  ref,
) {
  const scene = useScene(),
    camera = useCameraObject(props);
  const { position, target, fov, up, ...projectionOptions } = props;
  const projection = useCreated<typeof import('@margoengine/cameras'), CameraProjection>(
    scene,
    {
      load: () => optionalPeer('@margoengine/cameras', () => import('@margoengine/cameras')),
      create: (api) => {
        const value = new api.CameraProjection({ ...projectionOptions, mode: 'orthographic' });
        value.attach(camera);
        return value;
      },
      dispose: (value) => value.dispose(),
      onError,
    },
    [camera, JSON.stringify(projectionOptions)],
  );
  // Publish the projection only after attachment; changes restore the old lease before installing the new one.
  return projection ? (
    <DefaultOrthographic
      camera={camera}
      projection={projection}
      makeDefault={makeDefault}
      cameraRef={ref}
      revision={JSON.stringify(props)}
    />
  ) : null;
});
function DefaultOrthographic({
  camera,
  makeDefault,
  cameraRef,
  revision,
  projection,
}: {
  camera: Camera;
  makeDefault: boolean;
  cameraRef: Ref<Camera>;
  revision: string;
  projection: CameraProjection;
}) {
  useDefault(camera, makeDefault, cameraRef, revision, projection);
  return null;
}
