import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCanvas } from '../dist/record.js';

class Track {
  readyState = 'live';
  clone() {
    this.copy = new Track();
    return this.copy;
  }
  stop() {
    this.readyState = 'ended';
  }
}
class Recorder extends EventTarget {
  static supported = true;
  static isTypeSupported() {
    return this.supported;
  }
  state = 'inactive';
  constructor(stream, options) {
    super();
    this.stream = stream;
    this.mimeType = options.mimeType;
    Recorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    assert.notEqual(this.state, 'inactive');
    this.state = 'inactive';
    queueMicrotask(() => {
      this.data('final');
      this.dispatchEvent(new Event('stop'));
    });
  }
  data(value) {
    const e = new Event('dataavailable');
    e.data = new Blob([value]);
    this.dispatchEvent(e);
  }
}
function setup() {
  const previous = globalThis.MediaRecorder;
  globalThis.MediaRecorder = Recorder;
  Recorder.supported = true;
  const video = new Track(),
    tracks = [video];
  const stream = { getTracks: () => tracks, addTrack: (track) => tracks.push(track) };
  return {
    video,
    canvas: {
      captureStream: (fps) => {
        assert.equal(fps, 30);
        return stream;
      },
    },
    restore: () => {
      globalThis.MediaRecorder = previous;
    },
  };
}
test('records all chunks including the final one, clones audio and releases only owned tracks', async () => {
  const { canvas, video, restore } = setup();
  try {
    const audio = new Track(),
      recording = recordCanvas(canvas, { audio: { getAudioTracks: () => [audio] } });
    Recorder.last.data('first');
    const result = recording.stop();
    assert.equal(result, recording.result);
    assert.equal(recording.stop(), result);
    const blob = await result;
    assert.equal(blob.type, 'video/webm');
    assert.equal(await blob.text(), 'firstfinal');
    assert.equal(video.readyState, 'ended');
    assert.equal(audio.readyState, 'live');
    assert.equal(audio.copy.readyState, 'ended');
    recording.dispose();
    assert.equal(await recording.stop(), blob);
  } finally {
    restore();
  }
});
test('abort, disposal and recorder errors reject and release capture even before a caller awaits', async () => {
  for (const reason of ['abort', 'dispose', 'error']) {
    const { canvas, video, restore } = setup();
    try {
      const controller = new AbortController(),
        r = recordCanvas(canvas, { signal: controller.signal });
      if (reason === 'abort') controller.abort(new Error('cancelled'));
      if (reason === 'dispose') r[Symbol.dispose]();
      if (reason === 'error') Recorder.last.dispatchEvent(new Event('error'));
      await assert.rejects(r.result, (e) =>
        reason === 'abort' ? e.message === 'cancelled' : e.code === (reason === 'dispose' ? 'disposed' : 'state'),
      );
      assert.equal(video.readyState, 'ended');
      r.dispose();
    } finally {
      restore();
    }
  }
});
test('rejects unsupported containers, invalid options and ended audio before leaking tracks', () => {
  const { canvas, video, restore } = setup();
  try {
    for (const options of [{ format: 'gif' }, { fps: NaN }, { fps: 0 }, { videoBitsPerSecond: 0 }])
      assert.throws(() => recordCanvas(canvas, options));
    Recorder.supported = false;
    assert.throws(
      () => recordCanvas(canvas, { format: 'mp4' }),
      (e) => e.code === 'unsupported' && /https:/.test(e.message),
    );
    Recorder.supported = true;
    const audio = new Track();
    audio.stop();
    assert.throws(
      () => recordCanvas(canvas, { audio: { getAudioTracks: () => [audio] } }),
      (e) => e.code === 'state',
    );
    assert.equal(video.readyState, 'ended');
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => recordCanvas(canvas, { signal: controller.signal }), { name: 'AbortError' });
  } finally {
    restore();
  }
});

test('empty automatic stop and startup failure reject with help links and release tracks', async () => {
  const { canvas, video, restore } = setup();
  const start = Recorder.prototype.start;
  try {
    const recording = recordCanvas(canvas);
    Recorder.last.state = 'inactive';
    Recorder.last.dispatchEvent(new Event('stop'));
    await assert.rejects(recording.result, (e) => e.code === 'state' && /https:/.test(e.message));
    assert.equal(video.readyState, 'ended');
    Recorder.prototype.start = () => {
      throw new DOMException('cannot encode', 'NotSupportedError');
    };
    assert.throws(
      () => recordCanvas(canvas),
      (e) => e.code === 'state' && /cannot encode/.test(e.message),
    );
    assert.equal(video.readyState, 'ended');
  } finally {
    Recorder.prototype.start = start;
    restore();
  }
});
