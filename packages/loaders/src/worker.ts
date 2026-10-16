import { LoaderError, type LoadedGeometry } from './types.js';
import type { BinaryInput } from './util.js';
import { parseUSDA, parseUSDZ, type USDOptions } from './usdz.js';
import { canUseWorker, movable, runWorker } from '../../shared/worker.js';

const workerURL = () => new URL('./workers/usd.js?no-inline', import.meta.url);
const revive = (e: { name: string; message: string; [key: string]: unknown }) =>
  e.name === 'LoaderError'
    ? Object.assign(new LoaderError(e.format as string, e.code as LoaderError['code'], ''), { message: e.message })
    : undefined;
const run = (format: 'usda' | 'usdz', input: string | BinaryInput, { signal, ...options }: USDOptions) =>
  runWorker<LoadedGeometry>(workerURL(), { format, input: movable(input), options }, signal, revive);
/**
 * parseUSDZ in a worker: same LoadedGeometry, its arrays transferred back. A whole ArrayBuffer input moves to the
 * worker and is detached here (pass a copy to keep it). Runs on this thread when Workers are unavailable.
 */
export async function parseUSDZInWorker(input: BinaryInput, options: USDOptions = {}): Promise<LoadedGeometry> {
  return canUseWorker() ? run('usdz', input, options) : parseUSDZ(input, options);
}
/** parseUSDA in a worker; see parseUSDZInWorker. */
export async function parseUSDAInWorker(
  input: string | BinaryInput,
  options: USDOptions = {},
): Promise<LoadedGeometry> {
  return canUseWorker() ? run('usda', input, options) : parseUSDA(input, options);
}
