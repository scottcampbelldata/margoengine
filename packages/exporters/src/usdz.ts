import {collect,drawables,num,toWorld,normalizeMaterial,type ExportSource,type SceneOptions} from './scene.js';
export interface USDZOptions extends SceneOptions {}

function crc32(bytes:Uint8Array):number {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
  return (crc^0xffffffff)>>>0;
}
const tuples=(values:ArrayLike<number>,size:number):string=>{
  const result:string[]=[];
  for(let i=0;i<values.length;i+=size)result.push(`(${Array.from({length:size},(_,k)=>num(values[i+k])).join(', ')})`);
  return `[${result.join(', ')}]`;
};

/** Static, world-space USD meshes with UsdPreviewSurface materials in a stored, 64-byte-aligned USDZ archive. */
export function exportUSDZ(source:ExportSource,options:USDZOptions={}):Uint8Array {
  const items=drawables(collect(source,options));
  if(!items.length)throw new RangeError('USDZ requires at least one mesh');
  const lines=['#usda 1.0','(','    defaultPrim = "Margo"','    metersPerUnit = 1','    upAxis = "Y"',')','def Xform "Margo" {'];
  for(let i=0;i<items.length;i++) {
    const item=items[i],{positions,normals,indices}=toWorld(item),material=item.material??normalizeMaterial({});
    if(material.baseColorTexture||material.metallicRoughnessTexture||material.normalTexture)throw new TypeError('USDZ texture export is unsupported');
    if(item.geometry.colors)throw new TypeError('USDZ vertex color export is unsupported');
    if(material.alphaMode==='MASK')throw new TypeError('USDZ alpha-mask export is unsupported');
    for(const value of positions)if(!Number.isFinite(Math.fround(value)))throw new RangeError('USDZ world position exceeds Float32 range');
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let v=0;v<positions.length;v++){const axis=v%3;min[axis]=Math.min(min[axis],positions[v]);max[axis]=Math.max(max[axis],positions[v]);}
    lines.push(`def Mesh "Mesh_${i}" (apiSchemas = ["MaterialBindingAPI"]) {`,`    string displayName = ${JSON.stringify(item.name??`Mesh ${i}`)}`,
      `    float3[] extent = ${tuples([...min,...max],3)}`,
      `    point3f[] points = ${tuples(positions,3)}`,`    normal3f[] normals = ${tuples(normals,3)} (interpolation = "vertex")`,
      `    int[] faceVertexCounts = [${Array(indices.length/3).fill(3).join(', ')}]`,`    int[] faceVertexIndices = [${Array.from(indices).join(', ')}]`,
      '    uniform token subdivisionScheme = "none"',`    uniform bool doubleSided = ${material.doubleSided}`,
      `    color3f[] primvars:displayColor = ${tuples(material.color.slice(0,3),3)}`,
      `    rel material:binding = </Margo/Material_${i}>`,'}',`def Material "Material_${i}" {`,
      `    token outputs:surface.connect = </Margo/Material_${i}/Surface.outputs:surface>`,'    def Shader "Surface" {','        uniform token info:id = "UsdPreviewSurface"',
      `        color3f inputs:diffuseColor = (${material.color.slice(0,3).map(num).join(', ')})`,
      `        color3f inputs:emissiveColor = (${material.emissive.map(num).join(', ')})`,
      `        float inputs:roughness = ${num(material.roughness)}`,`        float inputs:metallic = ${num(material.metalness)}`,
      `        float inputs:opacity = ${num(material.alphaMode==='OPAQUE'?1:material.color[3])}`,'        token outputs:surface','    }','}');
  }
  lines.push('}');
  const content=new TextEncoder().encode(lines.join('\n')+'\n'),name=new TextEncoder().encode('scene.usda');
  if(content.length>0xffffffff-128)throw new RangeError('USDZ exceeds ZIP32 size');
  const padding=(64-(30+name.length)%64)%64,extra=padding>=4?padding:padding+64,start=30+name.length+extra,central=start+content.length;
  const out=new Uint8Array(central+46+name.length+22),view=new DataView(out.buffer),crc=crc32(content);
  view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint32(14,crc,true);view.setUint32(18,content.length,true);view.setUint32(22,content.length,true);
  view.setUint16(26,name.length,true);view.setUint16(28,extra,true);out.set(name,30);
  view.setUint16(30+name.length,0x1986,true);view.setUint16(32+name.length,extra-4,true);out.set(content,start);
  view.setUint32(central,0x02014b50,true);view.setUint16(central+4,20,true);view.setUint16(central+6,20,true);view.setUint32(central+16,crc,true);
  view.setUint32(central+20,content.length,true);view.setUint32(central+24,content.length,true);view.setUint16(central+28,name.length,true);out.set(name,central+46);
  const end=central+46+name.length;view.setUint32(end,0x06054b50,true);view.setUint16(end+8,1,true);view.setUint16(end+10,1,true);view.setUint32(end+12,46+name.length,true);view.setUint32(end+16,central,true);
  return out;
}
