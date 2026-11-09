// Public WebCodecs stand-in for ownership/sample-table unit tests.
export function mocks(run) {
  const before = { VideoDecoder: globalThis.VideoDecoder, EncodedVideoChunk: globalThis.EncodedVideoChunk };
  const outputs = [],
    decoders = [];
  globalThis.EncodedVideoChunk = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  globalThis.VideoDecoder = class {
    static supported = true;
    static hold = false;
    static isConfigSupported = async (config) => ({ config, supported: this.supported });
    state = 'unconfigured';
    chunks = [];
    constructor(init) {
      this.init = init;
      decoders.push(this);
    }
    configure(c) {
      this.config = c;
      this.state = 'configured';
    }
    decode(c) {
      this.chunks.push(c);
    }
    flush() {
      if (this.constructor.hold)
        return new Promise((resolve, reject) => {
          this.reject = reject;
        });
      for (const c of [...this.chunks].sort((a, b) => a.timestamp - b.timestamp)) {
        const f = {
          timestamp: c.timestamp,
          id: c.data[0],
          closed: false,
          close() {
            this.closed = true;
          },
        };
        outputs.push(f);
        this.init.output(f);
      }
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      this.reject?.(new Error('closed'));
    }
  };
  return Promise.resolve()
    .then(() => run({ outputs, decoders }))
    .finally(() => Object.assign(globalThis, before));
}
