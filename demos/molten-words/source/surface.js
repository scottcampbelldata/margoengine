// A single linear-light material serves the hot type, drips, refractory bed and steel frame.
export const foundrySurface = /* wgsl */ `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) surface: f32,
}
@vertex fn vertex(a: Attributes) -> Out {
  let w = mesh.world * vec4f(a.position, 1.0);
  return Out(camera.viewProjection * w, w.xyz, normalize(mesh.normal * a.normal), a.surface);
}
fn hash(p: vec2f) -> f32 {
  let v = fract(vec3f(p.x, p.y, p.x) * .1031);
  let n = v + dot(v, v.yzx + 33.33);
  return fract((n.x + n.y) * n.z);
}
fn grain(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let t = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i),hash(i+vec2f(1,0)),t.x),
    mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),t.x),t.y);
}
@fragment fn fragment(i: Out) -> @location(0) vec4f {
  let p = i.world;
  let n = normalize(i.normal);
  let eye = normalize(camera.position - p);
  let key = normalize(vec3f(-.55, .78, .5));
  let edge = normalize(vec3f(.8, .16, -.55));
  let diffuse = max(0.0,dot(n,key));
  let spec = pow(max(0.0,dot(n,normalize(key+eye))),20.0);
  let rim = pow(1.0-max(0.0,dot(n,eye)),2.8);
  let heat = uniforms.heat;
  let glow = pow(heat,.8);
  let texture = grain(p.xz*39.0+p.xy*14.0);
  var result = vec3f(.033,.029,.029) * (1.0+.70*diffuse) + spec*vec3f(.14,.092,.067);
  if (i.surface < 1.5) {
    let drip = step(.5,i.surface);
    let flow = grain(p.xy*7.0+vec2f(grain(p.xy*2.8)*2.0,-uniforms.time*.22));
    let seam = 1.0-smoothstep(.014,.055,abs(flow-.5));
    let shell = grain(p.xy*19.0+p.zx*4.0)*.53 + flow*.47;
    let burning = max(drip*.73,smoothstep(.38,.79,shell + (heat-.56)*.25));
    let hot = mix(vec3f(1.07,.070,.004),vec3f(2.82,1.04,.255),pow(heat,1.4));
    let iron = mix(vec3f(.026,.027,.033),vec3f(.14,.037,.015),shell);
    let bounce = vec3f(.53,.16,.041) * max(0.0,dot(n,edge));
    result = iron*(.8+.56*diffuse) + bounce*.20 + spec*vec3f(.27,.135,.059);
    result += hot * glow * (.018+.27*burning+.53*seam+.27*rim);
    result += vec3f(2.7,1.26,.41) * glow * (spec*.06+drip*.08);
  } else if (i.surface < 2.5) {
    let tile = min(abs(fract(p.x/1.03+.5)-.5),abs(fract(p.z/1.05+.5)-.5));
    let joints = smoothstep(.01,.019,tile);
    let stain = grain(p.xz*3.8) * .55 + texture*.45;
    let warm = exp(-p.z*p.z*1.04)*exp(-max(abs(p.x)-1.32,0.0)*1.65);
    result = vec3f(.039,.031,.029)*(.45+.7*stain)*(.44+.56*joints);
    result += vec3f(.70,.112,.018)*warm*glow*(.24+.52*spec)*(.7+.3*joints);
  } else if (i.surface > 3.5) {
    let weld = grain(vec2f(p.x*4.0,p.y*48.0));
    let band = exp(-8.0*abs(p.y-.18))*(.6+.4*grain(p.xy*2.5));
    result = vec3f(.028,.024,.026)*(.60+.30*texture)+vec3f(.19,.036,.012)*band*glow*(.46+.44*weld);
  } else {
    let finish = grain(vec2f(p.x*24.0,p.z*6.0+p.y*11.0));
    result = result*(.63+.37*finish) + vec3f(.35,.14,.060)*spec*glow;
  }
  let distance = length(p-camera.position);
  return margoDisplay(vec4f(mix(result,vec3f(.014,.011,.012),smoothstep(10.0,22.0,distance)),1.0));
}
`;
