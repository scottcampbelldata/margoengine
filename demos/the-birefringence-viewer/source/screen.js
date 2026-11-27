import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { createSpectrum, lutLength, maxRetardationNm, specimenRadius } from './optics.js';

const vertex = `
struct Surface { @builtin(position) clip: vec4f, @location(0) plane: vec2f }
@vertex fn vertex(a: Attributes) -> Surface {
  return Surface(camera.viewProjection * mesh.world * vec4f(a.position, 1.0), a.plane);
}`;

const fragment = `
struct Surface { @builtin(position) clip: vec4f, @location(0) plane: vec2f }
@fragment fn fragment(i: Surface) -> @location(0) vec4f {
  let x = i.plane.x;
  let top = i.plane.y - 1.0;
  let bottom = i.plane.y + 1.0;
  let dTop = x*x + top*top;
  let dBottom = x*x + bottom*bottom;
  if (min(dTop, dBottom) < 0.016) { discard; }
  let a = 2.0 * top / (dTop*dTop);
  let b = -2.0 * bottom / (dBottom*dBottom);
  let difference = a * (x*x - top*top) + b * (x*x - bottom*bottom);
  let shear2 = 2.0 * x * (a*top + b*bottom);
  let magnitude2 = difference*difference + shear2*shear2;
  let rotatedShear2 = shear2 * uniforms.axisCos - difference * uniforms.axisSin;
  let orientation = rotatedShear2 * rotatedShear2 / max(magnitude2, 0.00001);
  let opd = 0.25 * sqrt(magnitude2) * uniforms.centerDelay;
  let coordinate = (clamp(opd / ${maxRetardationNm}.0, 0.0, 1.0) * ${lutLength - 1}.0 + 0.5) / ${lutLength}.0;
  let spectral = textureSampleLevel(fringeLut, fringeLutSampler, vec2f(coordinate, 0.5), 0.0).rgb * 1.30 - 0.15;
  let crossed = orientation * spectral;
  let transmitted = clamp(mix(crossed, vec3f(1.0) - crossed, uniforms.parallel), vec3f(0.0), vec3f(1.0));
  return margoEncode(vec4f(vec3f(0.0035, 0.0050, 0.0070) + 0.94 * transmitted, 1.0));
}`;

export function attachScreen(engine, mount, centerY, z) {
  const spectrum = createSpectrum();
  let texture;
  const material = new RawShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: { centerDelay: { value: 0 }, axisCos: { value: 1 }, axisSin: { value: 0 }, parallel: { value: 0 } },
    textures: {
      fringeLut: (device) => {
        texture = device.createTexture({
          label: 'Photoelastic transmission spectrum', size: [lutLength, 1], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture }, spectrum, { bytesPerRow: 4 * lutLength }, [lutLength, 1]);
        return texture;
      },
    },
    cull: 'none',
  });
  const sides = 120;
  const points = [0, centerY, z];
  const plane = [0, 0];
  const index = [];
  for (let i = 0; i < sides; i++) {
    const turn = 2 * Math.PI * i / sides;
    const x = Math.cos(turn), y = Math.sin(turn);
    points.push(x * specimenRadius, centerY + y * specimenRadius, z);
    plane.push(x, y);
    index.push(0, i + 1, (i + 1) % sides + 1);
  }
  const raw = RawShaders.attach(engine);
  raw.add(new RawMesh({
    mesh: mount, material,
    attributes: {
      position: { data: new Float32Array(points), type: 'vec3f' },
      plane: { data: new Float32Array(plane), type: 'vec2f' },
    },
    index,
  }));
  return {
    async ready() { await raw.ready(); if (material.error) throw material.error; },
    update(delay, angle, parallel) {
      material.uniforms.centerDelay.value = delay;
      material.uniforms.axisCos.value = Math.cos(2 * angle);
      material.uniforms.axisSin.value = Math.sin(2 * angle);
      material.uniforms.parallel.value = Number(parallel);
    },
    dispose() { texture?.destroy(); },
  };
}
