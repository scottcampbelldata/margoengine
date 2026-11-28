import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';

export function attachMarks(engine, anchors) {
  const material = new RawShaderMaterial({
    vertexShader: `
struct Spot { @builtin(position) clip: vec4f, @location(0) position: vec2f }
@vertex fn vertex(a: Attributes) -> Spot {
  return Spot(camera.viewProjection * mesh.world * vec4f(a.position,1.0),a.point);
}`,
    fragmentShader: `
struct Spot { @builtin(position) clip: vec4f, @location(0) position: vec2f }
@fragment fn fragment(i: Spot) -> @location(0) vec4f {
  let radius2 = dot(i.position,i.position);
  let core = exp(-22.0 * radius2);
  let bloom = exp(-4.7 * radius2) * 0.64;
  let opacity = (core * 0.80 + bloom) * (1.0 - smoothstep(0.67,1.0,radius2));
  return vec4f(margoEncode(vec4f(mix(uniforms.tint,vec3f(0.97),core*0.73),1.0)).rgb,min(1.0,opacity));
}`,
    uniforms: { tint: { value: [.12,.9,.33] } },
    transparent: true,
    blending: 'additive',
    depthWrite: false,
    cull: 'none',
  });
  const raw = RawShaders.attach(engine);
  const r = .033;
  const positions = new Float32Array([-r,-r,0,r,-r,0,r,r,0,-r,r,0]);
  const points = new Float32Array([-1,-1,1,-1,1,1,-1,1]);
  const marks = anchors.map((mesh) => raw.add(new RawMesh({
    material, mesh,
    attributes: { position: { data: positions,type:'vec3f' }, point: { data: points,type:'vec2f' } },
    index: [0,1,2,0,2,3],
  })));
  return {
    async ready() { await raw.ready(); if (material.error) throw material.error; },
    update(color) { material.uniforms.tint.value = color; },
    marks,
  };
}
