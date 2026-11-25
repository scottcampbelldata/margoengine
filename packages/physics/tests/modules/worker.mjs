// A worker thread of the shared-memory prototype (tests/world-modules.test.js): it makes its own instance of the reader
// module on the world's shared memory, on the stack region the main thread gave it, and runs its share of the elements
// and of the chunk sums, writing only its own elements.
import { parentPort, workerData } from 'node:worker_threads';
import { instantiateSolverModule } from '../../dist/world.js';

const { memory, module, stack, port, stride, out, sums, n, chunk, level, range, chunks } = workerData;
const reader = await instantiateSolverModule(memory, module, stack);
reader.reader_depth(port, stride, range[0], range[1], level, out);
parentPort.postMessage('depths');
parentPort.once('message', () => {
  reader.reader_chunk_sums(out, n, chunk, chunks[0], chunks[1], sums);
  parentPort.postMessage({ stackPointer: reader.__stack_pointer.value });
});
