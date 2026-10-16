import { Splats, validateSplats } from '../../packages/splats/dist/index.js';
import { fetchBytes, parsePCD } from '../../packages/loaders/dist/index.js';
import { controls } from './ui-scene.js';

export async function createWorkload(count = 4, options = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('Splat group count must be 1..9');
  const source = await fetchBytes(new URL('../../packages/loaders/tests/fixtures/bunny.pcd', import.meta.url), {
    ...options,
    maxBytes: 100000,
  });
  options.signal?.throwIfAborted();
  const base = parsePCD(source).positions,
    perGroup = base.length / 3,
    total = perGroup * count,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < base.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis], base[i]);
    max[axis] = Math.max(max[axis], base[i]);
  }
  const scale = 1.8 / Math.max(...max.map((value, axis) => value - min[axis])),
    positions = new Float32Array(total * 3),
    covariances = new Float32Array(total * 6),
    colors = new Float32Array(total * 4),
    sphericalHarmonics = new Float32Array(total * 12),
    points = new Float32Array(count * 4),
    side = Math.ceil(Math.sqrt(count)),
    extent = side * 1.3;
  const palette = [
    [0.22, 0.7, 0.48],
    [0.75, 0.47, 0.18],
    [0.42, 0.36, 0.75],
  ];
  for (let group = 0; group < count; group++) {
    const center = [((group % side) - (side - 1) / 2) * 2.6, 1.1, (Math.floor(group / side) - (side - 1) / 2) * 2.6];
    points.set([...center, group % 3], group * 4);
    for (let i = 0; i < perGroup; i++) {
      const id = group * perGroup + i;
      for (let axis = 0; axis < 3; axis++)
        positions[id * 3 + axis] = center[axis] + (base[i * 3 + axis] - (min[axis] + max[axis]) / 2) * scale;
      const angle = i * 0.37,
        c = Math.cos(angle),
        s = Math.sin(angle),
        a = 0.009,
        b = 0.0025;
      covariances.set([a * c * c + b * s * s, (a - b) * c * s, 0, a * s * s + b * c * c, 0, 0.004], id * 6);
      colors.set([...palette[group % 3], 0.55], id * 4);
      for (let channel = 0; channel < 3; channel++)
        sphericalHarmonics[id * 12 + channel] = (palette[group % 3][channel] - 0.5) / 0.2820947918;
      sphericalHarmonics[id * 12 + 9] = 0.18;
      sphericalHarmonics[id * 12 + 11] = -0.18;
    }
  }
  const data = { positions, covariances, colors },
    inputCount = validateSplats({ ...data, sphericalHarmonics });
  let cloud,
    context,
    ui,
    disposed = false,
    time = 0,
    frames = 0,
    sh = false,
    orbit = true,
    cameraPosition,
    cameraStart,
    target,
    horizontalRadius,
    initialAngle;
  const detach = () => {
    cloud?.dispose();
    cloud = undefined;
  };
  const attach = () => {
    cloud = Splats.attach(context.engine, sh ? { ...data, sphericalHarmonics } : data);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    detach();
    ui?.dispose();
    if (context && cameraStart) context.engine.camera.position = cameraStart;
    context = undefined;
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  const retainCamera = () => {
    cameraStart = context.engine.camera.position;
    cameraPosition = Array.from(cameraStart);
    target = Array.from(context.engine.camera.target);
    horizontalRadius = Math.hypot(cameraPosition[0] - target[0], cameraPosition[2] - target[2]);
    initialAngle = Math.atan2(cameraPosition[0] - target[0], cameraPosition[2] - target[2]) - time * 0.25;
    context.engine.camera.position = cameraPosition;
  };
  return {
    points,
    renderedObjects: 1,
    expectedEngineVisible: 0,
    get data() {
      return data;
    },
    get cloud() {
      return cloud;
    },
    bounds: { min: [-extent, 0, -extent], max: [extent, 2.3, extent] },
    description:
      'Actual Gaussian splats derive from the existing Stanford bunny PCD: positive-definite rotated anisotropic covariances produce ellipses, with opacity 0.55 and one combined cloud for global GPU radix depth sorting. The camera orbits continuously; optional first-degree spherical harmonics change view-dependent color. Core cubes are cleared; counts distinguish bunny groups, splats and draws.',
    step(delta) {
      if (disposed) return;
      if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid splat frame delta');
      time += delta;
      frames++;
      if (context) {
        if (context.engine.camera.position !== cameraPosition) retainCamera();
        if (orbit) {
          const angle = initialAngle + time * 0.25;
          cameraPosition[0] = target[0] + Math.sin(angle) * horizontalRadius;
          cameraPosition[2] = target[2] + Math.cos(angle) * horizontalRadius;
        }
      }
    },
    mount(value) {
      if (disposed) throw new Error('Splat workload is disposed');
      options.signal?.throwIfAborted();
      if (context) throw new Error('Splat workload is already mounted');
      if (value.engine.backend !== 'webgpu')
        throw new Error('Splats benchmark requires actual WebGPU projection/sorting/draws');
      context = value;
      try {
        value.meshes.forEach((mesh) => mesh.setGeometry(null));
        attach();
        retainCamera();
        ui = controls(value.parent, count, () => {});
        ui.actor.parentElement.remove();
        ui.button('Toggle view-dependent SH color', () => {
          sh = !sh;
          detach();
          attach();
          value.render();
        }).dataset.uiSplatsSh = '';
        ui.button('Toggle camera orbit', () => {
          orbit = !orbit;
          if (orbit)
            initialAngle = Math.atan2(cameraPosition[0] - target[0], cameraPosition[2] - target[2]) - time * 0.25;
          value.render();
        }).dataset.uiSplatsOrbit = '';
      } catch (error) {
        dispose();
        throw error;
      }
    },
    details: () => ({
      bunnyGroups: count,
      splats: inputCount,
      splatsPerGroup: perGroup,
      independentSorts: cloud ? 1 : 0,
      frames,
      opacity: 0.55,
      viewDependentColor: sh,
      cameraOrbit: orbit,
      sourceBytes: source.length,
    }),
    dispose,
  };
}
