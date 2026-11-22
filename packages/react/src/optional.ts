import { fault } from '../../shared/errors.js';

/** Preserve native diagnostics, adding the peer name when a browser import error omits it. */
export async function optionalPeer<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes(name)) throw cause;
    throw Object.assign(
      fault(
        'failed',
        `@margoengine/react could not load optional peer ${name}; install ${name} to use this component`,
        'react-usage',
      ),
      { cause },
    );
  }
}
