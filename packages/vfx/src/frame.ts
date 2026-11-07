// The per-frame uniform and the insertion point that the simulation and its features share, apart from the shaders so
// the feature entries (wrap, obstacles, sort) bundle only these strings.
/**
 * right and up: the camera's axes; right.w: the view matrix's z translation (a particle's view depth, under a transparency
 * hook); up.w: pixels per world unit at clip w = 1 (for the billboard's minimum size).
 */
export const frame = /* wgsl */ `
struct Particle {positionLife:vec4f,velocitySize:vec4f,color:vec4f,rotation:vec4f}
struct Frame {camera:mat4x4f,right:vec4f,up:vec4f,gravityDelta:vec4f,emitterTime:vec4f,velocitySpread:vec4f,color:vec4f,shape:vec4f,physics:vec4f,emissionExtent:vec4f,control:vec4u}
@group(0) @binding(0) var<uniform> f:Frame;
`;
/** Statement the obstacle and wrap features insert their per-particle work before. */
export const settle = 'particles[at]=p.positionLife;';
