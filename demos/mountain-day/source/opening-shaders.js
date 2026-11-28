// One colour model for the small WebGL2 opener and native WebGPU. The full renderer uses the Margo sky packages.
const skyBody = dialect => {
  const v = dialect === 'wgsl' ? 'vec3f' : 'vec3';
  const f = dialect === 'wgsl' ? 'let' : 'float';
  const c = dialect === 'wgsl' ? 'let' : 'vec3';
  return [
    c + ' ray = normalize(forward.xyz + point.x * forward.w * right.xyz + point.y * right.w * up.xyz);',
    f + ' high = smoothstep(-.06,.49,ray.y);',
    f + ' daylight = smoothstep(-.15,.32,sun.y);',
    f + ' night = 1.0 - smoothstep(-.27,-.08,sun.y);',
    f + ' dusk = smoothstep(-.21,.01,sun.y) * (1.0-smoothstep(.04,.37,sun.y));',
    c + ' horizon = mix(mix('+v+'(.68,.45,.38),'+v+'(.76,.81,.79),daylight),'+v+'(.083,.109,.166),night);',
    c + ' zenith = mix(mix('+v+'(.254,.372,.501),'+v+'(.25,.478,.666),daylight),'+v+'(.025,.05,.095),night);',
    f + ' sunAmount = max(0.0,dot(ray,sun.xyz));',
    f + ' glow = pow(sunAmount,12.0) * dusk;',
    f + ' disc = smoothstep(.999982,.999991,sunAmount) * smoothstep(-.04,.06,sun.y);',
    c + ' color = mix(horizon,zenith,high) + '+v+'(.32,.13,.041)*glow + '+v+'(.86,.72,.48)*disc;',
    f + ' distance = max(0.0,3400.0-eye.y) / max(.055,ray.y);',
    f + ' east = (eye.x + ray.x*distance)*.00054 + time*.007;',
    f + ' north = (eye.z + ray.z*distance)*.00044;',
    f + ' wisps = .48*sin(east*.77+.62*sin(north)) + .25*cos(north*1.82+east*.59) + .16*sin(east*3.18-north*2.30) + .09*cos(north*6.7+east*4.3);',
    f + ' cloud = smoothstep(.87-sun.w,.99-sun.w,wisps) * smoothstep(.045,.16,ray.y) * min(1.0,sun.w*3.8);',
    c + ' cloudLight = mix('+v+'(.24,.267,.32),mix('+v+'(.86,.62,.51),'+v+'(.92,.93,.90),daylight),1.0-night);',
    c + ' lit = mix(color,cloudLight,cloud*.90);',
    f + ' x = ray.x*601.0;',
    f + ' y = ray.y*488.0+ray.z*61.0;',
    f + ' pointSeed = fract(sin(dot(floor('+v+'(x,y,ray.z*73.0)),'+v+'(17.7,39.9,65.3)))*46121.44);',
    f + ' star = smoothstep(.986,.999,pointSeed) * (1.0-smoothstep(.06,.23,length(fract('+v+'(x,y,.5))-'+v+'(.5))));',
    c + ' result = lit + '+v+'(.82,.91,1.0)*star*night*smoothstep(0.0,.16,ray.y)*(1.0-cloud)*.83;',
    'return min(result,'+v+'(1.0));',
  ].join('\n');
};

