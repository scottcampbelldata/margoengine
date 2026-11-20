import { test } from 'node:test';
import { extendedPBRShader } from '../../gltf/src/shader.ts';
import { checkWGSL } from '@margoengine/webgl2-compat/wgsl';
import { mtoonShader, mtoonLit } from '../src/mtoon-shader.ts';
import { laterUVShader, vertexInputs } from '../../gltf/src/vertex-inputs.ts';
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

test('MToon maps on TEXCOORD_2 and 3 read the later UV stream (audit p4 R21)', () => {
  // gltf/pbr enables the stream when any texCoord above 1 sits in the material, extensions included, and rewrites each
  // two-way UV choice into a four-way one; MToon's own map lookup must be among them.
  for (const outline of [false, true]) {
    const code = laterUVShader(vertexInputs(mtoonLit(mtoonShader(extendedPBRShader, 2, outline), outline)).code);
    if (!/fn mtRaw\(i:Out,k:u32\)->vec2f \{return margoUVSet\(i,mt\.rows\[8u\+k\*3u\]\.w\);\}/.test(code))
      throw new Error('MToon map UVs do not choose among the four sets');
  }
});

test('the MToon outline pass lights with the outward normal, not the back face flip (audit p4 R19)', () => {
  // CPU check of the WGSL only; test:mtoon:browser (mtoon-outline) must confirm the lit side on a GPU.
  const body = mtoonShader(extendedPBRShader, 2, false),
    outline = mtoonShader(extendedPBRShader, 2, true);
  if (!body.includes('let n=normalize(i.normal)*select(-1.0,1.0,facing);') || body.includes('let n=-normalize(i.normal)'))
    throw new Error('the body pass keeps the two-sided normal');
  if (!outline.includes('let n=-normalize(i.normal)*select(-1.0,1.0,facing);'))
    throw new Error('the outline pass must undo the back-face flip');
  checkWGSL(mtoonLit(outline, true));
});

test('the MToon outline hull builds on the projected o.clip and o.position, so a later world edit moves it too', () => {
  const projection = 'o.clip=f.camera*p; o.position=p.xyz;',
    outline = mtoonShader(extendedPBRShader, 2, true);
  // The standard projection stays, once, ahead of the hull; a lighting effect (weather's snow lift) may edit it later.
  if (outline.split(projection).length !== 2) throw new Error('the outline keeps the standard projection once');
  const at = outline.indexOf(projection),
    hull = outline.indexOf('var world=vec4f(o.position,1.0);var clip=o.clip;');
  if (hull < at) throw new Error('the hull starts from the projected position, after the projection');
  if (/var world=p;|var clip=f\.camera\*p;/.test(outline)) throw new Error('the hull must not re-project the raw vertex');
  const lifted = outline.replace(
    projection,
    'var lifted=p;lifted.y+=0.25;o.clip=f.camera*lifted;o.position=lifted.xyz;',
  );
  checkWGSL(mtoonLit(lifted, true));
});
