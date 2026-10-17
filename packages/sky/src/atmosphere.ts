// Earth, kilometer units. Coarse four-dimensional tables keep this optional pass lightweight.
// The header is split so a sky without Bruneton omits its phase functions and table lookups; with Bruneton the
// pieces join back into the exact original text (see bruneton.ts).
export const head = `
const R=6360.0;const TOP=6460.0;const BETA_R=vec3f(0.005802,0.013558,0.033100);
// sunlight: rgb is the sun's colour through the atmosphere relative to noon (CPU sunlight()); w is 1 with a stylized night.
struct Frame {inverse:mat4x4f,eye:vec4f,sun:vec4f,settings:vec4f,moon:vec4f,moonColor:vec4f,clouds:vec4f,nightZenith:vec4f,nightHorizon:vec4f,nightMoon:vec4f,nightMoonColor:vec4f,nightParams:vec4f,sunlight:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
fn mie()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5);}
fn densities(r:f32)->vec2f{return exp(-max(0.0,r-R)/vec2f(8.0,1.2));}
fn extinction(r:f32)->vec3f{let d=densities(r);return BETA_R*d.x+vec3f(mie()/0.9*d.y);}
`;
export const mid = `fn ground(r:f32,mu:f32)->bool{return mu<0.0&&r*r*(mu*mu-1.0)+R*R>=0.0;}
fn boundary(r:f32,mu:f32)->f32{if(ground(r,mu)){return max(0.0,-r*mu-sqrt(max(0.0,r*r*(mu*mu-1.0)+R*R)));}return max(0.0,-r*mu+sqrt(max(0.0,r*r*(mu*mu-1.0)+TOP*TOP)));}
fn trans(t:texture_2d<f32>,r:f32,mu:f32)->vec3f {
 if(ground(r,mu)){return vec3f(0);}let uv=vec2f((sign(mu)*sqrt(abs(mu))+1.0)*0.5,sqrt(clamp((r-R)/100.0,0.0,1.0)));
 let p=uv*vec2f(127,31);let a=vec2i(floor(p));let f=fract(p);let b=min(a+1,vec2i(127,31));
 return mix(mix(textureLoad(t,a,0).rgb,textureLoad(t,vec2i(b.x,a.y),0).rgb,f.x),mix(textureLoad(t,vec2i(a.x,b.y),0).rgb,textureLoad(t,b,0).rgb,f.x),f.y);
}
`;
export const transmittance = `
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,32))){return;}let u=f32(id.x)/127.0*2.0-1.0;let mu=u*abs(u);let r=R+100.0*pow(f32(id.y)/31.0,2.0)+0.001;
 var result=vec3f(0);if(!ground(r,mu)){let step=boundary(r,mu)/64.0;var optical=vec3f(0);for(var i=0u;i<64u;i++){let d=(f32(i)+0.5)*step;optical+=extinction(sqrt(r*r+d*d+2.0*r*mu*d))*step;}result=exp(-optical);}
 textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
// CPU twin of the transmittance table above: same radii, densities, coefficients and 64-step integration.
const RAYLEIGH = [0.005802, 0.013558, 0.0331];
const optical = new Float64Array(4);
/** Rayleigh and Mie optical lengths (km of sea-level air) from radius `r` along cosine `mu` to the top, at `at`. */
function opticalLengths(r: number, mu: number, at: number): void {
  const step = (-r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + 6460 * 6460))) / 64;
  let rayleigh = 0,
    mie = 0;
  for (let i = 0; i < 64; i++) {
    const d = (i + 0.5) * step,
      h = Math.max(0, Math.sqrt(r * r + d * d + 2 * r * mu * d) - 6360);
    rayleigh += Math.exp(-h / 8) * step;
    mie += Math.exp(-h / 1.2) * step;
  }
  optical[at] = rayleigh;
  optical[at + 1] = mie;
}
/**
 * The sun's linear RGB colour through the atmosphere, relative to the sun at the zenith: the transmittance
 * (Bruneton and Neyret 2008, the sky's own table) from an eye `altitude` km up toward a sun of elevation cosine `mu`,
 * divided by the zenith transmittance, so it is 1 at noon overhead. It fades over the sun's disc (0.014 rad) as the
 * disc crosses the horizon and is 0 once it has set. Writes the three channels into `out` and returns it.
 */
export function sunlight(mu: number, altitude: number, turbidity: number, out = new Float32Array(3)): Float32Array {
  if (!Number.isFinite(mu) || !Number.isFinite(altitude) || !Number.isFinite(turbidity) || out.length !== 3)
    throw new RangeError('Invalid sunlight: pass finite mu, altitude and turbidity and a 3-element output');
  const r = 6360 + Math.min(99.9, Math.max(0.001, altitude)),
    horizon = -Math.sqrt(Math.max(0, 1 - (6360 / r) ** 2)),
    x = Math.max(0, Math.min(1, (mu - horizon + 0.014) / 0.028)),
    disc = x * x * (3 - 2 * x),
    mie = (0.003996 * Math.max(0.25, (turbidity - 1) * 0.5)) / 0.9;
  opticalLengths(r, Math.min(1, Math.max(mu, horizon + 1e-4)), 0);
  opticalLengths(r, 1, 2);
  for (let i = 0; i < 3; i++)
    out[i] = disc ? disc * Math.exp(-(RAYLEIGH[i] * (optical[0] - optical[2]) + mie * (optical[1] - optical[3]))) : 0;
  return out;
}
