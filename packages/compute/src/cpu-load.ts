// The CPU backend's lazy door. context.ts loads this module with import(), while the ./cpu-wasm entry imports cpu.js
// statically to extend CpuContext; a separate door keeps any module from importing cpu.js both ways, so the import()
// still splits for apps that link both entries (tests/dist-dynamic-imports.test.js).
import type { ComputeContext } from './context.js';
import { CpuContext } from './cpu.js';

/** Makes the CPU context (createCompute's fallback). */
export const cpuContext = (): ComputeContext => new CpuContext();
