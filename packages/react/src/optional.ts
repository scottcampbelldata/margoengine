/** Preserve native diagnostics, adding the peer name when a browser import error omits it. */
export async function optionalPeer<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes(name)) throw cause;
    const error = new Error(
      `@margoengine/react: could not load optional peer ${name}. Install ${name} to use this component.`,
      { cause },
    );
    if (cause && typeof cause === 'object' && 'code' in cause) Object.assign(error, { code: cause.code });
    throw error;
  }
}
