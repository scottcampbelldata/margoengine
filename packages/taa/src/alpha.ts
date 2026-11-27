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
  // Variance clipping moves history along the line to the box's centre, so colour and alpha are one point of one box:
  // clipping colour that way and clamping alpha on its own moved the two by different shares, and a partly covered
  // pixel's straight colour with them.
  const colourClip = 'clipHistory(ycocg(old/total),lo,hi,m1,m2)',
    variance = code.includes('fn clipHistory('),
    joint = 'clipPremultiplied(vec4f(ycocg(old/total),oldAlpha/total),vec4f(lo,loA),vec4f(hi,hiA),vec4f(m1,m1A),vec4f(m2,m2A))';
  const clamped = variance ? joint + '.w' : 'clamp(oldAlpha/total,loA,hiA)',
    history = locked ? `select(${clamped},oldAlpha/total,lock>0.0)` : clamped,
    weight = reactive ? 'temporal.settings.x*(1.0-max(react,oldReact/total))' : 'temporal.settings.x';
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
        'let a=textureLoad(scene,clamp(p+vec2i(x,y),vec2i(0),vec2i(size)-1),0).a;loA=min(loA,a);hiA=max(hiA,a);m1A+=a;m2A+=a*a;}}',
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
  if (variance)
    out = edit(out, [
      [colourClip, joint + '.xyz'],
      [
        'fn clipHistory(',
        'fn clipPremultiplied(h:vec4f,lo:vec4f,hi:vec4f,m1:vec4f,m2:vec4f)->vec4f {let mean=m1/9.0;' +
          'let sigma=sqrt(max(m2/9.0-mean*mean,vec4f(0)))*temporal.settings.w;let a=max(lo,mean-sigma);let b=min(hi,mean+sigma);' +
          'let centre=(a+b)*0.5;let extent=max((b-a)*0.5,vec4f(1e-6));let d=h-centre;let q=abs(d)/extent;' +
          'let t=max(max(q.x,q.y),max(q.z,q.w));return select(h,centre+d/t,t>1.0);}\n' +
          'fn clipHistory(',
      ],
    ]);
  if (reactive) out = edit(out, [['oldReact+=h.a*weight;', 'oldReact+=textureLoad(historyDepth,pixel,0).g*weight;']]);
  if (settles) out = alphaSettle(out, 'currentAlpha');
  return out;
}

/** A settling resolve's running mean (settle.ts) with alpha; `current` names the resolve's own alpha of this frame. */
function alphaSettle(code: string, current: string): string {
  return edit(code, [
    [
      'fn settled(p:vec2i,m:u32,x:vec3f,result:vec3f)->vec3f {',
      'fn settled(p:vec2i,m:u32,x:vec4f,result:vec4f)->vec4f {',
    ],
    ['textureLoad(settleHistory,p,0).rgb', 'textureLoad(settleHistory,p,0)'],
    ['textureStore(settleOutput,p,vec4f(s,1))', 'textureStore(settleOutput,p,s)'],
    [
      'result=settled(p,settleFrames,current,result);',
      `let held=settled(p,settleFrames,vec4f(current,${current}),vec4f(result,resultAlpha));result=held.rgb;resultAlpha=held.a;`,
    ],
  ]);
}

const premultipliedRead =
  'fn premultiplied(s:vec4f)->vec3f {let k=select(1.0,s.a,s.a>0.0&&s.a<1.0);return linear(s.rgb/k)*k;}\n';

