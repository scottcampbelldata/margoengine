// HTML's port-message task source yields to the browser without inheriting the timer nesting level. In a serial
// map/unmap loop a timer's promise continuations inherit that level, imposing a 4 ms floor on every later poll (HTML,
// timer initialisation steps). So each poll posts a port message and, from that task (nesting level 0), sets a 1 ms
// timer: a small delayed task leaves the event loop idle so WebGL sync status can advance, rather than continuously
// posting ready port tasks (WebGL 2.0 sync objects only transition outside an executing task).
// Never scheduler.postTask({ delay }): Chrome on Windows runs its delayed tasks on the system timer tick, 15.6 ms, so a
// poll measured 15.1 ms for delay 1 where the port hop and setTimeout(1) took 2.0 ms (Chrome 157, 2026-11-18), and
// every onSubmittedWorkDone and mapAsync of the layer waited about 13 ms more than it had to (KB-COMPAT-POSTTASK1).
let channel: MessageChannel | undefined;
const pending: (() => void)[] = [];
type NodePort = MessagePort & { ref?(): void; unref?(): void };

/** Yields one browser task and about 1 ms, so GL fences and queries can become observable, without a clamped timer. */
export function nextGPUTask(): Promise<void> {
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

/**
 * Whether the GPU has passed `sync`, a fence: clientWaitSync with SYNC_FLUSH_COMMANDS_BIT and no timeout (WebGL allows
 * none). GetSyncParameter(SYNC_STATUS) cannot ask for the flush, and Firefox warns once a fence has been polled 100
 * times without the bit ("If you do not flush, this sync object is not guaranteed to ever complete").
 */
export function fenceDone(gl: WebGL2RenderingContext, sync: WebGLSync): boolean {
  return gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0) !== gl.TIMEOUT_EXPIRED;
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
