import { parentPort, workerData } from 'node:worker_threads';
import { decodeLZ4 } from '@margoengine/decoders/lz4';
import { decompressZstd } from '@margoengine/decoders/zstd';
parentPort.postMessage({ lz4: await decodeLZ4(workerData.lz4), zstd: await decompressZstd(workerData.zstd) });
