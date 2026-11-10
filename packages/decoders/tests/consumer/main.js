// A production consumer: the bundler must emit the classic worker, both Wasm binaries and both Emscripten wrappers.
import { DracoDecoder, KTX2Decoder } from '@margoengine/decoders';
import { JXLDecoder } from '../../dist/jxl.js';
import { DracoPointsDecoder } from '../../dist/draco-points.js';
import { DracoDecoder as NativeDraco } from '../../dist/draco-native.js';
import { KTX2HDR6Decoder } from '../../dist/ktx2-hdr6.js';
import hdr6URL from '../fixtures/ktx2-hdr6/intermediate-real.ktx2?url';
import boxURL from '../fixtures/Box.bin?url';
import ktxURL from '../fixtures/AnisotropyBarnLamp_normalbump.ktx2?url';
import jxlURL from '../fixtures/jxl/grayscale.jxl?url';
import cubeURL from '../fixtures/draco-points/cube_pc.drc?url';

window.runConsumer = async () => {
  const hdr6 = new KTX2HDR6Decoder({ workerLimit: 1 });
  try {
    const texture = await hdr6.decode(await (await fetch(hdr6URL)).arrayBuffer());
    if (texture.width !== 128 || texture.format !== 'rgba16float' || texture.mipmaps.length !== 8)
      throw new Error('HDR6 production worker or Wasm asset failed');
  } finally {
    hdr6.dispose();
  }
  const native = new NativeDraco({ workerLimit: 1 });
  try {
    const mesh = await native.decode(await (await fetch(boxURL)).arrayBuffer(), {
      attributeIds: { NORMAL: 0, POSITION: 1 },
    });
    if (mesh.vertexCount !== 24 || mesh.indices.length !== 36) throw new Error('optional native production consumer');
  } finally {
    native.dispose();
  }
  const draco = new DracoDecoder({ workerLimit: 1 }),
    ktx2 = new KTX2Decoder({ target: 'rgba8', workerLimit: 1 }),
    jxl = new JXLDecoder({ browser: false, workerLimit: 1 }),
    points = new DracoPointsDecoder({ workerLimit: 1 });
  try {
    const box = await draco.decode(await (await fetch(boxURL)).arrayBuffer(), {
      attributeIds: { NORMAL: 0, POSITION: 1 },
    });
    const texture = await ktx2.transcode(await (await fetch(ktxURL)).arrayBuffer());
    const image = await jxl.decode(await (await fetch(jxlURL)).arrayBuffer()),
      cloud = await points.decode(await (await fetch(cubeURL)).arrayBuffer());
    return {
      vertices: box.vertexCount,
      indices: box.indices.length,
      width: texture.width,
      format: texture.format,
      jxlWidth: image.width,
      points: cloud.pointCount,
    };
  } finally {
    draco.dispose();
    ktx2.dispose();
    jxl.dispose();
    points.dispose();
  }
};
