export class Cleanup {
  constructor(...errors) { this.failed = errors.length > 0; this.error = errors[0]; }
  run(action) { try { action(); } catch (error) { if (!this.failed) this.error = error; this.failed = true; } return this; }
  finish() { if (this.failed) throw this.error; }
}
