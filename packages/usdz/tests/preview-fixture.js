import { deflateSync, deflateRawSync } from 'node:zlib';
import { crc32 } from '@margoengine/loaders';
function png(r, g, b) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type, data) => {
    const name = Buffer.from(type),
      size = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function zip(files, method = 0) {
  let offset = 0;
  const locals = [],
    directory = [];
  for (const [name, data] of files) {
    const filename = Buffer.from(name),
      compressed = method === 8 ? deflateRawSync(data) : data,
      header = Buffer.alloc(30),
      central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, filename, compressed);
    directory.push(central, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const cd = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
export function previewFixture() {
  const text = `#usda 1.0
(metersPerUnit=1 upAxis="Y")
def Mesh "M" { uniform token subdivisionScheme="none" rel material:binding=</Mat> int[] faceVertexCounts=[3] int[] faceVertexIndices=[0,1,2] point3f[] points=[(-1,-1,0),(1,-1,0),(0,1,0)] float[] primvars:customRough=[0.1,0.5,0.9] (interpolation="vertex") float2[] primvars:alphaUV=[(0,0),(1,0),(0,1)] (interpolation="vertex") }
def Material "Mat" { token outputs:surface.connect=</Mat/S.outputs:surface>
 def Shader "S" {uniform token info:id="UsdPreviewSurface" color3f inputs:diffuseColor=(0.2,0.7,0.3) float inputs:opacity.connect=</Mat/T.outputs:r> float inputs:roughness.connect=</Mat/R.outputs:result>}
 def Shader "T" {uniform token info:id="UsdUVTexture" asset inputs:file=@alpha.png@ float2 inputs:st.connect=</Mat/UV.outputs:result>}
 def Shader "R" {uniform token info:id="UsdPrimvarReader_float" string inputs:varname="customRough"}
 def Shader "UV" {uniform token info:id="UsdPrimvarReader_float2" string inputs:varname="alphaUV"}
}`;
  return zip([
    ['scene.usda', Buffer.from(text)],
    ['alpha.png', png(128, 0, 0)],
  ]);
}
export function previewReaderFixture() {
  const inputs = {
    diffuseColor: [0.2, 0.7, 0.3],
    opacity: [0.6],
    roughness: [0.4],
    metallic: [0.2],
    emissiveColor: [0.1, 0.01, 0],
    occlusion: [0.9],
    normal: [0, 0, 1],
    clearcoat: [0.2],
    clearcoatRoughness: [0.3],
    ior: [1.5],
    specularColor: [0.04, 0.05, 0.06],
  };
  const attrs = Object.entries(inputs)
    .map(
      ([name, v]) =>
        `${v.length === 1 ? 'float' : 'float3'}[] primvars:${name}=[${v.length === 1 ? v[0] : '(' + v.join(',') + ')'}] (interpolation="constant")`,
    )
    .join('\n');
  const connections = Object.entries(inputs)
    .map(([name, v]) => `${v.length === 1 ? 'float' : 'color3f'} inputs:${name}.connect=</Mat/${name}.outputs:result>`)
    .join('\n');
  const readers = Object.entries(inputs)
    .map(
      ([name, v]) =>
        `def Shader "${name}" {uniform token info:id="UsdPrimvarReader_float${v.length === 1 ? '' : 3}" string inputs:varname="${name}"}`,
    )
    .join('\n');
  return `#usda 1.0\n(metersPerUnit=1 upAxis="Y")\ndef Mesh "M" {uniform token subdivisionScheme="none" rel material:binding=</Mat> int[] faceVertexCounts=[3] int[] faceVertexIndices=[0,1,2] point3f[] points=[(-1,-1,0),(1,-1,0),(0,1,0)] ${attrs}}\ndef Material "Mat" {token outputs:surface.connect=</Mat/S.outputs:surface> def Shader "S" {uniform token info:id="UsdPreviewSurface" ${connections}} ${readers}}`;
}
