var e=`
struct Particle {positionLife:vec4f,velocitySize:vec4f,color:vec4f,rotation:vec4f}
struct Frame {camera:mat4x4f,right:vec4f,up:vec4f,gravityDelta:vec4f,emitterTime:vec4f,velocitySpread:vec4f,color:vec4f,shape:vec4f,physics:vec4f,emissionExtent:vec4f,control:vec4u}
@group(0) @binding(0) var<uniform> f:Frame;
`,t=`particles[at]=p.positionLife;`;export{t as n,e as t};