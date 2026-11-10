import { RpcClient, RpcPool, exposeRpc, rpcTransfer, type RpcEndpoint } from '../dist/rpc.js';
interface Tasks {
  sum(a: number, b: number): number;
  bytes(data: ArrayBuffer): Promise<ArrayBuffer>;
}
declare const endpoint: RpcEndpoint;
const client = new RpcClient<Tasks>(endpoint);
const promise: Promise<number> = client.call('sum', [1, 2]);
void promise;
// @ts-expect-error Typed method names.
client.call('missing', []);
// @ts-expect-error Typed arguments.
client.call('sum', ['wrong', 2]);
// @ts-expect-error Typed result.
const wrong: Promise<string> = client.call('sum', [1, 2]);
void wrong;
exposeRpc<Tasks>(
  {
    sum(a, b, context) {
      context.signal.throwIfAborted();
      return a + b;
    },
    bytes(data, context) {
      context.signal.throwIfAborted();
      return rpcTransfer(data, [data]);
    },
  },
  endpoint,
);
declare const pool: RpcPool<Tasks>;
const bytes: Promise<ArrayBuffer> = pool.call('bytes', [new ArrayBuffer(8)]);
void bytes;
