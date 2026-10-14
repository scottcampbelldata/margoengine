let activeRestore;
export function restoreTimingSetup() {activeRestore?.();}

/** Temporary setup hook for this isolated benchmark page; normal devices are unchanged. */
export async function withGPUTiming(enabled, create) {
  if (activeRestore) throw new Error('GPU timing setup is already in progress');
  const prototype = enabled ? globalThis.GPUAdapter?.prototype : undefined;
  const previous = prototype && Object.getOwnPropertyDescriptor(prototype, 'requestDevice'), original = prototype?.requestDevice;
  let wrapped;
  const restore = () => {
    if (wrapped && prototype.requestDevice === wrapped) {
      if (previous) Object.defineProperty(prototype, 'requestDevice', previous); else delete prototype.requestDevice;
    }
    if (activeRestore === restore) activeRestore = undefined;
  };
  activeRestore = restore;
  try {
    if (typeof original === 'function' && (previous?.configurable !== false || previous.writable)) {
      wrapped = function(...args) {
        if (!this.features.has('timestamp-query')) return original.apply(this, args);
        const features = Array.from(args[0]?.requiredFeatures ?? []);
        if (!features.includes('timestamp-query')) args[0] = {...args[0], requiredFeatures: [...features, 'timestamp-query']};
        return original.apply(this, args);
      };
      Object.defineProperty(prototype, 'requestDevice', {configurable: previous?.configurable ?? true, enumerable: previous?.enumerable ?? false, writable: true, value: wrapped});
    }
    return await create();
  } finally {restore();}
}
