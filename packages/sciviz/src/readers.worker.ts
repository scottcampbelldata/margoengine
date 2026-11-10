import { RpcClient, exposeRpc, rpcTransfer, type RpcContext, type RpcEndpoint } from '@margoengine/worker/rpc';
import { loadNRRD } from './nrrd.js';
import { loadNIfTI, parseNIfTI, parseDICOM, dicomSeries, loadDICOMSeries, openZarr } from './formats.js';
import { parseVtk, openVTK } from './vtk.js';
import { openNetCDF } from './netcdf.js';
import { fault } from '../../shared/errors.js';
import {
  encodeReader,
  decodeReader,
  readerBuffers,
  type ReaderProtocol,
  type ReaderCallbacks,
  type RemoteFunction,
  type WireNode,
} from './reader-wire.js';

const readers = {
  loadNRRD,
  loadNIfTI,
  parseNIfTI,
  parseDICOM,
  dicomSeries,
  loadDICOMSeries,
  openZarr,
  parseVtk,
  openVTK,
  openNetCDF,
};
const functions = new Map<number, RemoteFunction>();
const callbacks = new RpcClient<ReaderCallbacks>(globalThis as unknown as RpcEndpoint);
let opened = false;
const bytes = (v: unknown) => readerBuffers(v).reduce((n, b) => n + b.byteLength, 0);

async function run(operation: string, node: WireNode, context: RpcContext, fn: RemoteFunction) {
  context.progress({ operation, phase: 'start', bytes: bytes(node) });
  const args = decodeReader(
    node,
    async (id, next) => {
      const result = await callbacks.call('callback', [id, encodeReader(next, functions)], { signal: context.signal });
      return decodeReader(
        result,
        async () => {
          throw fault('state', 'Callback results must be data', 'sciviz');
        },
        context.signal,
      );
    },
    context.signal,
  ) as unknown[];
  context.signal.throwIfAborted();
  const value = await fn(...args);
  context.signal.throwIfAborted();
  // Lazy arrays may cache storage and metadata may alias it. Transfer a snapshot, retaining worker state intact.
  const result = structuredClone(encodeReader(value, functions));
  context.progress({ operation, phase: 'complete', bytes: bytes(result) });
  return rpcTransfer(result, readerBuffers(result));
}

exposeRpc<ReaderProtocol>({
  async open(reader, args, context) {
    if (opened || !Object.hasOwn(readers, reader))
      throw fault('state', 'Open exactly one named reader per session', 'sciviz');
    opened = true;
    return run(reader, args, context, (...params) => {
      // Reader defaults remain authoritative; supply a worker-local cancellation signal when absent.
      const index = reader === 'openZarr' ? 2 : 1;
      if (reader !== 'parseVtk' && reader !== 'dicomSeries')
        params[index] = { ...(params[index] as object), signal: context.signal };
      const fn = readers[reader as keyof typeof readers] as RemoteFunction;
      return fn(...params);
    });
  },
  async invoke(id, args, context) {
    const fn = functions.get(id);
    if (!fn) throw fault('state', 'Reader method has expired; open a new session', 'sciviz');
    return run(`method:${id}`, args, context, fn);
  },
});
