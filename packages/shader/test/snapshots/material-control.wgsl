  var nd1:vec3f = vec3f(0.0);
  let nd2 = i.uv.x;
  if (nd2 < 0.25) {
    nd1 = vec3f(1.0, 0.0, 0.0);
  } else {
    if (nd2 < 0.75) {
      let nd3 = sin(i.uv.y);
      nd1 = vec3f(nd3, nd3, 0.0);
    } else {
      nd1 = vec3f(0.0, 0.0, 1.0);
    }
  }
  let nd0 = nd1;
  s.base = vec4f(nd0, s.base.a);
