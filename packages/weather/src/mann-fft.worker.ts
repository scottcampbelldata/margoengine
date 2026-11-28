import { MargoError } from '@margoengine/math/errors';
import { bindMannFft, type MannFftReply, type MannFftRequest } from './turbulence-native-core.js';

function respond(send: (reply: MannFftReply, transfer?: ArrayBuffer[]) => void) {
  let run: ReturnType<typeof bindMannFft> | undefined;
  return (request: MannFftRequest): void => {
    try {
      if ('module' in request) {
        run = bindMannFft(request.module, request.cells);
        send({ ready: true });
        return;
      }
      if (!run) throw new MargoError('state', 'Initialize the Mann FFT helper before sending a component.');
      const { buffer, inverse } = request;
      const products = run(new Float64Array(buffer), inverse);
      send({ buffer, products }, [buffer]);
    } catch (error) {
      send({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
if (typeof node === 'string') {
  type ParentPort = {
    on(event: 'message', listener: (request: MannFftRequest) => void): void;
    postMessage(reply: MannFftReply, transfer?: ArrayBuffer[]): void;
  };
  const name = 'node:worker_threads';
  void (import(/* @vite-ignore */ /* webpackIgnore: true */ name) as Promise<{ parentPort: ParentPort | null }>).then(
    ({ parentPort }) => {
      if (parentPort)
        parentPort.on(
          'message',
          respond((reply, transfer) => parentPort.postMessage(reply, transfer)),
        );
    },
  );
} else {
  const worker = globalThis as unknown as {
    onmessage: (event: MessageEvent<MannFftRequest>) => void;
    postMessage(reply: MannFftReply, transfer?: ArrayBuffer[]): void;
  };
  const receive = respond((reply, transfer) => worker.postMessage(reply, transfer));
  worker.onmessage = ({ data }) => receive(data);
}
