// HTML's port-message task source yields to the browser without inheriting the timer nesting level. In a serial
// map/unmap loop a timer's promise continuations inherit that level, imposing a 4 ms floor on every later poll.
// A small delayed task also leaves the event loop idle so WebGL sync status can advance, rather than continuously
// posting ready port tasks (WebGL 2.0 sync objects only transition outside an executing task).
let channel: MessageChannel | undefined;
const pending: (() => void)[] = [];
type NodePort = MessagePort & { ref?(): void; unref?(): void };

/** Yields one browser task, so GL fences and queries can become observable, without a clamped timer. */
export function nextGPUTask(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { postTask(callback: () => void, options: { delay: number }): Promise<void> };
    }
  ).scheduler;
  if (scheduler?.postTask) return scheduler.postTask(() => {}, { delay: 1 });
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const resolve = pending.shift();
      if (resolve) setTimeout(resolve, 1);
      if (!pending.length) (channel!.port1 as NodePort).unref?.();
    };
    (channel.port2 as NodePort).unref?.();
  }
  (channel.port1 as NodePort).ref?.();
  return new Promise((resolve) => {
    pending.push(resolve);
    channel!.port2.postMessage(null);
  });
}
