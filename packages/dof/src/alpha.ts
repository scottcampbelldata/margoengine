// DOF on a premultiplied (transparent) canvas. The capture holds linear colour times coverage with the coverage in alpha
// (T. Porter and T. Duff, "Compositing Digital Images", SIGGRAPH 1984,
// https://graphics.pixar.com/library/Compositing/paper.pdf), and a weighted mean of premultiplied pixels is the
// premultiplied pixel of the blurred coverage, while a mean of straight colours is not (A. R. Smith, "Image Compositing
// Fundamentals", Microsoft Technical Memo 4, 1995, http://alvyray.com/Memos/CG/Microsoft/4_comp.pdf; J. Blinn,
// "Compositing, Part 1: Theory", IEEE Computer Graphics and Applications 14(5), 1994, doi:10.1109/38.310740). So every
// gather gives alpha the same taps and weights as colour, as the premultiplied colour a post-filtered scatter-as-gather
// depth of field accumulates (J. Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH
// 2014). The gathers' weights come from depth and circle of confusion alone, so colour is unchanged. Alpha needs storage
// the opaque kernels have none of: the 2x2 block gathers' alpha (coarseAlpha), the near chain's in the spare channels of
// nearShapes (premultiplied by the same near weight) and nearScene, and at half resolution the blurred image's
// (blurredAlpha), whose alpha holds the near coverage.
import { MargoError } from '@margoengine/math/errors';

/** The shaders {@link alphaShaders} rewrites; `halfShaders`, when used, and a lens come first. */
export interface DOFAlphaShaders {
  readonly coarseShader: string;
  readonly bokehShader: string;
  readonly nearShader: string;
  readonly joinShader: string;
}

/** Each `[from, to, count]`: `from` must occur `count` times (at least once without one), and every one is replaced. */
function edit(source: string, edits: readonly (readonly [string, string, number?])[]): string {
  return edits.reduce((code, [from, to, count]) => {
    const parts = code.split(from);
    if (count === undefined ? parts.length < 2 : parts.length !== count + 1)
      throw new MargoError('unsupported', 'DOF on a transparent canvas needs the gather kernels of its own version');
    return parts.join(to);
  }, source);
}

// The far gather's front layer and its samples, in both kernels (a lens may scale a sample after the load).
const far = [
  ['var frontColor=vec3f(0)', 'var frontColor=vec4f(0)'],
  ['textureLoad(scene,farPixel,0).rgb', 'textureLoad(scene,farPixel,0)'],
] as const;

/**
 * The gather kernels carrying premultiplied alpha. `coarseShader` also writes binding 4 (r32float), `bokehShader` reads
 * it at binding 10; at half resolution `bokehShader` also writes binding 11 (r32float), which `joinShader` reads at its
 * binding 4.
 */
export function alphaShaders<T extends DOFAlphaShaders>(source: T, half: boolean): T {
  const nearShader = edit(source.nearShader, [
    ['vec4f(-s.x*g,s.y*g,0,0)', 'vec4f(-s.x*g,s.y*g,textureLoad(scene,at,0).a*g,0)', 1],
    ['textureStore(nearScene,at,vec4f(color,1));', 'textureStore(nearScene,at,textureLoad(scene,at,0));', 1],
  ]);
  const coarseShader = edit(source.coarseShader, [
    ...far,
    ['@compute', '@group(0) @binding(4) var coarseAlpha:texture_storage_2d<r32float,write>;\n@compute', 1],
    ['var farColor=textureLoad(scene,pixel,0).rgb;', 'var farColor=textureLoad(scene,pixel,0);', 1],
    [
      'textureStore(coarse,id.xy,vec4f(farColor/farWeight,select(0.0,center.y,wide)));',
      'let tone=farColor/farWeight;textureStore(coarse,id.xy,vec4f(tone.rgb,select(0.0,center.y,wide)));textureStore(coarseAlpha,id.xy,vec4f(tone.a));',
      1,
    ],
  ]);
  const declare =
    '@group(0) @binding(10) var coarseAlpha:texture_2d<f32>;\n' +
    (half ? '@group(0) @binding(11) var resultAlpha:texture_storage_2d<r32float,write>;\n' : '');
  const bokeh = edit(source.bokehShader, [
    ...far,
    ['fn disk(i:u32)', declare + 'fn disk(i:u32)', 1],
    ['var farColor=sharp.rgb;', 'var farColor=sharp;', 1],
    ['var nearColor=vec3f(0);', 'var nearColor=vec4f(0);', 1],
    ['var backColor=vec3f(0);', 'var backColor=vec4f(0);', 1],
    ['var up=vec4f(0);', 'var up=vec4f(0);var upAlpha=0.0;', 1],
    ['up+=vec4f(s.rgb,1.0)*w;', 'up+=vec4f(s.rgb,1.0)*w;upAlpha+=textureLoad(coarseAlpha,min(q+o,last),0).r*w;', 1],
    ['farColor=up.rgb;', 'farColor=vec4f(up.rgb,upAlpha);', 1],
    ['var tint=vec3f(0);', 'var tint=vec4f(0);', 1],
    ['tint=source.rgb/source.w;', 'tint=vec4f(source.rgb,nearForm.z)/source.w;', 1],
    ['backColor+=max(behind.rgb-tint*share,vec3f(0));', 'backColor+=max(behind-tint*share,vec4f(0));', 1],
    ['nearColor+=sharp.rgb*weight;', 'nearColor+=sharp*weight;', 1],
  ]);
  // Full resolution stores the gathered pixel; half resolution keeps the near coverage in the image's alpha.
  const bokehShader = half
    ? edit(bokeh, [
        [
          'textureStore(result,pixel,vec4f(color,coverage));',
          'textureStore(result,pixel,vec4f(color.rgb,coverage));textureStore(resultAlpha,pixel,vec4f(color.a));',
          1,
        ],
        [
          'textureStore(result,pixel,vec4f(sharp.rgb,0));',
          'textureStore(result,pixel,vec4f(sharp.rgb,0));textureStore(resultAlpha,pixel,vec4f(sharp.a));',
          1,
        ],
      ])
    : edit(bokeh, [['textureStore(result,pixel,vec4f(color,sharp.a));', 'textureStore(result,pixel,color);', 1]]);
  const joinShader = half
    ? edit(source.joinShader, [
        ['@compute', '@group(0) @binding(4) var blurredAlpha:texture_2d<f32>;\n@compute', 1],
        [
          'textureStore(result,pixel,vec4f(mix(sharp.rgb,b.rgb,w),sharp.a));',
          'let a=mix(mix(textureLoad(blurredAlpha,clamp(q,vec2i(0),last),0).r,textureLoad(blurredAlpha,clamp(q+vec2i(1,0),vec2i(0),last),0).r,f.x),\n' +
            '    mix(textureLoad(blurredAlpha,clamp(q+vec2i(0,1),vec2i(0),last),0).r,textureLoad(blurredAlpha,clamp(q+vec2i(1,1),vec2i(0),last),0).r,f.x),f.y);\n' +
            '  textureStore(result,pixel,mix(sharp,vec4f(b.rgb,a),w));',
          1,
        ],
      ])
    : source.joinShader;
  return { ...source, nearShader, coarseShader, bokehShader, joinShader };
}
