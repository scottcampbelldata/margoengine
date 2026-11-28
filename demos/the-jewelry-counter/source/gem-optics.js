import { NodeMaterial, normalLocal, positionLocal, uniform, wgslFn } from '@margoengine/shader';

export function gemstoneOptics(facets, radius) {
  const eye = uniform([0.035, 0.026, 0.057], { type: 'vec3f', name: 'gemCamera' });
  const rotation = uniform(0, { name: 'gemStudioRotation' });
  const points = facets.map(([x, y, z, d]) =>
    'vec4f(' + [x, y, z, d / radius].map((n) => n.toFixed(9)).join(',') + ')').join(',\n');
  const shade = wgslFn(
    'fn jewelryShade(local: vec3f, surface: vec3f, cam: vec3f, spin: f32) -> vec3f {\n' +
    '  let p = local / ' + radius.toFixed(9) + ';\n' +
    '  let jEye = cam / ' + radius.toFixed(9) + ';\n' +
    '  let planes = array<vec4f,' + facets.length + '>(' + points + ');\n' +
    '  let n = normalize(surface);\n' +
    '  let incoming = normalize(p - jEye);\n' +
    '  let fresnel = 0.172 + 0.828 * pow(1.0 - clamp(dot(-incoming, n), 0.0, 1.0), 5.0);\n' +
    '  let reflected = jewelryStudio(reflect(incoming, n), spin);\n' +
    '  var radiance = vec3f(0.0);\n' +
    '  let spectrum = vec3f(2.407, 2.425, 2.453);\n' +
    '  for (var c: u32 = 0u; c < 3u; c++) {\n' +
    '    let ior = spectrum[c];\n' +
    '    var ray = refract(incoming,n,1.0/ior);\n' +
    '    var origin = p + ray * 0.0004;\n' +
    '    var throughput = 1.0 - fresnel;\n' +
    '    for (var b: u32 = 0u; b < 6u; b++) {\n' +
    '      var distance = 99.0;\n' +
    '      var normal = vec3f(0.0);\n' +
    '      for (var k: u32 = 0u; k < ' + facets.length + 'u; k++) {\n' +
    '        let facet = planes[k];\n' +
    '        let denominator = dot(facet.xyz, ray);\n' +
    '        if (denominator > 0.0001) {\n' +
    '          let t = (facet.w - dot(facet.xyz, origin)) / denominator;\n' +
    '          if (t > 0.0001 && t < distance) { distance = t; normal = facet.xyz; }\n' +
    '        }\n' +
    '      }\n' +
    '      if (distance >= 99.0) { break; }\n' +
    '      origin += ray * distance;\n' +
    '      let exit = refract(ray, -normal, ior);\n' +
    '      if (dot(exit, exit) > 0.5) {\n' +
    '        let exitF = 0.172 + 0.828 * pow(1.0 - clamp(dot(exit, normal), 0.0, 1.0), 5.0);\n' +
    '        radiance[c] += throughput * (1.0 - exitF) * jewelryStudio(exit, spin)[c];\n' +
    '        throughput *= exitF;\n' +
    '      }\n' +
    '      if (throughput < 0.025) { break; }\n' +
    '      ray = reflect(ray, normal);\n' +
    '      origin += ray * 0.0004;\n' +
    '    }\n' +
    '  }\n' +
    '  return clamp(radiance + reflected * fresnel + vec3f(0.026, 0.033, 0.042), vec3f(0.0), vec3f(18.0));\n' +
    '}\n' +
    'fn jewelryStudio(view: vec3f, angle: f32) -> vec3f {\n' +
    '  let d = vec3f(cos(angle)*view.x + sin(angle)*view.z, view.y, cos(angle)*view.z - sin(angle)*view.x);\n' +
    '  let panel = smoothstep(0.80,0.92,dot(d,normalize(vec3f(-0.65,0.75,0.42))));\n' +
    '  let strip = smoothstep(0.965,0.989,dot(d,normalize(vec3f(0.82,0.32,0.45))));\n' +
    '  let fill = smoothstep(0.80,0.93,dot(d,normalize(vec3f(0.0,0.58,-0.82))));\n' +
    '  let pin = smoothstep(0.982,0.994,dot(d,normalize(vec3f(-0.37,0.86,-0.35))));\n' +
    '  return vec3f(0.068, 0.081, 0.101) * (0.82 + 0.25 * d.y) + panel*vec3f(7.2,6.75,5.85) +\n' +
    '      strip*vec3f(9.0,10.8,13.9) + fill*vec3f(1.4,1.85,2.8) + pin*vec3f(13.0,11.6,8.15);\n' +
    '}\n',
  );
  const material = new NodeMaterial({
    shading: 'basic',
    colorNode: shade(positionLocal, normalLocal, eye, rotation),
  });
  return { material, eye, rotation };
}

