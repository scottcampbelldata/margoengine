import { forwardRef } from 'react';
import type { PointCloud, PointCloudOptions } from '@margoengine/points';
import { useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { attachBinding, detachBinding } from './package-binding.js';

/** Native point-cloud data, appearance and transform, plus an asynchronous error callback. */
export interface PointsProps extends PointCloudOptions {
  onError?: (error: unknown) => void;
}
let serial = 0;
const owners = new WeakMap<PointCloud, () => void>();
/** A native point cloud: per-point positions, colours and sizes, with the complete PointsMaterial options. */
export const Points = forwardRef<PointCloud, PointsProps>(function Points({ onError, ...options }, ref) {
  const scene = useScene();
  useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/points', () => import('@margoengine/points')),
      create: (api) => {
        const cloud = new api.PointCloud(options),
          plugin = new api.PointsPlugin({ name: `react-points:${++serial}` });
        if (!options.matrix && scene.registry?.current) cloud.attach(scene.registry.current);
        plugin.add(cloud);
        attachBinding(scene, plugin);
        owners.set(cloud, () => detachBinding(scene, plugin));
        return cloud;
      },
      dispose: (cloud) => {
        owners.get(cloud)?.();
        cloud.dispose();
      },
      ref,
      onError,
    },
    [
      scene.world,
      scene.registry,
      options.positions,
      options.colors,
      options.colorComponents,
      options.sizes,
      options.normals,
      options.material,
      options.blockSize,
      options.seed,
      options.colorFormat,
      options.colorSpace,
      options.reorder,
      options.matrix,
      options.cullMargin,
      options.name,
    ],
  );
  return null;
});
