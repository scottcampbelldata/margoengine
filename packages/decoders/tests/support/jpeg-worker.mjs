import { parentPort, workerData } from 'node:worker_threads';
import { decodeImage } from '@margoengine/decoders/image';
parentPort.postMessage(await decodeImage(workerData));