/** TAAUpscale's finished temporal resolve for a premultiplied canvas: alpha takes the colour's filters and weights. */
export function premultipliedUpscale(code: string): string {
  const out = edit(code, [
    ['@compute @workgroup_size(8,8)', premultipliedRead + '@compute @workgroup_size(8,8)'],
    ['fn old(at:vec2f,top:vec2i)->vec3f {', 'fn old(at:vec2f,top:vec2i)->vec4f {'],
    ['var sum=vec3f(0);\n for(var y=0;y<4;y++)', 'var sum=vec4f(0);\n for(var y=0;y<4;y++)'],
    ['vec2i(0),top),0).rgb*wx[x]*wy[y];', 'vec2i(0),top),0)*wx[x]*wy[y];'],
    ['let s=linear(textureLoad(scene,q,0).rgb);', 'let t=textureLoad(scene,q,0);let s=premultiplied(t);'],
    ['wide+=s*g;wideTotal+=g;', 'wide+=s*g;wideTotal+=g;sumA+=t.a*w;wideA+=t.a*g;momentA+=vec2f(t.a,t.a*t.a);'],
    ['var near=0.0;', 'var near=0.0;var sumA=0.0;var wideA=0.0;var momentA=vec2f(0);'],
    [
      'var result=soft;',
      'var result=soft;let softAlpha=wideA/wideTotal;let currentAlpha=select(softAlpha,sumA/total,total>0.05);var resultAlpha=softAlpha;',
    ],
    [
      'let kept=rgb(clamp(ycocg(old(back*size,vec2i(size)-1)),mean-spread,mean+spread));',
      'let past=old(back*size,vec2i(size)-1);let kept=rgb(clamp(ycocg(past.rgb),mean-spread,mean+spread));' +
        'let meanA=momentA.x/9;let spreadA=sqrt(max(momentA.y/9-meanA*meanA,0.0))*u.a.z;',
    ],
    [
      'result=mix(kept,current,min(1,(1-u.a.x)*peak*f.x*f.y));',
      'let share=min(1,(1-u.a.x)*peak*f.x*f.y);result=mix(kept,current,share);' +
        'resultAlpha=mix(clamp(past.a,meanA-spreadA,meanA+spreadA),currentAlpha,share);',
    ],
    [
      'textureStore(output,p,vec4f(max(result,vec3f(0)),1));',
      'textureStore(output,p,vec4f(max(result,vec3f(0)),clamp(resultAlpha,0.0,1.0)));',
    ],
  ]);
  return out.includes('fn settled(') ? alphaSettle(out, 'currentAlpha') : out;
}

/** TAAUpscale's Lanczos path for a premultiplied canvas. */
export const premultipliedSpatial = (code: string): string =>
  edit(code, [
    ['@compute @workgroup_size(8,8)', premultipliedRead + '@compute @workgroup_size(8,8)'],
    ['var sum=vec3f(0);var total=0.0;', 'var sum=vec3f(0);var total=0.0;var sumA=0.0;var loA=1e30;var hiA=-1e30;'],
    [
      'let s=linear(textureLoad(scene,clamp(n,vec2i(0),top),0).rgb);',
      'let t=textureLoad(scene,clamp(n,vec2i(0),top),0);let s=premultiplied(t);',
    ],
    ['sum+=s*w;total+=w;', 'sum+=s*w;total+=w;sumA+=t.a*w;'],
    ['lo=min(lo,s);hi=max(hi,s);', 'lo=min(lo,s);hi=max(hi,s);loA=min(loA,t.a);hiA=max(hiA,t.a);'],
    ['vec4f(clamp(sum/total,lo,hi),1)', 'vec4f(clamp(sum/total,lo,hi),clamp(sumA/total,loA,hiA))'],
  ]);

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
 * TAA's or TAAUpscale's present shader for a premultiplied canvas, before any present step: a partly covered pixel is
 * encoded as encode(c / a) a, and alpha is written. `colour` names the shader's linear colour and `at` its pixel. A
 * sharpen filters colour alone, so where the coverage differs between the pixel and its four neighbours the pixel is
 * shown as it is: sharpening premultiplied colour across a coverage edge, with the alpha unchanged, would move the
 * edge's straight colour.
 */
export const premultipliedPresent = (code: string, colour = 'c', at = 'vec2i(i.clip.xy)'): string =>
  edit(code, [
    [
      `return vec4f(select(${colour},select(${colour}*12.92,1.055*pow(${colour},vec3f(1.0/2.4))-0.055,${colour}>=vec3f(0.0031308)),manualSRGB),1);`,
      `let q=${at};let own=textureLoad(image,q,0);let a=clamp(own.a,0.0,1.0);let size=vec2i(textureDimensions(image))-1;var apart=0.0;\n` +
        '  for(var n=0;n<4;n++){let o=select(vec2i(0,n*2-1),vec2i(n*2-5,0),n>1);apart=max(apart,abs(textureLoad(image,clamp(q+o,vec2i(0),size),0).a-own.a));}\n' +
        `  let k=select(1.0,a,manualSRGB&&a>0.0&&a<1.0);let s=select(${colour},max(own.rgb,vec3f(0)),apart>0.002)/k;\n` +
        '  return vec4f(select(s,select(s*12.92,1.055*pow(s,vec3f(1.0/2.4))-0.055,s>=vec3f(0.0031308)),manualSRGB)*k,a);',
    ],
  ]);