const terrainBody = dialect => {
  const v = dialect === 'wgsl' ? 'vec3f' : 'vec3';
  const f = dialect === 'wgsl' ? 'let' : 'float';
  const c = dialect === 'wgsl' ? 'let' : 'vec3';
  return [
    c + ' normal = normalize(n);',
    f + ' ridge = 1.0 - normal.y;',
    f + ' granite = smoothstep(1480.0,2220.0,p.y) * .9 + .1 * smoothstep(.14,.45,ridge);',
    f + ' line = p.y + 105.0*sin(p.x*.00082 + p.z*.00019) + 80.0*cos(p.z*.0012);',
    f + ' snow = smoothstep(2490.0,3150.0,line) * (1.0-smoothstep(.17,.52,ridge));',
    f + ' small = .5 + .5 * sin(p.x*.006 + 1.3*sin(p.z*.007))*sin(p.z*.0057);',
    c + ' grass = mix('+v+'(.205,.293,.239),'+v+'(.344,.39,.291),small);',
    c + ' stone = mix('+v+'(.34,.377,.412),'+v+'(.434,.411,.383),small);',
    c + ' albedo = mix(mix(grass,stone,granite),'+v+'(.85,.871,.885),snow);',
    f + ' day = smoothstep(-.23,.17,sun.y);',
    f + ' side = max(0.0,dot(normal,sun.xyz)) * smoothstep(-.032,.10,sun.y);',
    f + ' warm = 1.0-smoothstep(.08,.53,sun.y);',
    c + ' tint = mix('+v+'(.96,.99,1.0),'+v+'(1.23,.97,.76),warm);',
    c + ' shaded = albedo * (mix('+v+'(.14,.22,.39),'+v+'(.55,.65,.73),day) + tint * side * .67);',
    f + ' mist = 1.0-exp(-max(0.0,length(p-eye)-750.0)*.000036);',
    c + ' airborne = mix('+v+'(.079,.117,.198),mix('+v+'(.47,.44,.487),'+v+'(.53,.65,.724),smoothstep(.02,.53,sun.y)),day);',
    'return mix(shaded,airborne,mist*.64);',
  ].join('\n');
};

const gpuUniforms = [
  'struct Frame { transform:mat4x4f, eye:vec4f, sun:vec4f, forward:vec4f, right:vec4f, up:vec4f }',
  '@group(0) @binding(0) var<uniform> frame:Frame;',
].join('\n');

export const skyWGSL = gpuUniforms + '\n' +
  'struct Vertex { @builtin(position) position:vec4f, @location(0) point:vec2f }\n' +
  '@vertex fn vertex(@builtin(vertex_index) i:u32)->Vertex {\n' +
  '  let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0; return Vertex(vec4f(p,0,1),p); }\n' +
  'fn colorAt(point:vec2f,forward:vec4f,right:vec4f,up:vec4f,sun:vec4f,eye:vec3f,time:f32)->vec3f {\n' + skyBody('wgsl') +
  '\n}\n@fragment fn fragment(input:Vertex)->@location(0) vec4f {' +
  'return vec4f(colorAt(input.point,frame.forward,frame.right,frame.up,frame.sun,frame.eye.xyz,frame.up.w),1); }';

export const terrainWGSL = gpuUniforms + '\n' +
  'struct Vertex { @builtin(position) position:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f }\n' +
  '@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f)->Vertex {' +
  '  return Vertex(frame.transform*vec4f(p,1),p,n); }\n' +
  'fn colorAt(p:vec3f,n:vec3f,eye:vec3f,sun:vec4f)->vec3f {\n' + terrainBody('wgsl') +
  '\n}\n@fragment fn fragment(input:Vertex)->@location(0) vec4f {' +
  'return vec4f(colorAt(input.world,input.normal,frame.eye.xyz,frame.sun),1); }';

const head = '#version 300 es\nprecision highp float;\n';
export const skyGLSL = [
  head + 'out vec2 point;\nvoid main(){int i=gl_VertexID;point=vec2(float((i<<1)&2),float(i&2))*2.0-1.0;gl_Position=vec4(point,0,1);}',
  head + 'uniform vec4 forward,right,up,sun;uniform vec3 eye;uniform float time;\nin vec2 point;out vec4 pixel;\nvec3 colorAt(){\n' +
    skyBody('glsl') + '\n}\nvoid main(){pixel=vec4(colorAt(),1);}',
];
export const terrainGLSL = [
  head + 'layout(location=0) in vec3 position;layout(location=1) in vec3 normal;uniform mat4 transform;\n' +
    'out vec3 p,n;\nvoid main(){p=position;n=normal;gl_Position=transform*vec4(p,1);}',
  head + 'uniform vec3 eye;uniform vec4 sun;\nin vec3 p,n;out vec4 pixel;\nvec3 colorAt(){\n' +
    terrainBody('glsl') + '\n}\nvoid main(){pixel=vec4(colorAt(),1);}',
];