import { buildFull } from './full-landscape.js';

const controller = new AbortController();
let full, pending, busy = false, first = true;
const notify = message => postMessage(message);
const phase = name => notify({type:'phase',name});
function report(error) {
  if (!controller.signal.aborted) notify({type:'error',message:error?.message ?? String(error),code:error?.code});
}

async function draw() {
  if (busy || !full || !pending || controller.signal.aborted) return;
  const frame = pending;
  busy = true;
  pending = undefined;
  try {
    await full.render(frame,first);
    if (first) phase('rendered');
    first = false;
    notify({type:'frame',frame});
  } catch (error) {
    report(error);
  } finally {
    busy = false;
    if (pending) draw();
  }
}

addEventListener('message', async ({data}) => {
  if (data.type === 'attach') {
    phase('worker');
    try {
      full = await buildFull(data.canvas,data.renderer,controller.signal,phase);
      full.engine.onError = report;
      draw();
    } catch (error) {
      report(error);
    }
  } else if (data.type === 'frame') {
    pending = data.frame;
    draw();
  } else if (data.type === 'dispose') {
    controller.abort();
    full?.dispose();
    close();
  }
});