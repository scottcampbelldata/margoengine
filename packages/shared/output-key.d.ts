/** The output fields a stacked post stage builds its present pipeline from; compared without allocating. */
export class OutputKey {
  format: string;
  samples: number | undefined;
  hdr: boolean;
  straight: boolean;
  extra: unknown;
  /** True when any field differs from the last `done` (or after `reset`); holds the new fields for `done`. */
  changed(
    output: { format: string; multisample: { count?: number }; hdr?: boolean },
    straight: boolean,
    extra?: unknown,
  ): boolean;
  /** Keeps the fields the last `changed` saw: call it once the stage has built what they describe. */
  done(): void;
  /** The next `changed` returns true. */
  reset(): void;
}
