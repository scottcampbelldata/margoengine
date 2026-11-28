// The puddle and snow statements on gltf/pbr's surface `s` (base, roughness, metal, n) and its vertex projection, shared
// by GLTFWeather (imported models) and the Material-mesh side of Puddles and Snow, so both shade the same weather.

/** Wetness and standing water on `s`: `wet` darkens and smooths it as well (`wetSurfaces`). */
export const puddleSurfaceCode = (wet: boolean): string =>
  `{let weatherWater=weather_puddle_surface(i.position,s.n,s.base.rgb,s.roughness,s.metal,${wet},weatherPuddles);
      s.base=vec4f(weatherWater[0].xyz,s.base.a);s.roughness=weatherWater[0].w;s.metal=weatherWater[1].x;s.n=weatherWater[2].xyz;}`;

/** Snow on `s`, its cover read from the WGSL expression `cover`. */
export const snowSurfaceCode = (cover: string): string =>
  `{let weatherCover=weather_snow_at(i.position.xz,normalize(i.normal).y,${cover});
      if(weatherCover>0.0){s.base=vec4f(mix(s.base.rgb,weatherSnow.b.xyz,weatherCover),s.base.a);
      s.roughness=mix(s.roughness,weatherSnow.b.w,weatherCover);s.metal*=1.0-weatherCover;
      s.n=weather_snow_normal(i.position.xz,s.n,weatherCover,weatherSnow);}}`;

/** gltf/pbr's vertex projection of the world position `p`. */
export const PBR_PROJECTION = 'o.clip=f.camera*p; o.position=p.xyz;';

/**
 * The projection with the world position lifted by the WGSL expression `depth` (the snow's depth). The lift runs after
 * skinning and morphing and before the camera projection. It is the depth on flat ground at the vertex's place, not
 * by its normal, so a hard edge's vertices rise together and its faces stay joined.
 */
export const pbrLift = (depth: string): string =>
  `var weatherPosition=p;weatherPosition.y+=${depth};o.clip=f.camera*weatherPosition;o.position=weatherPosition.xyz;`;
