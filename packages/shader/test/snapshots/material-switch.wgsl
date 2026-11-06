  var nd1:f32 = 0.0;
  switch (ndu.mode) {
    case 0u: {
      nd1 = 0.25;
    }
    case 1u, 2u: {
      nd1 = 0.5;
    }
    default: {
    }
  }
  let nd0 = nd1;
  s.roughness = clamp(nd0, 0.045, 1.0);
