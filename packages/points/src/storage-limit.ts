import type { PointCloud } from './cloud.js';
/**
 * Every per-point buffer of a cloud is one storage binding, so the widest one bounds the point count: 12 B positions
 * (and surfel normals), 4 B rgba8 or 16 B float colours. Throws before any buffer exists, naming the real ceiling.
 */
export function checkStorage(cloud: PointCloud, limits: GPUSupportedLimits, normals: number): void {
  const limit = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize),
    widest = Math.max(12, normals, cloud.colors ? 4 * cloud.colorStride : 0);
  if (cloud.count * widest > limit)
    throw new RangeError(
      `Point cloud of ${cloud.count} points exceeds the device storage limit of ${Math.floor(limit / widest)} points at ${widest} bytes a point; split it into several clouds${widest === 16 ? " or use colorFormat 'rgba8'" : ''}.`,
    );
}
