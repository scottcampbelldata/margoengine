// TAA on a premultiplied (transparent) canvas. The captured display pixel holds the encoded colour times coverage with
// the coverage in alpha, and temporal accumulation is a filter over frames: it keeps valid coverage and straight edge
// colour only on linear colour premultiplied by alpha, with alpha given the same weights (T. Porter and T. Duff,
// "Compositing Digital Images", SIGGRAPH 1984, https://graphics.pixar.com/library/Compositing/paper.pdf; A. R. Smith,
// "Image Compositing Fundamentals", Microsoft Technical Memo 4, 1995,
// http://alvyray.com/Memos/CG/Microsoft/4_comp.pdf; J. Blinn, "Compositing, Part 1: Theory", IEEE Computer Graphics and
// Applications 14(5), 1994, doi:10.1109/38.310740). So a partly covered sample is decoded as linear(c / a) a, history
// holds that with the coverage in its alpha, and the display pass encodes (c / a) and multiplies by a again. Alpha is a
// fourth channel of the history: it is reprojected with the colour's taps, held to the 3x3 neighbourhood's range (and to
// its variance range under variance clipping), left free where a lock holds the colour free, blended with the colour's
// weight and settled with it (B. Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014; M. Salvi, "An Excursion in
// Temporal Supersampling", GDC 2016; L. Yang, S. Liu and M. Salvi, "A Survey of Temporal Antialiasing Techniques",
// Computer Graphics Forum 39(2), 2020). The reactive mask's history, which an opaque canvas keeps in history alpha, goes
// to the second channel of the history depth.
import { MargoError } from '@margoengine/math/errors';

/** Each `[from, to]`: `from` must occur exactly once. */
function edit(code: string, edits: readonly (readonly [string, string])[]): string {
  return edits.reduce((out, [from, to]) => {
    if (out.split(from).length !== 2)
      throw new MargoError('state', 'TAA alpha patch target missing; use matching @margoengine/taa sources');
    return out.replace(from, () => to);
  }, code);
}

