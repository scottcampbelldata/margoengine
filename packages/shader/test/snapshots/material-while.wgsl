  var nd1:f32 = 64.0;
  var nd2:f32 = 0.0;
  loop {
    if (!(nd1 > 1.0)) { break; }
    nd1 = nd1 / 2.0;
    nd2 = nd2 + 1.0;
  }
  let nd0 = nd2;
  s.roughness = clamp(nd0, 0.045, 1.0);
