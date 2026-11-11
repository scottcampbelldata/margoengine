/** One app-wide load that waiting calls share; cancelled when every waiting call has been aborted. */
export class SharedLoad<T extends object, O> {
  value: T | null;
  constructor(start: (options: O, signal: AbortSignal) => Promise<T>);
  load(options: O, signal?: AbortSignal): Promise<T>;
}
