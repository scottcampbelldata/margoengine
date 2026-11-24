/** `value` when it is a finite number of 0 or more; otherwise `fail("<what> must be 0 or more.")`, which throws. */
export function filmTime(value: unknown, fail: (message: string) => never, what: string): number;
