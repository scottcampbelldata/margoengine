// A production consumer: the bundler must emit the classic worker, both Wasm binaries and both Emscripten wrappers.
import { DracoDecoder, KTX2Decoder } from '@margoengine/decoders';
import { JXLDecoder } from '../../dist/jxl.js';
import boxURL from '../fixtures/Box.bin?url';
import ktxURL from '../fixtures/AnisotropyBarnLamp_normalbump.ktx2?url';
import jxlURL from '../fixtures/jxl/grayscale.jxl?url';

window.runConsumer = async () => {
  const draco = new DracoDecoder({ workerLimit: 1 }),
    ktx2 = new KTX2Decoder({ target: 'rgba8', workerLimit: 1 }),
    jxl = new JXLDecoder({ browser: false, workerLimit: 1 });
  try {
    const box = await draco.decode(await (await fetch(boxURL)).arrayBuffer(), {
      attributeIds: { NORMAL: 0, POSITION: 1 },
    });
    const texture = await ktx2.transcode(await (await fetch(ktxURL)).arrayBuffer());
    const image = await jxl.decode(await (await fetch(jxlURL)).arrayBuffer());
    return {
      vertices: box.vertexCount,
      indices: box.indices.length,
      width: texture.width,
      format: texture.format,
      jxlWidth: image.width,
    };
  } finally {
    draco.dispose();
    ktx2.dispose();
    jxl.dispose();
  }
};
