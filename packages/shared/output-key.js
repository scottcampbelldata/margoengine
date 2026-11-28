// What a stacked post stage builds its present pipeline from: the output's format, sample count and HDR flag, whether
// the canvas is premultiplied (straight-colour display, KB-POST-ALPHARIM1) and, for some stages, one more value.
// `changed` compares them field by field and allocates nothing. A key string joined from them every frame cost about 28 B
// a stage: the frame-alloc post scene (SSAO, Bloom) rose from 1,528 B to 1,584 B a frame when the premultiplied flag
// joined the string (KB-GPUMAIN1).
// `changed` only compares and holds the new fields; `done` keeps them once the stage has built from them. A stage whose
// build throws (a warm-up frame stopped at its pipeline, @margoengine/quality/warm) sees the change again on its next
// frame: a key that remembered the fields in `changed` left Bloom with no present pipeline and the warm-up rebooted the
// device (KB-WATER-WARMUP1).
export class OutputKey {
  format = '';
  samples = -1;
  hdr = false;
  straight = false;
  extra = undefined;
  #format = '';
  #samples = -1;
  #hdr = false;
  #straight = false;
  #extra = undefined;
  /** True when any field differs from the last `done` (or after `reset`); holds the new fields for `done`. */
  changed(output, straight, extra) {
    if (
      this.format === output.format &&
      this.samples === output.multisample.count &&
      this.hdr === !!output.hdr &&
      this.straight === straight &&
      this.extra === extra
    )
      return false;
    this.#format = output.format;
    this.#samples = output.multisample.count;
    this.#hdr = !!output.hdr;
    this.#straight = straight;
    this.#extra = extra;
    return true;
  }
  /** Keeps the fields the last `changed` saw: call it once the stage has built what they describe. */
  done() {
    this.format = this.#format;
    this.samples = this.#samples;
    this.hdr = this.#hdr;
    this.straight = this.#straight;
    this.extra = this.#extra;
  }
  /** The next `changed` returns true (a rebuilt device or a disposed stage). */
  reset() {
    this.format = '';
  }
}
