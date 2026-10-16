  let nd0 = textureSample(ndt0, ndt0s, i.uv.xy);
  if ((nd0.w < ndu.cut) || (i.position.y > 1.0)) { discard; }
  let nd1 = nd0.xyz;
  s.base = vec4f(nd1, s.base.a);
  s.roughness = clamp(0.5, 0.045, 1.0);
