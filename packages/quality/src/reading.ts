// The light tier's GPU reading: real GPU time per frame, the sum of its render and compute passes by timestamp queries.
// Loaded only by a page still being measured (phones, measured and forced pages never download it), and fully removed
// when the reading ends.
const FEATURE = 'timestamp-query',
  // A frame's encoders rarely hold more than a few dozen passes; a frame that does not fit is not counted, never guessed.
  QUERIES = 256,
  SLOTS = 8,
  MAP_READ = 1,
  COPY_DST = 8,
  COPY_SRC = 4,
  QUERY_RESOLVE = 512;

/** The part of `GPUQueue` the reading uses. */
export interface QueueLike {
  submit(buffers: Iterable<object>): unknown;
}
/** The part of `GPUDevice` the reading uses. */
export interface DeviceLike {
  features: { has(name: string): boolean };
  createCommandEncoder(descriptor?: unknown): any;
  createQuerySet(descriptor: unknown): { destroy(): void };
  createBuffer(descriptor: unknown): any;
}
interface Slot {
  set: { destroy(): void };
  resolve: any;
  read: any;
  used: number;
}
interface Frame {
  sum: number;
  open: number;
  counted: boolean;
  sealed: boolean;
  bad: boolean;
}

/** Skip two seconds of startup (shader compiles, uploads), then read 120 frames, giving up ten seconds in. Reports the
 * 90th percentile in milliseconds, or undefined without timestamps, with too few frames or when every frame reads zero (a
 * browser returning empty timestamps is no evidence of headroom). Passes the page timed itself spoil their frame. Copies
 * between passes, presenting and other work on the machine are not counted. */
export function readGpuTime(
  queue: QueueLike,
  device: Pick<DeviceLike, 'createCommandEncoder'>,
  request: (callback: (time: number) => void) => unknown,
  report: (milliseconds: number | undefined) => void,
): void {
  const submit = queue.submit,
    create = device.createCommandEncoder,
    slots: Slot[] = [],
    free: Slot[] = [],
    sent = new WeakMap<object, Slot>(),
    times: number[] = [],
    next = (): Frame => ({ sum: 0, open: 0, counted: false, sealed: false, bad: false });
  let frame = next(),
    first = -1,
    elapsed = 0,
    done = false;

  const close = () => {
    done = true;
    if (queue.submit === measured) queue.submit = submit;
    if (device.createCommandEncoder === created) device.createCommandEncoder = create;
    times.sort((a, b) => a - b);
    const p90 = times[Math.floor(times.length * 0.9)];
    report(times.length === 120 && times[119] > 0 ? p90 : undefined);
    // On the next frame, not now: an encoder already open may still end its passes against these query sets.
    if (slots.length)
      request(() => {
        for (const slot of slots) {
          slot.set.destroy();
          slot.resolve.destroy();
          slot.read.destroy();
        }
      });
  };
  const settle = (ended: Frame) => {
    if (done || !ended.sealed || ended.open || ended.bad || !ended.counted) return;
    if (times.push(ended.sum) === 120) close();
  };
  const take = (owner: DeviceLike): Slot | undefined => {
    let slot = free.pop();
    if (!slot && slots.length < SLOTS) {
      slot = {
        set: owner.createQuerySet({ type: 'timestamp', count: QUERIES }),
        resolve: owner.createBuffer({ size: QUERIES * 8, usage: QUERY_RESOLVE | COPY_SRC }),
        read: owner.createBuffer({ size: QUERIES * 8, usage: COPY_DST | MAP_READ }),
        used: 0,
      };
      slots.push(slot);
    }
    return slot;
  };

  function created(this: DeviceLike, descriptor?: unknown): any {
    const encoder = create.call(this, descriptor);
    if (elapsed <= 2000) return encoder;
    if (!this.features.has(FEATURE)) {
      // No timestamps on this device (this browser has none, or a restored device): nothing to learn. Stay light.
      times.length = 0;
      close();
      return encoder;
    }
    let slot: Slot | undefined;
    for (const name of ['beginRenderPass', 'beginComputePass']) {
      const begin = encoder[name];
      encoder[name] = (pass?: { timestampWrites?: unknown }) => {
        if (done) return begin.call(encoder, pass);
        slot ??= take(this);
        if (pass?.timestampWrites || !slot || slot.used + 2 > QUERIES) {
          frame.bad = true;
          return begin.call(encoder, pass);
        }
        const at = slot.used;
        slot.used += 2;
        return begin.call(encoder, {
          ...pass,
          timestampWrites: { querySet: slot.set, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 },
        });
      };
    }
    const finish = encoder.finish;
    encoder.finish = (options?: unknown) => {
      if (slot?.used) {
        encoder.resolveQuerySet(slot.set, 0, slot.used, slot.resolve, 0);
        encoder.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, slot.used * 8);
      }
      const buffer = finish.call(encoder, options);
      if (slot?.used) sent.set(buffer, slot);
      else if (slot) free.push(slot);
      return buffer;
    };
    return encoder;
  }
  function measured(this: QueueLike, buffers: Iterable<object>): unknown {
    const result = submit.call(this, buffers);
    if (done) return result;
    for (const buffer of buffers) {
      const slot = sent.get(buffer);
      if (!slot) continue;
      const owner = frame,
        size = slot.used * 8;
      owner.open++;
      slot.read.mapAsync(MAP_READ, 0, size).then(
        () => {
          const stamps = new BigInt64Array(slot.read.getMappedRange(0, size));
          let nanoseconds = 0;
          // Timestamps may go backwards across a GPU clock change; such a pass counts as nothing rather than negative.
          for (let i = 0; i < slot.used; i += 2)
            if (stamps[i + 1] > stamps[i]) nanoseconds += Number(stamps[i + 1] - stamps[i]);
          slot.read.unmap();
          slot.used = 0;
          free.push(slot);
          owner.sum += nanoseconds / 1e6;
          owner.counted = true;
          owner.open--;
          settle(owner);
        },
        () => {
          // Refused only when the reading has closed and destroyed the buffer, or the device is lost: this frame is out.
          owner.bad = true;
        },
      );
    }
    return result;
  }
  queue.submit = measured;
  device.createCommandEncoder = created;
  const tick = (time: number) => {
    if (done) return;
    if (first < 0) first = time;
    if ((elapsed = time - first) > 10000) return close();
    const ended = frame;
    frame = next();
    ended.sealed = true;
    settle(ended);
    if (!done) request(tick);
  };
  request(tick);
}