/** The finished resolve shader (every option's patch applied) for a premultiplied canvas. */
export function premultipliedResolve(code: string): string {
  const locked = code.includes('var lockHistory'),
    reactive = code.includes('reactiveMask'),
    settles = code.includes('fn settled(');
  const clamped = 'clamp(oldAlpha/total,loA,hiA)',
    history = locked ? `select(${clamped},oldAlpha/total,lock>0.0)` : clamped,
    weight = reactive ? 'temporal.settings.x*(1.0-max(react,oldReact/total))' : 'temporal.settings.x';
  const variance = code.includes('fn clipHistory(')
    ? '{let mean=m1A/9.0;let sigma=sqrt(max(m2A/9.0-mean*mean,0.0))*temporal.settings.w;loA=max(loA,mean-sigma);hiA=min(hiA,mean+sigma);}'
    : '';
  // Every read of the scene's colour, premultiplied in linear light.
  let out = code
    .replaceAll('linear(textureLoad(scene,', 'premultiplied(textureLoad(scene,')
    .replaceAll(',0).rgb)', ',0))');
  out = edit(out, [
    ['var outputDepth:texture_storage_2d<r32float,write>;', 'var outputDepth:texture_storage_2d<rg32float,write>;'],
    [
      '@compute @workgroup_size(8,8)',
      'fn premultiplied(s:vec4f)->vec3f {let k=select(1.0,s.a,s.a>0.0&&s.a<1.0);return linear(s.rgb/k)*k;}\n@compute @workgroup_size(8,8)',
    ],
    [
      'var result=current;',
      'var result=current;let currentAlpha=textureLoad(scene,p,0).a;var resultAlpha=currentAlpha;var oldAlpha=0.0;' +
        'var loA=1e30;var hiA=-1e30;var m1A=0.0;var m2A=0.0;for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){' +
        'let a=textureLoad(scene,clamp(p+vec2i(x,y),vec2i(0),vec2i(size)-1),0).a;loA=min(loA,a);hiA=max(hiA,a);m1A+=a;m2A+=a*a;}}' +
        variance,
    ],
    ['total+=weight;}', 'oldAlpha+=textureLoad(history,pixel,0).a*weight;total+=weight;}'],
    ['result=mix(current,', `resultAlpha=mix(currentAlpha,${history},${weight});result=mix(current,`],
    [
      reactive
        ? 'textureStore(output,p,vec4f(max(result,vec3f(0)),react));'
        : 'textureStore(output,p,vec4f(max(result,vec3f(0)),1));',
      'textureStore(output,p,vec4f(max(result,vec3f(0)),clamp(resultAlpha,0.0,1.0)));',
    ],
    [
      'textureStore(outputDepth,p,vec4f(textureLoad(depth,p,0)));',
      `textureStore(outputDepth,p,vec4f(textureLoad(depth,p,0),${reactive ? 'react' : '0.0'},0,0));`,
    ],
  ]);
  if (reactive) out = edit(out, [['oldReact+=h.a*weight;', 'oldReact+=textureLoad(historyDepth,pixel,0).g*weight;']]);
  if (settles)
    out = edit(out, [
      [
        'fn settled(p:vec2i,m:u32,x:vec3f,result:vec3f)->vec3f {',
        'fn settled(p:vec2i,m:u32,x:vec4f,result:vec4f)->vec4f {',
      ],
      ['textureLoad(settleHistory,p,0).rgb', 'textureLoad(settleHistory,p,0)'],
      ['textureStore(settleOutput,p,vec4f(s,1))', 'textureStore(settleOutput,p,s)'],
      [
        'result=settled(p,settleFrames,current,result);',
        'let held=settled(p,settleFrames,vec4f(current,currentAlpha),vec4f(result,resultAlpha));result=held.rgb;resultAlpha=held.a;',
      ],
    ]);
  return out;
}

/** The settle detect pass hashing alpha too: a black surface over empty pixels differs in alpha alone. */
export const premultipliedDetect = (code: string): string =>
  edit(code, [
    [
      'fn sampleHash(c:vec3f)->u32 {var v=bitcast<vec4u>(vec4f(c,1))',
      'fn sampleHash(c:vec4f)->u32 {var v=bitcast<vec4u>(c)',
    ],
    ['sampleHash(textureLoad(scene,p,0).rgb)', 'sampleHash(textureLoad(scene,p,0))'],
  ]);

/**
 * TAA's present shader for a premultiplied canvas, before any present step: a partly covered pixel is encoded as
 * encode(c / a) a, and alpha is written. The step still sees the colour in `c`, but a step filters colour alone, so where
 * the coverage differs between the pixel and its four neighbours the pixel is shown as it is: sharpening premultiplied
 * colour across a coverage edge, with the alpha unchanged, would move the edge's straight colour.
 */
export const premultipliedPresent = (code: string): string =>
  edit(code, [
    [
      'return vec4f(select(c,select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308)),manualSRGB),1);',
      'let q=vec2i(i.clip.xy);let own=textureLoad(image,q,0);let a=clamp(own.a,0.0,1.0);let top=vec2i(textureDimensions(image))-1;var apart=0.0;\n' +
        '  for(var n=0;n<4;n++){let o=select(vec2i(0,n*2-1),vec2i(n*2-5,0),n>1);apart=max(apart,abs(textureLoad(image,clamp(q+o,vec2i(0),top),0).a-own.a));}\n' +
        '  let k=select(1.0,a,manualSRGB&&a>0.0&&a<1.0);let s=select(c,max(own.rgb,vec3f(0)),apart>0.002)/k;\n' +
        '  return vec4f(select(s,select(s*12.92,1.055*pow(s,vec3f(1.0/2.4))-0.055,s>=vec3f(0.0031308)),manualSRGB)*k,a);',
    ],
  ]);
