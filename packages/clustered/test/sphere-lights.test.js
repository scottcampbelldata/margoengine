// PointLight.radius: sphere lights (Karis 2013 representative point and energy normalisation). The bound itself, peak
// specular on a metal at most F0 x intensity / (pi radius^2) at every distance, is measured on the GPU by
// scripts/clustered-sphere-light-gpu-check.js; here: the packing, the shader variants, the culling pipeline and the
// shadow radius default, and that lights without a radius keep every byte they had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered, clusteredSampling } from '../dist/index.js';
import { LocalShadows } from '../dist/shadows.js';
import { cullingShader, sizedCullingShader } from '../src/shader.ts';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { capFormFactor, capFormFactorSampled, sphereBound, sphereIrradiance } from './sphere-irradiance-reference.js';

function harness() {
  const h = optionalGPU(),
    gpu = h.engine.gpu,
    modules = [],
    create = gpu.createShaderModule.bind(gpu);
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUTextureUsage = {
    ...globalThis.GPUTextureUsage,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 16,
  };
  gpu.limits.maxTextureDimension2D = 8192;
  gpu.createBindGroupLayout = (d) => ({ ...d });
  gpu.createPipelineLayout = (d) => ({ ...d });
  gpu.createShaderModule = (d) => {
    modules.push(d.code);
    return create(d);
  };
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport() {} });
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
  };
  return { ...h, modules, frame };
}
const point = { position: [0, 2, 0], range: 6, color: [1, 0.8, 0.6], intensity: 3 },
  spot = { position: [3, 2, 0], range: 8, direction: [0, -1, 0], angle: 0.5, penumbra: 0.2 },
  /** The light buffer's bytes as the last frame uploaded them. */
  uploaded = (lights) => new Float32Array(lights.bindings()[1].resource.buffer.data);

test('light radius: validated, finite and 0 or more', () => {
  const lights = new Clustered();
  for (const radius of [-0.1, Infinity, Number.NaN, '0.1', 1e40])
    assert.throws(
      () => lights.setLights([{ ...point, radius }]),
      /Light radius must be a finite number/,
      String(radius),
    );
  assert.doesNotThrow(() =>
    lights.setLights([
      { ...point, radius: 0 },
      { ...spot, radius: 0.25 },
    ]),
  );
});

test('light radius 0 or unset: the same records, shaders, culling and uploads as before, byte for byte', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] });
  try {
    lights.setLights([point, spot]);
    h.frame();
    const plainShader = h.context.shader,
      plainData = uploaded(lights).slice(),
      plainDeclarations = lights.pbr(1).declarations;
    assert.deepEqual(h.modules, [cullingShader], 'one culling module, the point records one');
    assert.equal(plainDeclarations, clusteredSampling(1, undefined, undefined, false, true));
    assert.equal(
      clusteredSampling(1),
      clusteredSampling(1, undefined, undefined, false, false, false, { sized: false }),
    );
    assert.ok(!plainShader.includes('size:vec4f') && !plainShader.includes('light.size'));
    lights.setLights([
      { ...point, radius: 0 },
      { ...spot, radius: 0 },
    ]);
    h.frame();
    assert.equal(lights['stride'], 16);
    assert.equal(h.context.shader, plainShader, 'radius 0 compiles the point lights shader');
    assert.equal(lights.pbr(1).declarations, plainDeclarations);
    assert.deepEqual(uploaded(lights), plainData, 'and uploads the same records');
    assert.equal(h.modules.length, 1, 'no new culling pipeline');
  } finally {
    lights.dispose();
  }
});

