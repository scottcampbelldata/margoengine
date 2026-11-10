import { test } from 'node:test';
import { extendedPBRShader } from '../../gltf-pro/src/shader.ts';
import { checkWGSL } from '@margoengine/webgl2-compat/wgsl';
import { mtoonShader, mtoonLit } from '../src/mtoon-shader.ts';
import { laterUVShader, vertexInputs } from '../../gltf-pro/src/vertex-inputs.ts';
import { lightPBR } from '../../shared/pbr-hooks.js';
import { clusteredSampling } from '../../clustered/src/shader.ts';

for (const outline of [false, true]) {
  test(`MToon ${outline ? 'outline' : 'body'} composes GI, sky, shadows, clustered lighting and four UV sets`, () => {
    let code = mtoonShader(extendedPBRShader, 2, outline);
    for (const hook of [
      { declarations: '', ambient: 's.base.rgb*vec3f(0.2,0.3,0.4)' },
      { declarations: '', sky: 'vec3f(n.y*0.5+0.5)' },
      { declarations: '', direct: (direct) => direct + '*0.5' },
      {
        declarations: clusteredSampling(2),
        light: 'clusterLighting(i.clip.xy,i.position,s.n,f.eye.xyz,s.base.rgb,s.roughness,s.metal,vec3f(0.04),1.0)',
      },
    ])
      code = lightPBR(code, hook);
    code = mtoonLit(code, outline);
    checkWGSL(code);
    checkWGSL(laterUVShader(vertexInputs(code).code));
  });
}
