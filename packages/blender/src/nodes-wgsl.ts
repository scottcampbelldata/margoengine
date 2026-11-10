// Clean-room shader arithmetic from the Blender manual, Perlin (2002) and Lewis (1989).
export const mathExpressions: Record<string, string> = {
  ADD: 'a+b', SUBTRACT: 'a-b', MULTIPLY: 'a*b', DIVIDE: 'bnDiv(a,b)', MULTIPLY_ADD: 'a*b+c',
  POWER: 'bnPow(a,b)', LOGARITHM: 'bnLog(a,b)', SQRT: 'sqrt(max(a,0.0))', INVERSE_SQRT: 'select(0.0,inverseSqrt(max(a,1e-30)),a>0.0)',
  ABSOLUTE: 'abs(a)', EXPONENT: 'exp(a)', MINIMUM: 'min(a,b)', MAXIMUM: 'max(a,b)',
  LESS_THAN: 'select(0.0,1.0,a<b)', GREATER_THAN: 'select(0.0,1.0,a>b)', SIGN: 'sign(a)',
  COMPARE: 'select(0.0,1.0,abs(a-b)<=max(c,0.00001))',
  SMOOTH_MIN: 'bnSmoothMin(a,b,c)', SMOOTH_MAX: '-bnSmoothMin(-a,-b,c)',
  ROUND: 'floor(a+0.5)', FLOOR: 'floor(a)', CEIL: 'ceil(a)', TRUNC: 'trunc(a)', FRACT: 'fract(a)',
  MODULO: 'select(0.0,a-trunc(bnDiv(a,b))*b,b!=0.0)', FLOORED_MODULO: 'select(0.0,a-floor(bnDiv(a,b))*b,b!=0.0)',
  WRAP: 'bnWrap(a,b,c)', SNAP: 'floor(bnDiv(a,b))*b', PINGPONG: 'bnPingPong(a,b)',
  SINE: 'sin(a)', COSINE: 'cos(a)', TANGENT: 'tan(a)', ARCSINE: 'asin(clamp(a,-1.0,1.0))',
  ARCCOSINE: 'acos(clamp(a,-1.0,1.0))', ARCTANGENT: 'atan(a)', ARCTAN2: 'atan2(a,b)',
  SINH: 'sinh(a)', COSH: 'cosh(a)', TANH: 'tanh(a)', RADIANS: 'radians(a)', DEGREES: 'degrees(a)',
};
export const blendExpressions: Record<string, string> = {
  MIX: 'b', ADD: 'a+b', MULTIPLY: 'a*b', SUBTRACT: 'a-b', SCREEN: '1.0-(1.0-a)*(1.0-b)',
  DIVIDE: 'vec3f(bnDiv(a.x,b.x),bnDiv(a.y,b.y),bnDiv(a.z,b.z))', DIFFERENCE: 'abs(a-b)',
  EXCLUSION: 'a+b-2.0*a*b', DARKEN: 'min(a,b)', LIGHTEN: 'max(a,b)',
  OVERLAY: 'select(2.0*a*b,1.0-2.0*(1.0-a)*(1.0-b),a>=vec3f(0.5))',
  DODGE: 'min(vec3f(1),a/max(1.0-b,vec3f(1e-20)))', BURN: '1.0-min(vec3f(1),(1.0-a)/max(b,vec3f(1e-20)))',
  HUE: 'bnRGB(vec3f(bnHSV(b).x,bnHSV(a).yz))', SATURATION: 'bnRGB(vec3f(bnHSV(a).x,bnHSV(b).y,bnHSV(a).z))',
  VALUE: 'bnRGB(vec3f(bnHSV(a).xy,bnHSV(b).z))', COLOR: 'bnRGB(vec3f(bnHSV(b).xy,bnHSV(a).z))',
  SOFT_LIGHT: '(1.0-a)*a*b+a*(1.0-(1.0-a)*(1.0-b))', LINEAR_LIGHT: 'a+2.0*b-1.0',
};

