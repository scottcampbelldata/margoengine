  let nd0 = i.uv.y;
  s.base = vec4f(mix(vec3f(0.014444, 0.051269, 1.0), ndu.tint, vec3f(nd0)) * ((sin(ndu.time + (nd0 * 10.0)) * 0.5) + 0.5), s.base.a);
  s.roughness = clamp(nd0, 0.045, 1.0);
  s.emissive = i.ndv0 * 0.1;
  s.n = normalize(normalize(i.normal));
