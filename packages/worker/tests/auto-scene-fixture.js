export async function createScene({ canvas, data, signal, mode, attach }) {
  data.calls.push({ canvas, signal, mode });
  if (data.wait) await data.wait;
  if (data.error) throw data.error;
  if (data.engine) attach(data.engine);
  return {
    dispose() {
      data.disposals++;
    },
  };
}
