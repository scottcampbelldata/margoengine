import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const replace = (source, before, after) => {
  assert.equal(source.split(before).length, 2, `Expected one source anchor: ${before.slice(0, 100)}`);
  return source.replace(before, after);
};

/** Arithmetic-only private candidate keeps all public/Animation allocation contracts unchanged. */
export function animationSamplingArithmeticCandidate({index, sampling}) {
  let candidate = sampling;
  candidate = replace(candidate, "!['STEP','LINEAR','CUBICSPLINE'].includes(interpolation)", "interpolation!=='STEP'&&interpolation!=='LINEAR'&&interpolation!=='CUBICSPLINE'");
  candidate = replace(candidate, '  const at=(key:number,c:number)=>values[(key*factor+(factor===3?1:0))*width+c];', '  const ai=(a*factor+(factor===3?1:0))*width,bi=(b*factor+(factor===3?1:0))*width;');
  candidate = candidate.replaceAll('at(a,c)', 'values[ai+c]').replaceAll('at(b,c)', 'values[bi+c]');
  candidate = replace(candidate, 'Math.hypot(...out)', 'width===4?Math.hypot(out[0],out[1],out[2],out[3]):Math.hypot(...out)');
  candidate = replace(candidate, "  if(out.some(v=>!Number.isFinite(v)))throw new RangeError('Animation sample overflow');", "  for(let c=0;c<width;c++)if(!Number.isFinite(out[c]))throw new RangeError('Animation sample overflow');");
  assert.ok(!candidate.includes('const at=') && !candidate.includes('at(a,c)') && !candidate.includes('out.some('));
  return {index, sampling: candidate};
}

/** Smaller arithmetic variant: keep general quaternion normalization and use the native finite predicate. */
export function animationSamplingMinimalCandidate(source) {
  let candidate = animationSamplingArithmeticCandidate(source).sampling;
  candidate = replace(candidate, 'width===4?Math.hypot(out[0],out[1],out[2],out[3]):Math.hypot(...out)', 'Math.hypot(...out)');
  candidate = replace(candidate, "  for(let c=0;c<width;c++)if(!Number.isFinite(out[c]))throw new RangeError('Animation sample overflow');", "  if(!out.every(Number.isFinite))throw new RangeError('Animation sample overflow');");
  return {index: source.index, sampling: candidate};
}

/** Private test transformation only. Public sampleTrack still validates and returns a fresh Float32 result. */
export function animationOutputCandidate({index, sampling}) {
  let candidate = animationSamplingArithmeticCandidate({index, sampling}).sampling;
  const signature = 'export function sampleTrack(times:Float32Array,values:Float32Array,width:number,time:number,interpolation:Interpolation,quaternion=false):Float32Array {';
  candidate = replace(candidate, signature, `${signature}
  return sampleTrackInto(times,values,width,time,interpolation,quaternion);
}
export function sampleTrackInto(times:Float32Array,values:Float32Array,width:number,time:number,interpolation:Interpolation,quaternion=false,out?:Float32Array):Float32Array {`);
  candidate = replace(candidate, ')):0,out=new Float32Array(width);', ')):0;out=out?.length===width&&(!quaternion||width===4)?out:new Float32Array(width);');

  let body = replace(index, 'import {sampleTrack,multiplyMatrices,type Interpolation}', 'import {sampleTrackInto,multiplyMatrices,type Interpolation}');
  body = replace(body, '  private disposed=false;', '  private readonly samples:Float32Array[][];private readonly quaternion:number[]=[0,0,0,1];\n  private disposed=false;');
  body = replace(body, '    });\n  }\n  static attach', '    });\n    this.samples=this.clips.map(clip=>clip.tracks.map(track=>new Float32Array(track.width)));\n  }\n  static attach');
  body = replace(body, '    for(const track of clip.tracks) {', '    for(let i=0;i<clip.tracks.length;i++) {const track=clip.tracks[i];');
  body = replace(body, "const value=sampleTrack(track.times,track.values,track.width,t,track.interpolation,track.path==='rotation')", "const value=sampleTrackInto(track.times,track.values,track.width,t,track.interpolation,track.path==='rotation',this.samples[this.clip]?.[i])");
  body = replace(body, "      else if(track.path==='rotation')node.setQuaternion(Array.from(value));", "      else if(track.path==='rotation'){if(value.length!==4)node.setQuaternion(Array.from(value));else{for(let c=0;c<4;c++)this.quaternion[c]=value[c];node.setQuaternion(this.quaternion);}}");
  assert.ok(body.includes("export {sampleTrack,multiplyMatrices,type Interpolation}"), 'Published sampling exports changed');
  return {index: body, sampling: candidate};
}

export async function animationSources() {
  const [index, sampling] = await Promise.all(['index', 'sampling'].map(name => readFile(`packages/animation/src/${name}.ts`, 'utf8')));
  const original = {index: index.replace(/\r\n/g, '\n'), sampling: sampling.replace(/\r\n/g, '\n')};
  return {original, candidate: animationOutputCandidate(original), arithmetic: animationSamplingArithmeticCandidate(original), minimal: animationSamplingMinimalCandidate(original)};
}

/** Load private/original modules for exact CPU comparison without overwriting package source or dist. */
export async function importAnimationSources(source) {
  const url = code => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code, {mode: 'transform'})).toString('base64');
  const samplingURL = url(source.sampling), shaderURL = url(await readFile('packages/animation/src/shader.ts', 'utf8'));
  let index = source.index.replaceAll("'./sampling.js'", JSON.stringify(samplingURL)).replaceAll("'./shader.js'", JSON.stringify(shaderURL));
  index = index.replaceAll("'../../shared/math.js'", JSON.stringify(pathToFileURL(resolve('packages/shared/math.js')).href));
  return {sampling: await import(samplingURL), ...(await import(url(index)))};
}
