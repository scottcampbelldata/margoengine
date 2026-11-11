// queue.copyExternalImageToTexture that also takes a video or VideoFrame in a browser that refuses one as the source.
// Firefox 157 throws a TypeError from WebIDL conversion (not a validation error) for an HTMLVideoElement or VideoFrame;
// such a queue gets the frame through a canvas it is drawn on instead: the same pixels, one extra draw per upload. The
// queue is remembered, so the fallback is chosen once. Used by materials, points and xr.

/** Queues whose browser refused a video as a copyExternalImageToTexture source. */
const noVideoCopies = new WeakSet();
/** One canvas per video source, remade when the frame size changes. */
const frameCanvases = new WeakMap();

/** Whether `source` is a video element or a VideoFrame. */
export function isVideoSource(source) {
  return !!source && typeof source === 'object' && ('videoWidth' in source || 'displayWidth' in source);
}

const dimensions = (s) => [
  s.videoWidth ?? s.displayWidth ?? s.naturalWidth ?? s.width ?? 0,
  s.videoHeight ?? s.displayHeight ?? s.naturalHeight ?? s.height ?? 0,
];

/**
 * `device.queue.copyExternalImageToTexture(info, destination, size)`; a video or VideoFrame the queue's browser refuses
 * (a TypeError) is drawn on a canvas and that canvas copied, with the same origin, flip and size. Any other error, and
 * any TypeError for a source that is not a video, is thrown as is.
 */
export function copyExternal(device, info, destination, size) {
  const queue = device.queue,
    source = info.source,
    video = isVideoSource(source);
  if (video && !noVideoCopies.has(queue))
    try {
      return queue.copyExternalImageToTexture(info, destination, size);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      noVideoCopies.add(queue);
    }
  if (!video) return queue.copyExternalImageToTexture(info, destination, size);
  const [w, h] = dimensions(source);
  let frame = frameCanvases.get(source);
  if (!frame || frame.w !== w || frame.h !== h) {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    frameCanvases.set(source, (frame = { canvas, w, h }));
  }
  frame.canvas.getContext('2d').drawImage(source, 0, 0);
  queue.copyExternalImageToTexture({ ...info, source: frame.canvas }, destination, size);
}
