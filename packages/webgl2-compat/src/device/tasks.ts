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

const probes = new WeakMap<WebGL2RenderingContext, readonly [WebGLBuffer, WebGLBuffer]>();

/**
 * Places a fence after every command so far and sends it on its way. Chrome on ANGLE's Direct3D 11 back end reports a
 * fence signaled only once a later command has reached the driver: with only gl.flush() after it, a fence on a context
 * that shows no frame (work drawn into textures, a fence with no work before it) stayed unsignaled for about 270 ms, 17
 * polls (Chrome 157, RTX A6000, raw WebGL2 with no layer as well), where a frame shown on a page canvas flushes it at
 * once. A 4-byte copy between two buffers of the context's own, after the fence, makes it signal on the next poll, as
 * a pixel-buffer readPixels does. Null when the context is lost.
 */
export function fence(gl: WebGL2RenderingContext): WebGLSync | null {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return null;
  let probe = probes.get(gl);
  if (!probe) {
    const made = [gl.createBuffer(), gl.createBuffer()] as const;
    if (!made[0] || !made[1]) {
      gl.flush();
      return sync;
    }
    for (const b of made) {
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, b);
      gl.bufferData(gl.COPY_WRITE_BUFFER, 4, gl.STATIC_DRAW);
    }
    probes.set(gl, (probe = made as readonly [WebGLBuffer, WebGLBuffer]));
  }
  gl.bindBuffer(gl.COPY_READ_BUFFER, probe[0]);
  gl.bindBuffer(gl.COPY_WRITE_BUFFER, probe[1]);
  gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, 4);
  gl.flush();
  return sync;
}
