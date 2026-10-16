/** Caller-owned, filterable 2D texture and optional filtering sampler. */
export interface MaterialExtensionTexture {view:GPUTextureView;sampler?:GPUSampler}

/** Optional material slot. Group 3 is permanently reserved; lighting stays in group 2. */
export interface MaterialExtension {
  /** Statements after surface(i,front), in every fragment entry point. May mutate s. */
  wgsl?:string;
  /** Beauty-only statements after directional direct lighting, before lighting effects. */
  direct?:string;
  /** Statements after hemispherical ambient lighting; may mutate materialAmbient. */
  ambient?:string;
  /** Beauty-only statements after output encoding, before the final return. */
  output?:string;
  /** Disable optional lighting bindings for a caller-managed surface. */
  lighting?:boolean;
  /** Module-scope WGSL helpers, in addition to the generated resource declarations. */
  declarations?:string;
  /** One or more packed vec4 factors, exposed as materialFactors[index]. */
  factors?:Float32Array;
  /** materialTextureN / materialSamplerN, at bindings 1+2*N / 2+2*N. */
  textures?:readonly MaterialExtensionTexture[];
}

declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
interface ExtensionGroup {entries:GPUBindGroupEntry[];group:GPUBindGroup;gap?:GPUBindGroup}
function validateDeclarations(declarations:unknown):void {
  if(declarations!==undefined&&typeof declarations!=='string')throw new TypeError('Invalid material extension WGSL');
  if(typeof declarations==='string'&&/@\s*(?:group|binding)\b/.test(declarations))
    throw new TypeError('Material extension declarations cannot declare @group or @binding; use factors and textures');
}
export interface MaterialExtensionResource {
  uniform?:GPUBuffer;
  bytes:number;
  entries:GPUBindGroupEntry[];
  groups:Map<GPURenderPipeline,ExtensionGroup>;
}

export function prepareMaterialExtension(device:GPUDevice,extension:MaterialExtension,previous?:MaterialExtensionResource):MaterialExtensionResource {
  if(!extension||typeof extension!=='object'||extension.wgsl!==undefined&&typeof extension.wgsl!=='string'||extension.direct!==undefined&&typeof extension.direct!=='string'||extension.ambient!==undefined&&typeof extension.ambient!=='string'||extension.output!==undefined&&typeof extension.output!=='string'||extension.lighting!==undefined&&typeof extension.lighting!=='boolean'||extension.declarations!==undefined&&typeof extension.declarations!=='string')throw new TypeError('Invalid material extension WGSL');
  validateDeclarations(extension.declarations);
  const {factors,textures=[]}=extension;
  if(factors!==undefined&&(!(factors instanceof Float32Array)||!factors.length||factors.length%4||factors.some(v=>!Number.isFinite(v))))throw new TypeError('Material extension factors require finite vec4 values');
  const bytes=factors?.byteLength??0;
  if(bytes>Math.min(device.limits.maxUniformBufferBindingSize??Infinity,device.limits.maxBufferSize))throw new RangeError('Material extension factors exceed device limit');
  if(!Array.isArray(textures)||textures.some(t=>!t?.view))throw new TypeError('Invalid material extension textures');
  if(textures.length+5>(device.limits.maxSampledTexturesPerShaderStage??Infinity)||textures.filter(texture=>texture.sampler).length+5>(device.limits.maxSamplersPerShaderStage??Infinity))throw new RangeError('Material extension textures exceed device binding limits');
  if((bytes||textures.length)&&(device.limits.maxBindGroups??4)<4)throw new RangeError('Material extensions require bind group 3');
  const resource:MaterialExtensionResource=previous??{bytes:0,entries:[],groups:new Map()};
  if(bytes!==resource.bytes){
    // Allocate first so a failed allocation leaves the previous resource usable.
    const uniform=bytes?device.createBuffer({size:bytes,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}):undefined;
    resource.uniform?.destroy();resource.uniform=uniform;resource.bytes=bytes;resource.groups.clear();
  }
  try{if(factors)device.queue.writeBuffer(resource.uniform!,0,factors as Float32Array<ArrayBuffer>);}
  catch(error){if(!previous)resource.uniform?.destroy();throw error;}
  resource.entries=resource.uniform?[{binding:0,resource:{buffer:resource.uniform}}]:[];
  textures.forEach((texture,i)=>{
    resource.entries.push({binding:1+i*2,resource:texture.view});
    if(texture.sampler)resource.entries.push({binding:2+i*2,resource:texture.sampler});
  });
  return resource;
}

