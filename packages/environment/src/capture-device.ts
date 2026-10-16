const shaderModule =
  (
    device: GPUDevice,
    source: GPUDevice['createShaderModule'],
    transform: (code: string) => string,
  ): GPUDevice['createShaderModule'] =>
  (descriptor) =>
    source.call(device, { ...descriptor, code: transform(descriptor.code) });

/** Internal capture adapter. Bind native methods once per current method identity. */
export function captureDevice(device: GPUDevice, transform: (code: string) => string): GPUDevice {
  const methods = new Map<PropertyKey, { source: unknown; bound: unknown }>();
  return new Proxy(device, {
    get(target, property) {
      const source = Reflect.get(target, property);
      if (typeof source !== 'function') return source;
      const previous = methods.get(property);
      if (previous && previous.source === source) return previous.bound;
      const bound = property === 'createShaderModule' ? shaderModule(target, source, transform) : source.bind(target);
      methods.set(property, { source, bound });
      return bound;
    },
  });
}
