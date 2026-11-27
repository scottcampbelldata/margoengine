// One split drag exchange after the normal shallow-water step. The state is copied to Water's
// next ping-pong side and only one wet cell's signed momentum is changed.
export const floodRigidDrag = /* wgsl */ `
struct Drag {
  cell:vec2f, velocity:vec2f,
  y:f32, halfHeight:f32, mass:f32, coefficient:f32,
  densityArea:f32, dt:f32, dry:f32, speedLimit:f32,
}
@group(0) @binding(0) var<uniform> body:Drag;
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var momentum:texture_2d<f32>;
@group(0) @binding(3) var outState:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var outMomentum:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let p = vec2i(id.xy);
  if(any(p >= vec2i(textureDimensions(state)))) { return; }
  let water = textureLoad(state,p,0);
  var q = textureLoad(momentum,p,0);
  if(all(p == vec2i(body.cell)) && water.x > body.dry) {
    let overlap = min(body.y+body.halfHeight,water.y+water.x) - max(body.y-body.halfHeight,water.y);
    let wet = clamp(overlap/(2.0*body.halfHeight),0.0,1.0);
    let relative = body.velocity-q.yw/water.x;
    let speed = length(relative);
    let inverseWaterMass = 1.0/(body.densityArea*water.x);
    let inverseReducedMass = 1.0/body.mass+inverseWaterMass;
    let strength = body.dt*wet*body.coefficient*inverseReducedMass*speed;
    // Backward Euler for quadratic relative drag, solved in the slip direction for both masses.
    let fraction = (2.0*strength)/(1.0+2.0*strength+sqrt(1.0+4.0*strength));
    let deltaQ = fraction*relative/(inverseReducedMass*body.densityArea);
    let next = q.yw+deltaQ;
    if(wet > 0.0 && length(next) <= body.speedLimit*water.x) {
      q = vec4f(0.0,next.x,0.0,next.y);
    }
  }
  textureStore(outState,p,water);
  textureStore(outMomentum,p,q);
}
`;