test('light radius above 0: 20-float records with the radius, the sphere-light shaders, and back again', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] });
  try {
    lights.setLights([point, spot]);
    h.frame();
    const plainShader = h.context.shader,
      plainData = uploaded(lights).slice(0, 32);
    lights.setLights([
      { ...point, radius: 0.15 },
      { ...spot, radius: 0 },
    ]);
    h.frame();
    assert.equal(lights['stride'], 20);
    const data = uploaded(lights);
    assert.deepEqual([...data.slice(0, 16)], [...plainData.slice(0, 16)], 'the first 16 floats are the point record');
    assert.deepEqual([...data.slice(16, 20)], [Math.fround(0.15), 0, 0, 0], 'then its size: the radius');
    assert.deepEqual([...data.slice(20, 36)], [...plainData.slice(16, 32)], 'the spot record');
    assert.deepEqual([...data.slice(36, 40)], [0, 0, 0, 0], 'radius 0 in a sized list');
    assert.equal(h.modules.at(-1), sizedCullingShader, 'culling reads the 20-float records');
    assert.match(sizedCullingShader, /params:vec4f,size:vec4f\}/);
    const declarations = lights.pbr(1).declarations;
    assert.equal(declarations, clusteredSampling(1, undefined, undefined, false, true, false, { sized: true }));
    assert.match(
      h.context.shader,
      /struct ClusterLight \{positionRange:vec4f,colorIntensity:vec4f,directionOuter:vec4f,params:vec4f,size:vec4f\}/,
    );
    // Karis 2013 eq. 11: representative point; eq. 10 and 14: alpha' and (alpha / alpha')^2.
    assert.match(
      declarations,
      /let ray=dot\(delta,rr\)\*rr-delta;let sp=delta\+ray\*clamp\(rs\/max\(length\(ray\),0\.000001\),0\.0,1\.0\);/,
    );
    // ... and its anisotropic form over the half-vector Jacobian (Walter et al. 2007 eq. 14).
    assert.match(
      declarations,
      /let along=spread\/max\(svh,0\.0001\);let ax=max\(min\(a\+spread,1\.0\),spread\);let ay=max\(min\(a\+along,1\.0\),along\);let norm=select\(1\.0,\(a\/ax\)\*\(a\/ay\),rs>0\.0\);/,
    );
    assert.match(
      declarations,
      /let d=a2\/\(3\.14159265\*pow\(max\(dot\(cross\(n,sh\),cross\(n,sh\)\),step\(snh,0\.0\)\)\+a2\*snh\*snh,2\.0\)\)\*norm;/,
    );
    assert.match(declarations, /pow\(1-svh,5\.0\);/);
    // The BRDF text the material packages rewrite is unchanged (materials' Lambert and Phong, toon, physical lobes).
    assert.equal(
      declarations.split('result+=').length,
      plainShader.slice(0, plainShader.indexOf('fn vertex')).split('result+=').length,
    );
    assert.ok(declarations.includes(clusterBrdfTerm(plainShader)));
    lights.setLights([point, spot]);
    h.frame();
    assert.equal(lights['stride'], 16);
    assert.equal(h.context.shader, plainShader, 'without a radius again: the original shader');
    assert.deepEqual([...uploaded(lights).slice(0, 32)], [...plainData], 'and the original records');
    assert.equal(h.modules.at(-1), sizedCullingShader, 'the point culling pipeline is reused, not rebuilt');
  } finally {
    lights.dispose();
  }
});
/** The `result+=<brdf>*nl*` head of the point loop in a core shader. */
const clusterBrdfTerm = (shader) => {
  const at = shader.indexOf('result+=((1-mix(');
  return shader.slice(at, shader.indexOf('*nl*', at) + 4);
};

test('light radius is the default shadow radius of a castShadow light (PCSS); shadow.radius overrides it', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 2, resolution: 64 }),
    frame = () => new Float32Array(shadows.bindings()[0].resource.buffer.data),
    caster = {
      shadowPrimitives: [
        {
          node: {
            id: 0,
            engine: h.engine,
            matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            check() {},
          },
          vertex: {},
          index: {},
          count: 36,
          stride: 80,
        },
      ],
    },
    shadowed = { position: [0, 3, 0], range: 10, castShadow: true };
  shadows.add(caster);
  try {
    lights.setLights([shadowed]);
    h.frame();
    const plain = h.context.shader;
    assert.ok(!plain.includes('clusterSoftShadow'));
    lights.setLights([{ ...shadowed, radius: 0.5 }]);
    h.frame();
    assert.match(h.context.shader, /fn clusterSoftShadow\(/, 'radius 0.5 turns on PCSS');
    const v = frame(),
      at = v.length - 16 * 8;
    assert.ok(Math.abs(v[at + 6] - 0.5) < 1e-6, `the PCSS radius is the light's: ${v[at + 6]}`);
    lights.setLights([{ ...shadowed, radius: 0.5, shadow: { radius: 0 } }]);
    h.frame();
    assert.ok(!h.context.shader.includes('clusterSoftShadow'), 'shadow.radius 0 keeps the 3x3 filter');
    lights.setLights([{ ...shadowed, radius: 0.5, shadow: { radius: 0.2 } }]);
    h.frame();
    assert.ok(Math.abs(frame()[at + 6] - 0.2) < 1e-6, 'shadow.radius wins');
  } finally {
    shadows.dispose();
    lights.dispose();
  }
});

