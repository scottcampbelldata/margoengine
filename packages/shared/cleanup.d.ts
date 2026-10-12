export class Cleanup {
  constructor(...errors: unknown[]);
  failed: boolean;
  error: unknown;
  run(action: () => void): this;
  finish(): void;
}
