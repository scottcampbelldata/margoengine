import {exportGLB} from '@margoengine/exporters';
import {parseDocument} from './document.js';
import {context,buildScene} from './scene.js';
import {attachMaterials} from './material.js';
import {attachSkin} from './skin.js';
import {attachMorphs,type MorphBinding} from './morph.js';
import {buildAnimations} from './animation.js';

export async function convert(input:ArrayBuffer|ArrayBufferView,resourcePath:string,signal?:AbortSignal):Promise<ArrayBuffer>{
  const document=await parseDocument(input,signal),ctx=context(document,signal);buildScene(ctx);
  const morphs:MorphBinding[]=[];
  for(const mesh of ctx.meshes){
    signal?.throwIfAborted();attachSkin(ctx,mesh);const morph=attachMorphs(ctx,mesh);if(morph)morphs.push(morph);
  }
  await attachMaterials(ctx,resourcePath);signal?.throwIfAborted();
  const animations=buildAnimations(ctx,morphs),bytes=exportGLB({nodes:ctx.roots,animations},{generator:'Margo Engine fbx'});
  signal?.throwIfAborted();if(bytes.byteLength>128*1024*1024)throw new RangeError('FBX conversion budget exceeded');
  return bytes.buffer as ArrayBuffer;
}