// KB-FIRE-WALLHOT1: a sphere light's diffuse is the sphere's irradiance (Snyder 1996's cap form factor, horizon
// included), not its centre's inverse square, which the Cabin Hearth firebox back, 0.09 m from flame spheres of
// 0.634 m, took 50 times past the sphere's own radiance. The GPU check measures the shader against this reference.
test('sphere light diffuse: the cap form factor matches Monte Carlo and never exceeds pi L at any distance', () => {
  for (const s2 of [0.01, 0.2, 0.6, 0.95, 1])
    for (let degrees = 0; degrees <= 180; degrees += 15) {
      const c = Math.cos((degrees * Math.PI) / 180),
        exact = capFormFactor(c, s2),
        sampled = capFormFactorSampled(c, s2, 400);
      assert.ok(
        Math.abs(exact - sampled) <= 4e-3 * Math.PI * s2,
        `sin^2 sigma ${s2}, ${degrees} deg: ${exact} vs ${sampled}`,
      );
    }
  for (const r of [0.02, 0.155, 0.634])
    for (const ratio of [0.01, 0.1, 0.5, 0.99, 1, 1.01, 2, 10, 100])
      for (let degrees = 0; degrees <= 180; degrees += 5) {
        const c = Math.cos((degrees * Math.PI) / 180),
          d = r * ratio,
          e = sphereIrradiance(c, d, r);
        assert.ok(e <= sphereBound(r) * (1 + 1e-12), `r ${r}, d ${d}, ${degrees} deg: ${e} > ${sphereBound(r)}`);
        // Fully above the horizon and outside the sphere it is the point light's I cos theta / d^2 exactly.
        if (ratio >= 1 && c * c >= 1 / (ratio * ratio)) assert.ok(Math.abs(e * d * d - Math.max(c, 0)) < 1e-12);
      }
  // Continuous through the sphere's surface, and the point light's term is unbounded there.
  for (const c of [1, 0.5, 0, -0.5])
    assert.ok(Math.abs(sphereIrradiance(c, 0.634 * (1 - 1e-9), 0.634) - sphereIrradiance(c, 0.634, 0.634)) < 1e-6);
  assert.ok(sphereIrradiance(1, 0.09, 0) / sphereBound(0.634) > 49, 'a point at the firebox back: 50 times the bound');
});

test('sphere light diffuse: the sized loop writes the cap form factor as its nl; the point loop does not', () => {
  const sized = clusteredSampling(1, undefined, undefined, false, false, false, { sized: true }),
    plain = clusteredSampling(1);
  assert.match(sized, /let sfs=min\(rs\*rs\/max\(distance\*distance,0\.000001\),1\.0\);var sfg=max\(sfc,0\.0\);/);
  assert.match(
    sized,
    /sfg=clamp\(\(\(sfc\*acos\(sfy\)-sfx\*sfq\)\*sfs\+atan2\(sfq,sfx\)\)\/\(3\.14159265\*sfs\),0\.0,1\.0\);/,
  );
  assert.match(
    sized,
    /let nl=select\(clamp\(dot\(n,l\),0\.0,1\.0\),sfg\*select\(1\.0,max\(distance\*distance,0\.000244140625\)\/\(rs\*rs\),distance<rs\),rs>0\.0\);/,
  );
  assert.equal(sized.split('let nl=').length, plain.split('let nl=').length, 'one nl per loop, as before');
  assert.ok(!plain.includes('sfg') && plain.includes('let nl=clamp(dot(n,l),0.0,1.0);'));
});
