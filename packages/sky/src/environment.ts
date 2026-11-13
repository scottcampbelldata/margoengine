// The sky as surroundings: what water reflects and what lights the scene. Shared by the reflection and lighting
// features; both compile it after the sky's own WGSL (`code`), which supplies daySky, nightSky, moonRadiance and cloudSky.
// The below-horizon ground colour (0.015, 0.018, 0.012) is a Margo choice.
export const environment = /* wgsl */ `
// Radiance arriving from direction w, without the sun's disc (the engine light carries the sun). footprint is the
// sample's angular size in radians.
fn skyEnvironment(w:vec3f,footprint:f32)->vec3f {
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=daySky(ray);
 color=mix(vec3f(0.015,0.018,0.012),color,smoothstep(-0.2,0.02,w.y));
 color=mix(color,nightSky(w,footprint),frame.sun.w);
 let sky=color;color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,footprint);
 return cloudSky(color,sky,w,footprint)*exp2(frame.settings.y);
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
