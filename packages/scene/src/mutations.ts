const pending = new WeakMap<object, (() => void)[]>();

export const deferMutation = (engine: object, notify: () => void): boolean => {
  const queue = pending.get(engine);
  if (!queue) return false;
  queue.push(notify);
  return true;
};

export const sceneMutation = <T>(engine: object, action: () => T): T => {
  const existing = pending.get(engine), queue = existing ?? [], start = queue.length;
  if (!existing) pending.set(engine, queue);
  let result: T;
  try { result = action(); }
  catch (error) {
    queue.length = start;
    if (!existing) pending.delete(engine);
    throw error;
  }
  if (!existing) {
    pending.delete(engine);
    for (const notify of queue) notify();
  }
  return result;
};