export const nodeHelpers = /* wgsl */ `
fn bnDiv(a:f32,b:f32)->f32 {if(b==0.0){return 0.0;}return a/b;}
fn bnPow(a:f32,b:f32)->f32 {if(a<0.0){if(fract(b)!=0.0){return 0.0;}return pow(-a,b)*select(1.0,-1.0,abs(b-trunc(b*0.5)*2.0)==1.0);}if(a==0.0&&b<0.0){return 0.0;}return pow(a,b);}
fn bnLog(a:f32,b:f32)->f32 {if(a<=0.0||b<=0.0||b==1.0){return 0.0;}return log(a)/log(b);}
fn bnSmoothMin(a:f32,b:f32,k:f32)->f32 {if(k==0.0){return min(a,b);}let h=max(k-abs(a-b),0.0)/k;return min(a,b)-h*h*h*k/6.0;}
fn bnWrap(a:f32,hi:f32,lo:f32)->f32 {let d=hi-lo;if(d==0.0){return lo;}return a-d*floor((a-lo)/d);}
fn bnPingPong(a:f32,b:f32)->f32 {let scale=abs(b);return scale-abs(bnWrap(a,2.0*scale,0.0)-scale);}
fn bnHSV(c:vec3f)->vec3f {
 let hi=max(c.x,max(c.y,c.z));let lo=min(c.x,min(c.y,c.z));let d=hi-lo;var h=0.0;
 if(d>0.0){if(hi==c.x){h=(c.y-c.z)/d;}else if(hi==c.y){h=2.0+(c.z-c.x)/d;}else{h=4.0+(c.x-c.y)/d;}}
 return vec3f(fract(h/6.0),bnDiv(d,hi),hi);
}
fn bnRGB(c:vec3f)->vec3f {let p=abs(fract(c.xxx+vec3f(0,0.6666666667,0.3333333333))*6.0-3.0);return c.z*mix(vec3f(1),clamp(p-1.0,vec3f(0),vec3f(1)),c.y);}
fn bnHSL(c:vec3f)->vec3f {let hsv=bnHSV(c);let l=hsv.z*(1.0-hsv.y*0.5);return vec3f(hsv.x,bnDiv(hsv.z-l,min(l,1.0-l)),l);}
fn bnFromHSL(c:vec3f)->vec3f {let v=c.z+c.y*min(c.z,1.0-c.z);return bnRGB(vec3f(c.x,select(0.0,2.0*(1.0-c.z/max(v,1e-30)),v!=0.0),v));}
fn bnHue(a:f32,b:f32,t:f32,mode:u32)->f32 {
 var d=b-a;if(mode==0u){d=d-floor(d+0.5);}else if(mode==1u){d=d-floor(d+0.5);d=d-select(-1.0,1.0,d>=0.0);}else if(mode==2u){d=fract(d);}else{d=-fract(-d);}
 return fract(a+d*t);
}
fn bnCubic(a:vec4f,b:vec4f,c:vec4f,d:vec4f,t:f32,spline:bool)->vec4f {
 let t2=t*t;let t3=t2*t;
 if(spline){return (a*(-t3+3.0*t2-3.0*t+1.0)+b*(3.0*t3-6.0*t2+4.0)+c*(-3.0*t3+3.0*t2+3.0*t+1.0)+d*t3)/6.0;}
 return 0.5*((2.0*b)+(-a+c)*t+(2.0*a-5.0*b+4.0*c-d)*t2+(-a+3.0*b-3.0*c+d)*t3);
}
// Inverse affine model via cofactors, then Margo Y-up back to Blender Z-up.
fn bnLocal(p:vec3f)->vec3f {let a=f.model[0].xyz;let b=f.model[1].xyz;let c=f.model[2].xyz;let q=p-f.model[3].xyz;let det=dot(a,cross(b,c));let v=vec3f(dot(q,cross(b,c)),dot(q,cross(c,a)),dot(q,cross(a,b)))/select(1.0,det,abs(det)>1e-30);return vec3f(v.x,-v.z,v.y);}
`;

// Arbitrary-dimension gradient noise. Quintic interpolation is Perlin's C2 kernel; independent hash/gradient ordering.
export function noiseHelpers(dim: number): string {
  const offsets = Array.from({ length: 1 << dim }, (_, n) => {
    const o = Array.from({ length: 4 }, (_, i) => i < dim ? (n >> i) & 1 : 0);
    const weight = o.slice(0, dim).map((v, i) => `${v ? 'w' : '(1.0-w)'}[${i}]`).join('*');
    return `{let o=vec4i(${o.join(',')});let h=bnHash(c+o);var g=vec4f(0);for(var k=0u;k<${dim}u;k++){g[k]=select(-1.0,1.0,((h>>k)&1u)!=0u);}value+=dot(g,r-vec4f(o))*${weight};}`;
  }).join('\n');
  return /* wgsl */ `
fn bnHash(p:vec4i)->u32 {var h=(bitcast<u32>(p.x)*374761393u)^(bitcast<u32>(p.y)*668265263u)^(bitcast<u32>(p.z)*1442695041u)^(bitcast<u32>(p.w)*2246822519u);h=(h^(h>>13u))*1274126177u;return h^(h>>16u);}
fn bnNoise${dim}(p:vec4f)->f32 {let c=vec4i(floor(p));let r=fract(p);let w=r*r*r*(r*(r*6.0-15.0)+10.0);var value=0.0;${offsets}return value;}
fn bnFractal${dim}(p:vec4f,detail:f32,rough:f32,lacunarity:f32,offset:f32,gain:f32,kind:u32,normalized:bool)->f32 {
 let depth=clamp(detail,0.0,15.0);var q=p;var amplitude=1.0;var total=0.0;var sum=0.0;var product=1.0;var weight=1.0;
 for(var k=0;k<16;k++) {let part=clamp(depth-f32(k)+1.0,0.0,1.0);if(part==0.0){break;}let n=bnNoise${dim}(q);let a=amplitude*part;
 if(kind==0u){sum+=n*a;}else if(kind==1u){product*=1.0+n*a;}else if(kind==2u){let signal=(offset-abs(n))*(offset-abs(n));sum+=signal*weight*a;weight=clamp(signal*gain,0.0,1.0);}else if(kind==3u){let signal=(n+offset)*a;sum+=weight*signal;weight=clamp(weight*gain*signal,0.0,1.0);}else{let signal=n+offset;if(k==0){sum=signal;}else{sum+=signal*a*sum;}}
 total+=a;amplitude*=clamp(rough,0.0,1.0);q*=lacunarity;
 }
 if(kind==1u){return product;}if(kind!=0u){return sum;}if(normalized){return 0.5+0.5*sum/max(total,1e-30);}return sum;
}
fn bnTexture${dim}(p:vec4f,detail:f32,rough:f32,lacunarity:f32,distortion:f32,offset:f32,gain:f32,kind:u32,normalized:bool,channel:f32)->f32 {
 var q=p+vec4f(channel*17.17,channel*31.31,channel*47.47,channel*63.63);
 if(distortion!=0.0){q+=distortion*vec4f(bnNoise${dim}(q+vec4f(13.1)),bnNoise${dim}(q+vec4f(29.2)),bnNoise${dim}(q+vec4f(43.3)),bnNoise${dim}(q+vec4f(61.4)));}
 return bnFractal${dim}(q,detail,rough,lacunarity,offset,gain,kind,normalized);
}`;
}
