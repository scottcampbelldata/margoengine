// Water's caustics draw with the shared beam shaders of @margoengine/post/caustics: this file only hands them the wave
// surface (a Water's coastal grid or an FFTOcean's tile) and the wet mask of the receivers.
import {
  causticBeams as beams,
  causticProject as project,
  causticRange as range,
  type CausticSurfaceShader,
} from '@margoengine/post/caustics';
import type { QueryState } from './query-state.js';

export { causticCopy, causticPartials } from '@margoengine/post/caustics';

/** The wave surface as the shared beams read it: two triangles per grid cell, six corner samples per cell. */
export function waterSurface(state: QueryState): CausticSurfaceShader {
  const water = state.kind === 'water';
  return {
    prelude: state.shader,
    bindings: water ? '@group(1) @binding(1) var<storage,read> coordinates:array<f32>;' : '',
    sample: `let cell=id/6u;let corner=array<vec2u,6>(vec2u(0,0),vec2u(0,1),vec2u(1,0),vec2u(1,0),vec2u(0,1),vec2u(1,1))[id%6u];
 let grid=vec2u(cell%${state.segments}u,cell/${state.segments}u)+corner;
 ${
   water
     ? `let index=grid.y*${state.segments + 1}u+grid.x;
 var base=vec2f(coordinates[index*3u],coordinates[index*3u+1u]);if(HORIZON){base+=frame.grid.xy;}
 let wave=surface(base,coordinates[index*3u+2u]);return Sample(wave.position,wave.normal,base);`
     : `let base=vec2f(grid)/f32(${state.segments})*frame.grid.xy-frame.grid.xy*0.5+frame.water.zw;
 let wave=oceanAt(base);return Sample(vec3f(base.x,frame.water.x,base.y)+wave.displacement,wave.normal,base);`
 }`,
    dry: water ? 'if(inCoast(base)){let s=coastal(base);return select(s.water.x<0.003,s.edge<=0.0,STILL);}' : '',
    triangles: state.segments * state.segments * 2,
  };
}

export const causticBeams = (state: QueryState, shadows: string): string => beams(waterSurface(state), shadows);
export const causticRange = (state: QueryState): string => range(waterSurface(state));
/** Receivers only under the drawn water: the wet field's coverage and surface height. */
export const causticProject = (shadows: string): string =>
  project(shadows, {
    mask: {
      bindings: '@group(0) @binding(6) var field:texture_2d<f32>;',
      test: 'let wet=textureLoad(field,vec2i(uv*vec2f(textureDimensions(field))),0);\n if(wet.y==0.0||p.y>=wet.w){return vec3f(0);}',
    },
  });
