// These shaders are original compiler fixtures, not copied transitions.
export const glslFixtures = [
  {
    name: 'aggregate equality vectors',
    source: 'int calls=0;vec2 readValue(vec2 v){calls++;return v;}vec4 transition(vec2 uv){vec2 a=floor(uv*4.0);vec2 b=vec2(1.0);if(readValue(a)==readValue(b)&&calls==2){return getFromColor(uv);}if(a!=b&&calls==2){return getToColor(uv);}return vec4(1.0,0.0,0.0,1.0);}',
  },
  {
    name: 'aggregate equality matrices',
    source: 'vec4 transition(vec2 uv){mat2 a=mat2(1.0);mat2 b=mat2(1.0);b[0][1]=floor(uv.x*2.0);if(a==b){return getFromColor(uv);}if(a!=b){return getToColor(uv);}return vec4(1.0,0.0,0.0,1.0);}',
  },
  {
    name: 'aggregate equality nested structs',
    source: 'struct Inner{vec2 point;bool enabled;};struct Outer{Inner inner;mat2 frame;};vec4 transition(vec2 uv){Outer a=Outer(Inner(vec2(1.0),true),mat2(1.0));Outer b=a;b.inner.point=floor(uv*2.0);b.frame[0][1]=floor(uv.x*2.0);if(a==b){return getFromColor(uv);}if(a!=b){return getToColor(uv);}return vec4(1.0,0.0,0.0,1.0);}',
  },
  { name: 'fade', source: 'vec4 transition(vec2 uv){return mix(getFromColor(uv),getToColor(uv),progress);}' },
  {
    name: 'macros',
    source:
      '#ifdef GL_ES\nprecision highp float;\n#endif\n#define SCALE(x) ((x)*(x))\n#define ENABLE 1\n#if defined(ENABLE) && ENABLE\nfloat curve(float x){return SCALE(x);}\n#else\nfloat curve(float x){return 0.0;}\n#endif\nvec4 transition(vec2 uv){return mix(getFromColor(uv),getToColor(uv),curve(progress));}',
  },
  {
    name: 'loops',
    source:
      'float curve(float x){float v=0.0;for(int i=0;i<4;i++){if(i==1)continue;v+=x/3.0;}return v;}vec4 transition(vec2 uv){return mix(getFromColor(uv),getToColor(uv),curve(progress));}',
  },
  {
    name: 'branches',
    source:
      'vec4 transition(vec2 uv){vec2 q=uv; if(progress<0.5){q.x=1.0-q.x;}else{q.y=1.0-q.y;}return progress<0.5?getFromColor(q):getToColor(q);}',
  },
  {
    name: 'uniform',
    uniforms: { amount: 0.3, tint: [0.2, 0.5, 0.8] },
    source:
      'uniform float amount; // = 0.3\nuniform vec3 tint; // = [0.2,0.5,0.8]\nvec4 transition(vec2 uv){return mix(mix(getFromColor(uv),getToColor(uv),progress),vec4(tint,1.0),amount);}',
  },
  {
    name: 'overloads',
    source:
      'float curve(float x){return x*x;}vec2 curve(vec2 x){return x*x;}vec4 transition(vec2 uv){return mix(getFromColor(curve(uv)),getToColor(curve(uv)),curve(progress));}',
  },
  {
    name: 'out',
    source:
      'void curve(float p,out float result){result=p*p;}void bias(inout vec2 q){q+=vec2(0.125,0.0);}vec4 transition(vec2 uv){float weight;curve(progress,weight);vec2 q=uv;bias(q);return mix(getFromColor(q),getToColor(q),weight);}',
  },
  {
    name: 'arrays',
    uniforms: { weights: [0.1, 0.2, 0.3, 0.4] },
    source:
      'uniform float weights[4];vec4 transition(vec2 uv){float x[4];x[0]=weights[0];x[1]=weights[1];x[2]=weights[2];x[3]=weights[3];float w=0.0;for(int i=0;i<4;i++){w+=x[i];}return mix(getFromColor(uv),getToColor(uv),progress*w);}',
  },
  {
    name: 'struct',
    source:
      'struct Pair{vec2 uv;float amount;};vec4 transition(vec2 uv){Pair s=Pair(uv,progress);s.uv.y=1.0-s.uv.y;return mix(getFromColor(s.uv),getToColor(s.uv),s.amount);}',
  },
  {
    name: 'swizzle',
    source:
      'vec4 transition(vec2 uv){vec4 c=getFromColor(uv);c.rg=c.gr;c.ba=vec2(0.2,1.0);return mix(c,getToColor(uv),progress);}',
  },
  {
    // KB0191: lookups 6e-4 of a texel below and above the edge between columns 10 and 11 (rows 2 and 3) of the 16 x 16
    // images; a sampler whose subtexel snap rounds may read the other texel. Oracle and product truncate alike.
    name: 'texel edge',
    source:
      'vec4 transition(vec2 uv){vec2 below=(vec2(11.0,3.0)-0.0006)/16.0;vec2 above=(vec2(11.0,3.0)+0.0006)/16.0;return uv.x<0.5?getFromColor(below):getToColor(above);}',
  },
  {
    name: 'matrix',
    source:
      'vec4 transition(vec2 uv){float a=progress;mat2 rotation=mat2(cos(a),sin(a),-sin(a),cos(a));vec2 q=rotation*(uv-0.5)+0.5;return mix(getFromColor(q),getToColor(q),progress);}',
  },
  {
    name: 'math',
    source:
      'vec4 transition(vec2 uv){float w=clamp(mod(uv.x+progress,1.0),0.0,1.0);vec2 q=fract(uv+vec2(0.125));vec4 c=mix(getFromColor(q),getToColor(q),smoothstep(0.1,0.9,w));return vec4(pow(c.rgb,vec3(1.2)),1.0);}',
  },
  {
    name: 'side-effects',
    source:
      'float count(inout float n){n+=0.1;return n;}vec4 transition(vec2 uv){float n=0.0;float w=progress<0.5?count(n):progress;bool yes=false;if(yes && count(n)>0.0){n+=0.5;}return mix(getFromColor(uv),getToColor(uv),w+n);}',
  },
  {
    name: 'while',
    source:
      'vec4 transition(vec2 uv){int i=0;float v=0.0;while(i<2){i++;v+=progress*0.25;}do{v+=progress*0.25;i--;}while(i>0);return mix(getFromColor(uv),getToColor(uv),v);}',
  },
  {
    name: 'texture',
    source:
      'uniform sampler2D from;uniform sampler2D to;vec4 transition(vec2 uv){return mix(texture2D(from,uv),texture2D(to,uv),progress);}',
  },
  {
    name: 'matrix-ops',
    source:
      'vec4 transition(vec2 uv){mat2 m=mat2(1.0);mat2 n=(2.0*m+0.23)/2.23;vec2 q=n*(uv-0.5)+0.5;return mix(getFromColor(q),getToColor(q),progress);}',
  },
  {
    name: 'sampler-helper',
    source:
      'vec4 color(sampler2D image,vec2 uv){return texture2D(image,uv);}vec4 transition(vec2 uv){return mix(color(from,uv),color(to,uv),progress);}',
  },
  {
    name: 'zero-macro',
    source: '#define ONE() 1.0\nvec4 transition(vec2 uv){return mix(getFromColor(uv),getToColor(uv),progress*ONE());}',
  },
  {
    name: 'matrix-cast',
    source:
      'vec4 transition(vec2 uv){mat3 m=mat3(mat2(1.0));vec2 q=(m*vec3(uv,1.0)).xy;return mix(getFromColor(q),getToColor(q),progress);}',
  },
  {
    name: 'projective',
    source:
      'vec4 transition(vec2 uv){return mix(texture2DProj(from,vec3(uv,1.0)),texture2DProj(to,vec3(uv,1.0)),progress);}',
  },
  {
    name: 'uniform-shapes',
    uniforms: { flags: [true, false], matrix: [1, 0, 0, 1], weights: [0.2, 0.8] },
    source:
      'const int N=2;uniform bvec2 flags;uniform mat2 matrix;uniform float weights[N];vec4 transition(vec2 uv){float w=flags.x?weights[0]:weights[1];return mix(getFromColor(matrix*uv),getToColor(uv),progress*w);}',
  },
  {
    name: 'struct-swizzle-name',
    source:
      'struct Item{vec2 rg;};vec4 transition(vec2 uv){Item item=Item(uv);item.rg=uv+vec2(0.125,0.0);return mix(getFromColor(item.rg),getToColor(item.rg),progress);}',
  },
  {
    name: 'indexed-output-once',
    // The native oracle uses an explicit address temporary: ANGLE's direct out target evaluates j++ twice.
    // GLSL ES 1.00 section 6.1.1 requires the l-value to be evaluated at call time and reused on return.
    oracleSource:
      'void weight(float p,out float w){w=p;}vec4 transition(vec2 uv){vec2 points[2];int i=0;points[i++].xy=uv;int j=0;int address=j++;weight(progress,points[address].x);return mix(getFromColor(points[0]),getToColor(points[0]),float(i+j)*0.25);}',
    source:
      'void weight(float p,out float w){w=p;}vec4 transition(vec2 uv){vec2 points[2];int i=0;points[i++].xy=uv;int j=0;weight(progress,points[j++].x);return mix(getFromColor(points[0]),getToColor(points[0]),float(i+j)*0.25);}',
  },
];
