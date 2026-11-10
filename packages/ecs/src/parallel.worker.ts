import { serveParallelSystems, type ParallelEndpoint } from './parallel-runtime.js';
serveParallelSystems(globalThis as unknown as ParallelEndpoint);
