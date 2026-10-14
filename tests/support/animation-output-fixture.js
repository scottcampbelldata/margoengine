import {animatedTriangle} from './gltf-pro-fixture.js';

/** Real glTF accessors cover every authored interpolation and transform/morph path. */
export function animationOutputFixture() {
  const fixture = animatedTriangle(), {doc, buffers} = fixture;
  const add = (values, type) => {
    const data = new Float32Array(values), id = doc.accessors.length, buffer = buffers.length, view = doc.bufferViews.length;
    buffers.push(data); doc.buffers.push({byteLength: data.byteLength}); doc.bufferViews.push({buffer, byteLength: data.byteLength});
    doc.accessors.push({bufferView: view, componentType: 5126, count: data.length / ({SCALAR: 1, VEC3: 3, VEC4: 4}[type]), type}); return id;
  };
  const time = add([0, 1], 'SCALAR'), values = {
    translation: [[0.12, -0.23, 0.34], [0.47, 0.19, -0.28]],
    rotation: [[0.11, 0.22, 0.33, 0.88], [-0.21, 0.13, 0.37, -0.84]],
    scale: [[1.12, 0.93, 1.27], [0.86, 1.23, 0.97]], weights: [[0.17], [0.79]]
  };
  doc.animations = ['STEP', 'LINEAR', 'CUBICSPLINE'].map(interpolation => {
    const channels = [], samplers = [];
    for (const [path, keys] of Object.entries(values)) {
      const data = interpolation === 'CUBICSPLINE' ? keys.flatMap((key, index) => [key.map((_, c) => (c + 1) * (index ? 0.07 : -0.03)), key, key.map((_, c) => (c + 1) * 0.05)]).flat() : keys.flat();
      const output = add(data, path === 'weights' ? 'SCALAR' : path === 'rotation' ? 'VEC4' : 'VEC3');
      channels.push({sampler: samplers.length, target: {node: path === 'weights' ? 0 : 1, path}}); samplers.push({input: time, output, interpolation});
    }
    return {name: interpolation, channels, samplers};
  });
  return fixture;
}
