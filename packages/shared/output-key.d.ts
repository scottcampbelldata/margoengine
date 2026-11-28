/** The output fields a stacked post stage builds its present pipeline from; compared without allocating. */
export class OutputKey {
  format: string;
  samples: number | undefined;
  hdr: boolean;
  straight: boolean;
  extra: unknown;
  /** True when any field differs from the last call (or after `reset`); remembers the new fields. */
  changed(
    output: { format: string; multisample: { count?: number }; hdr?: boolean },
    straight: boolean,
    extra?: unknown,
  ): boolean;
  /** The next `changed` returns true. */
  reset(): void;
}
