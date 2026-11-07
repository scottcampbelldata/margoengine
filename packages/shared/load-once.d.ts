export class LoadOnce<T extends object> {
  value: T | null;
  constructor(load: () => Promise<T>);
  load(signal?: AbortSignal): Promise<T>;
}
