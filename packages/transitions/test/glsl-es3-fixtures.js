// GLSL ES 3.00 compiler fixtures (original, written for this test; no copied shaders). Each one keeps clear of the
// behaviour GLSL ES 3.00 leaves undefined (negative integer division and remainder, shifts of 32 or more, overflowing
// float to integer conversions, rounding ties, NaN inputs), so the browser's own GLSL compiler is a black-box oracle
// for the translated WGSL (Lecoeur, Mohsin and Donaldson, Program reconditioning, PLDI 2023).
export const glslES3Fixtures = [
  {
    name: 'es3 uint and bit operators',
    source:
      '#version 300 es\nprecision highp float;precision highp int;\nvec4 transition(vec2 uv){uvec2 c=uvec2(uv*16.0);uint h=(c.x*73856093u)^(c.y*19349663u);h^=h>>13u;h*=0x5bd1e995u;h^=h>>15;uint m=h&255u;int s=int(c.x)<<2|int(c.y)>>1;int q=(int(c.x)*7+int(c.y)*3)%5;int x=s;x|=1;x&=~2;x<<=1;x>>=1;x^=5;ivec2 v=ivec2(c)<<1;v>>=ivec2(1,0);uvec2 w=c>>uvec2(1u);float r=float(m)/255.0;vec4 base=mix(getFromColor(uv),getToColor(uv),progress);return vec4(base.r*r,float(s&63)/63.0*0.5+float(q)*0.1,float(~h&7u)/7.0*0.5+float(abs(x-40)&15)/30.0,float(v.x+v.y+int(w.x+w.y))/120.0+float(clamp(min(q,3),1,2))*0.1);}',
  },
  {
    name: 'es3 switch with fallthrough, labels and continue',
    source:
      '#version 300 es\nconst int K=3;vec4 transition(vec2 uv){int k=int(uv.x*6.0);vec3 c=vec3(0.0);switch(k){case 0:c.r=1.0;break;case 1:c.g=0.5;case 2:c.b=0.75;break;case K:case K+1:{c=vec3(0.25);}break;default:c=getToColor(uv).rgb;}float acc=0.0;for(int i=0;i<5;i++){switch(i){case 1:continue;case 3:acc+=2.0;break;default:acc+=0.5;}acc+=0.25;}uint u=uint(uv.y*4.0);float t=0.0;switch(u){case 0u:t=0.1;break;case 2u:t=0.6;break;default:t=0.3;}int n=int(uv.y*3.0)-1;switch(n){case -1:t+=0.2;break;case 0:break;default:t-=0.1;}return vec4(mix(c,getFromColor(uv).rgb,progress),acc/8.0*0.5+t*0.5);}',
    // Native ANGLE on Direct3D 11 (Chrome 157, RTX A6000) fails to compile a continue inside a switch ("Error compiling
    // dynamic pixel executable", and the context is lost), so the reference takes that continue out of the switch; the
    // translated source keeps it.
    oracleSource:
      '#version 300 es\nconst int K=3;vec4 transition(vec2 uv){int k=int(uv.x*6.0);vec3 c=vec3(0.0);switch(k){case 0:c.r=1.0;break;case 1:c.g=0.5;case 2:c.b=0.75;break;case K:case K+1:{c=vec3(0.25);}break;default:c=getToColor(uv).rgb;}float acc=0.0;for(int i=0;i<5;i++){if(i==1)continue;switch(i){case 3:acc+=2.0;break;default:acc+=0.5;}acc+=0.25;}uint u=uint(uv.y*4.0);float t=0.0;switch(u){case 0u:t=0.1;break;case 2u:t=0.6;break;default:t=0.3;}int n=int(uv.y*3.0)-1;switch(n){case -1:t+=0.2;break;case 0:break;default:t-=0.1;}return vec4(mix(c,getFromColor(uv).rgb,progress),acc/8.0*0.5+t*0.5);}',
  },
  {
    name: 'es3 non-square matrices and mixed constructors',
    source:
      '#version 300 es\nvec4 transition(vec2 uv){mat2x3 m=mat2x3(1.0,0.5,0.25,0.0,1.0,0.5);vec3 a=m*uv;vec2 b=vec3(0.2,0.4,0.6)*m;mat3x2 t=transpose(m);mat2 p=t*m;mat3 o=outerProduct(vec3(uv,1.0),vec3(0.5,0.25,0.125));vec3 q=o*vec3(1.0);mat2x3 s=m*2.0-m+mat2x3(0.0);s[1]+=vec3(0.1);mat3 r=mat3(vec2(1.0,0.0),0.5,vec3(0.25),0.0,uv);vec4 f=vec4(mat2(uv,uv.yx));mat3x4 w=mat3x4(m);mat4x2 e=mat4x2(1.0);vec2 g=e*vec4(uv,0.5,0.25);vec3 h=matrixCompMult(m,s)*vec2(0.5);vec4 base=getFromColor(uv);return vec4(a*0.4+q*0.1,1.0)*0.5+vec4(b*0.3,p[1][1]*0.2+s[1][2]*0.3,0.0)*progress+vec4(r[2]*0.1,0.0)+f*0.05+vec4(w[1].xyz*0.05,w[2].w)+vec4(g*0.05,h.x*0.05,0.0)+base*0.01;}',
  },
  {
    name: 'es3 arrays, constructors, length and equality',
    source:
      '#version 300 es\nfloat sum(float[4] w){float s=0.0;for(int i=0;i<w.length();i++)s+=w[i];return s;}float[2] pair(float a){return float[2](a,a*0.5);}vec4 transition(vec2 uv){const float w[]=float[](0.1,0.2,0.3,0.4);float[4] v=float[4](uv.x,uv.y,progress,0.5);vec3 c[2]=vec3[2](getFromColor(uv).rgb,getToColor(uv).rgb);bool same=v==float[4](uv.x,uv.y,progress,0.5);bool differ=pair(uv.x)!=pair(uv.y);float d=0.0;for(int i=0;i<4;i++)d+=w[i]*v[i];float[2] z=pair(0.5);return vec4(mix(c[0],c[1],progress)*(same?1.0:0.0)*(differ?1.0:0.5),d/sum(w)*float(c.length())*0.5+z[1]*0.1);}',
  },
  {
    name: 'es3 built-in functions',
    source:
      '#version 300 es\nvec4 transition(vec2 uv){vec2 p=uv*7.3-3.1;vec2 w;vec2 f=modf(p,w);vec2 t=trunc(p);vec2 r=round(p+0.13);vec2 re=roundEven(p+0.13);ivec2 bi=floatBitsToInt(uv);uint bu=floatBitsToUint(progress);float back=intBitsToFloat(bi.x)+uintBitsToFloat(bu);bvec2 n=isnan(p);bvec2 inf=isinf(p*0.5);float h=tanh(p.x)*0.5+0.5;float g=sinh(0.3)+cosh(0.2)+asinh(0.5)+acosh(1.5)+atanh(0.25);uint pk=packUnorm2x16(uv);vec2 un=unpackUnorm2x16(pk);uint ph=packHalf2x16(vec2(progress,0.5));vec2 uh=unpackHalf2x16(ph);vec2 sn=unpackSnorm2x16(packSnorm2x16(uv-0.5));mat2 mi=inverse(mat2(2.0,1.0,1.0,3.0));mat3 m3=inverse(mat3(2.0,0.0,1.0,0.0,1.0,0.0,1.0,0.0,3.0));mat4 m4=inverse(mat4(2.0,0.0,0.0,0.0,0.0,4.0,0.0,0.0,0.0,0.0,1.0,0.0,1.0,0.0,0.0,1.0));vec3 bm=mix(vec3(0.1),vec3(0.9),bvec3(uv.x>0.5,false,true));return vec4(f.x*0.5+0.5,(w.y+t.x+r.y+re.x)/32.0+0.5,back*0.25+h*0.25+g*0.05+sn.x*0.1,un.x*0.2+uh.x*0.2+mi[0][0]*0.25+m3[2][2]*0.1+m4[3][0]*0.05+m4[1][1]*0.1+(any(n)||any(inf)?0.5:0.0)+bm.x*0.05);}',
  },
  {
    name: 'es3 texture functions',
    source:
      '#version 300 es\nvec4 transition(vec2 uv){ivec2 s=textureSize(from,0);ivec2 c=ivec2(uv*vec2(s));vec4 a=texelFetch(from,c,0);vec4 b=textureLod(to,uv,0.0);vec4 d=texture(to,uv);vec4 e=textureGrad(from,uv,dFdx(uv),dFdy(uv));vec4 f=textureProj(to,vec3(uv*2.0,2.0));vec4 g=textureOffset(from,clamp(uv,0.2,0.8),ivec2(1,-1));vec4 l=textureProjLod(from,vec4(uv,0.0,1.0),0.0);return mix(mix(a,b,progress),(d+e+f+g)*0.25,0.5)*0.9+l*0.1;}',
  },
  {
    name: 'es3 integer literal edges and conversions',
    source:
      '#version 300 es\nvec4 transition(vec2 uv){int a=0xFFFFFFFF;uint b=0xFFFFFFFFu;int c=-2147483648;int d=3000000000;uint e=uint(-2);int f=int(4294967294u);uvec3 g=uvec3(ivec3(1,2,3));ivec2 h=ivec2(uvec2(5u,6u));float k=float(uint(uv.x*10.0));return vec4(float(a+2)*0.5,float(b>>31)*0.25+float(c==-2147483648?1:0)*0.25,float(d<0?1:0)*0.2+float(e==4294967294u?1:0)*0.2+float(f==-2?1:0)*0.2,float(g.z+uint(h.y))/18.0+k*0.01);}',
  },
];
