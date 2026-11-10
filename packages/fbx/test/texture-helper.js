import { rigFixture } from './native-scene-helper.js';
import { tga, tiff, dds, bc1Solid } from '../../decoders/tests/support/texture-encoders.js';
const bmp = new Uint8Array(58),
  v = new DataView(bmp.buffer);
bmp.set([66, 77]);
v.setUint32(10, 54, true);
v.setUint32(14, 40, true);
v.setInt32(18, 1, true);
v.setInt32(22, 1, true);
v.setUint16(26, 1, true);
v.setUint16(28, 24, true);
bmp.set([0, 0, 255, 0], 54);
export const files = {
  bmp,
  tga: tga({ type: 2, width: 1, height: 1, bits: 24, descriptor: 32, pixels: [new Uint8Array([0, 0, 255])] }),
  tiff: tiff({ width: 1, height: 1, spp: 3, bits: 8, photometric: 2, samples: [255, 0, 0] }),
  dds: dds({ width: 4, height: 4, fourCC: 'DXT1', data: bc1Solid(255, 0, 0) }),
};
export const fixture = (name, bytes) =>
  new TextEncoder().encode(
    rigFixture({
      skin: false,
      morph: false,
      animation: false,
      extraModel: `Material: 50, "Material::Paint", "Phong" {\n}\nTexture: 51, "Texture::Image", "" {\nRelativeFilename: "color.${name}"\n}\n${bytes ? `Video: 52, "Video::Image", "Clip" {\nContent: "${Buffer.from(bytes).toString('base64')}"\n}` : ''}`,
      extraConnections: `C: "OO",50,2\nC: "OP",51,50,"DiffuseColor"\n${bytes ? 'C: "OO",52,51' : ''}`,
    }).replace(
      'PolygonVertexIndex:',
      'LayerElementUV: 0 {\nMappingInformationType: "ByControlPoint"\nReferenceInformationType: "Direct"\nUV: *6 {\na: 0,0,1,0,0,1\n}\n}\nPolygonVertexIndex:',
    ),
  );
