/**
 * WGSL of the rain cover map that `WeatherFX` (`@margoengine/sky/weather-fx`) draws and `Weather` reads: its frame at
 * `binding` of group 0 (area: the map's world x and z origin, 1 / its width, the world height of depth 0; depth: the
 * height range of depth 0 to 1 and the map's texels per side) and its top-down depth at `binding + 1`.
 * `rainCoverDepth(xz)` is that depth at a world point, 1 where nothing covers it; `rainCovered(p)` is true under cover.
 */
export const rainCover = (binding: number): string => /* wgsl */ `
struct RainCover {area:vec4f,depth:vec4f}
@group(0) @binding(${binding}) var<uniform> rainCoverFrame:RainCover;
@group(0) @binding(${binding + 1}) var rainCoverMap:texture_depth_2d;
fn rainCoverDepth(xz:vec2f)->f32 {
 let f=rainCoverFrame;let m=(xz-f.area.xy)*f.area.z;if(any(m<vec2f(0))||any(m>=vec2f(1))){return 1.0;}
 return textureLoad(rainCoverMap,vec2i(m*f.depth.y),0);
}
fn rainCovered(p:vec3f)->bool {let d=rainCoverDepth(p.xz);return d<1.0&&p.y<rainCoverFrame.area.w-d*rainCoverFrame.depth.x;}
`;
