  let nd1 = i.uv.y;
  let nd2 = (sin(ndu.time + (nd1 * 10.0)) * 0.5) + 0.5;
  let p=f.model*vec4f(i.position.xyz + (i.normal.xyz * (nd2 * 0.1)),1);
  o.ndv0 = i.position.xyz;
