// The sky as surroundings: what water reflects and what lights the scene. Shared by the reflection and lighting
// features; both compile it after the sky's own WGSL (`code`), which supplies daySky, nightSky, moonRadiance and cloudSky.
// The below-horizon ground colour (0.015, 0.018, 0.012) is a Margo choice.
export const environment = /* wgsl */ `
// Radiance arriving from direction w, without the sun's disc (the engine light carries the sun). footprint is the
// sample's angular size in radians.
// Below the horizon the clouds see the ray held at the horizon, as the day sky does, and the ground is mixed in after
// them: handed the ray itself, the clouds met the ground and gave back the clear horizon, so under an overcast deck the
// map's first rows below the horizon were the cloudless sky, warm and bright (KB-SKY-ENVBELOW1).
fn skyEnvironment(w:vec3f,footprint:f32)->vec3f {
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=daySky(ray);
 color=mix(color,nightSky(w,footprint),frame.sun.w);
 let sky=color;color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint)*f32(frame.sunlight.w<0.5);
 color=mix(vec3f(0.015,0.018,0.012),cloudSky(color,sky,ray,footprint),smoothstep(-0.2,0.02,w.y));
 return color*exp2(frame.settings.y);
}
// Equirectangular layout shared with Water: u turns around +Y from -X, v runs from the zenith down.
fn environmentDirection(uv:vec2f)->vec3f {
 let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;return vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
}
`;
// Sky.environmentLayer at binding 4, a 64 x 32 map in the same layout with premultiplied light and opacity (the
// VolumetricClouds deck): over the sky, its light plus the sky through what it lets pass.
export const environmentLayer = /* wgsl */ `
@group(0) @binding(4) var environmentLayer:texture_2d<f32>;
fn layered(sky:vec3f,texel:vec2u)->vec3f {
 let layer=textureLoad(environmentLayer,vec2i(texel),0);return sky*(1.0-layer.a)+layer.rgb;
}
`;
