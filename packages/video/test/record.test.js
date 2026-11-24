import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCanvas } from '../dist/record.js';

// Minimal containers as MediaRecorder writes them. WebM: EBML header, Segment and Cluster of unknown size, then one
// SimpleBlock of 5 bytes; the header-only file stops after Tracks, as a recording stopped before its first frame does.
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const WEBM_HEAD = [0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN, 0x16, 0x54, 0xae, 0x6b, 0x80];
const WEBM_CLUSTER = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN, 0xa3, 0x85, 0x81, 0, 0, 0x80, 0x9d]);
const WEBM = Uint8Array.from([...WEBM_HEAD, ...WEBM_CLUSTER]);
const box = (type, payload = []) => [0, 0, 0, 8 + payload.length, ...[...type].map((c) => c.charCodeAt(0)), ...payload];
const MP4_HEAD = [...box('ftyp', [0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]), ...box('moov')];
const MP4 = Uint8Array.from([...MP4_HEAD, ...box('mdat', [1, 2, 3, 4])]);
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
      this.data(Recorder.final ?? (this.mimeType.startsWith('video/mp4') ? MP4 : WEBM));
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
    // The header comes first, as MediaRecorder's first dataavailable carries it; the final chunk holds the cluster.
    Recorder.final = WEBM_CLUSTER;
    Recorder.last.data(Uint8Array.from(WEBM_HEAD));
    const result = recording.stop();
    assert.equal(result, recording.result);
    assert.equal(recording.stop(), result);
    const blob = await result;
    assert.equal(blob.type, 'video/webm');
    Recorder.final = undefined;
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), WEBM);
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

test('mp4 asks for H.264, with AAC when there is audio, and leaves the codec to the browser without them', async () => {
  // Chrome's own MP4 choice is VP9, which AVFoundation (QuickTime Player, Quick Look) cannot decode: batch 121 opened a
  // Chrome recording on macOS 27.2 and got "Cannot Decode". Safari's own choice was already H.264.
  const { canvas, restore } = setup();
  const supported = Recorder.isTypeSupported;
  try {
    let offered = () => true;
    Recorder.isTypeSupported = (type) => offered(type);
    const stopped = async (recording) => (await recording.stop()).type;
    assert.equal(await stopped(recordCanvas(canvas, { format: 'mp4' })), 'video/mp4;codecs=avc1');
    const audio = { getAudioTracks: () => [new Track()] };
    assert.equal(await stopped(recordCanvas(canvas, { format: 'mp4', audio })), 'video/mp4;codecs=avc1,mp4a.40.2');
    offered = (type) => !type.includes('mp4a');
    assert.equal(await stopped(recordCanvas(canvas, { format: 'mp4', audio })), 'video/mp4;codecs=avc1');
    offered = (type) => !type.includes('avc1');
    assert.equal(await stopped(recordCanvas(canvas, { format: 'mp4' })), 'video/mp4');
    offered = () => true;
    assert.equal(await stopped(recordCanvas(canvas, { format: 'webm' })), 'video/webm');
  } finally {
    Recorder.isTypeSupported = supported;
    restore();
  }
});

// KB5116: stopped before Chromium encoded its first frame, a recording was 110 bytes of WebM header that no decoder
// opens (DEMUXER_ERROR_COULD_NOT_OPEN), and recordCanvas resolved it because its size was not 0.
test('a recording with no encoded frame rejects, in WebM and in MP4', async () => {
  const { canvas, video, restore } = setup();
  const supported = Recorder.isTypeSupported;
  try {
    for (const [format, head] of [['webm', WEBM_HEAD], ['mp4', MP4_HEAD]]) {
      Recorder.final = Uint8Array.from(head);
      await assert.rejects(
        recordCanvas(canvas, { format }).stop(),
        (e) => e.code === 'state' && /no encoded frame/.test(e.message) && /https:/.test(e.message),
        format,
      );
      assert.equal(video.readyState, 'ended');
    }
    Recorder.final = MP4;
    assert.equal((await recordCanvas(canvas, { format: 'mp4' }).stop()).size, MP4.length);
  } finally {
    Recorder.final = undefined;
    Recorder.isTypeSupported = supported;
    restore();
  }
});