export function materialExtensionShader(source:string,extension:MaterialExtension):string {
  validateDeclarations(extension.declarations);
  // Even an empty extension has a distinct pipeline signature.
  let declarations='// Material extension: group 3\n',access='';
  if(extension.factors){
    declarations+=`@group(3) @binding(0) var<uniform> materialFactors:array<vec4f,${extension.factors.length/4}>;\n`;
    access+='_ = materialFactors;\n';
  }
  (extension.textures??[]).forEach((texture,i)=>{
    declarations+=`@group(3) @binding(${1+i*2}) var materialTexture${i}:texture_2d<f32>;\n`;
    access+=`_ = materialTexture${i};\n`;
    if(texture.sampler){
      declarations+=`@group(3) @binding(${2+i*2}) var materialSampler${i}:sampler;\n`;
      access+=`_ = materialSampler${i};\n`;
    }
  });
  // Phony assignments retain the resource interface even for factors-only slots,
  // without texture samples or changes to the surface (WGSL 9.2.3).
  let code=source;
  if(extension.direct)code=code.replace('let direct=','var direct=').replace('var color=',()=>`${extension.direct}\n  var color=`);
  if(extension.output)code=code.replace('  return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));',()=>`  ${extension.output}\n  return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));`);
  code=code.replaceAll('let s=surface(i,front);',()=>`var s=surface(i,front);\n${access}${extension.wgsl??''}\n`);
  return declarations+(extension.declarations??'')+'\n'+code;
}

/** Apply after optional lighting effects have matched their standard lighting call sites. */
export function materialExtensionAmbientShader(source:string,extension:MaterialExtension):string {
  if(!extension.ambient)return source;
  const entry=(name:string,rewrite:(code:string)=>string)=>{
    const start=source.indexOf('@fragment fn '+name+'(');if(start<0)return;
    const next=source.indexOf('@fragment',start+1),end=next<0?source.length:next;
    source=source.slice(0,start)+rewrite(source.slice(start,end))+source.slice(end);
  };
  entry('fragment',code=>code.replace('var color=',()=>`var materialAmbient=ambient(s);\n${extension.ambient}\n  var color=`).replace('ambient(s)+s.emissive','materialAmbient+s.emissive'));
  entry('ambientFragment',code=>code.replace('return vec4f(ambient(s),',()=>`var materialAmbient=ambient(s);\n${extension.ambient}\n  return vec4f(materialAmbient,`));
  return source;
}

export function bindMaterialExtension(device:GPUDevice,pass:GPURenderPassEncoder,pipeline:GPURenderPipeline,resource:MaterialExtensionResource,lighting:boolean):void {
  const {entries}=resource;if(!entries.length)return;
  let cached=resource.groups.get(pipeline);
  if(!cached||entries.length!==cached.entries.length||entries.some((entry,i)=>{
    const old=cached!.entries[i].resource,value=entry.resource;
    return entry.binding!==cached!.entries[i].binding||!(value===old||'buffer' in value&&'buffer' in old&&value.buffer===old.buffer);
  })){
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(3),entries});
    // Auto layouts include the empty group 2 when group 3 is used without lighting.
    const gap=lighting?undefined:device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[]});
    cached={entries,group,gap};resource.groups.set(pipeline,cached);
  }
  if(!lighting){
    cached.gap??=device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[]});
    pass.setBindGroup(2,cached.gap);
  }
  pass.setBindGroup(3,cached.group);
}
