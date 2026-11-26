import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';

export interface ShellBuilds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

async function compile(url: URL, signal: AbortSignal | undefined): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    url.search = '';
    const specifier = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Crush shell kernel returned HTTP ${response.status}. Check that its Wasm asset is served.`,
    );
  return WebAssembly.compile(await response.arrayBuffer());
}

export async function loadShell(signal?: AbortSignal): Promise<ShellBuilds> {
  const [plain, shared] = await Promise.all([
    compile(new URL(/* @vite-ignore */ './crush-shell-kernel.wasm?no-inline', import.meta.url), signal),
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './crush-shell-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  signal?.throwIfAborted();
  return { plain, shared };
}

interface ShellExports extends WebAssembly.Exports {
  crush_shell_advance(descriptor: number, seconds: number, count: number, work: number): number;
}

export function instanceFor(host: SolverHost, builds: ShellBuilds): { kernel: ShellExports; stack: Region } {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      'This host cannot load the shared crush shell kernel. Use a plain-memory world.',
    );
  const stack = host.allocate('shell-stack', STACK_BYTES + 8, 'u8', 1);
  const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as ShellExports;
  const pointer = kernel.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError(
      'failed',
      'The crush shell module has no arena stack pointer. Run the crush shell asset build.',
    );
  pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return { kernel, stack };
}
