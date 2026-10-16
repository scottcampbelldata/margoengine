// Read the typed array's internal backing store, never an overridable `buffer`
// property. Shared inputs may change while their last upload is being cached.
const bufferGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float32Array.prototype), 'buffer')!.get!,
  apply = Reflect.apply,
  noArguments: [] = [];

export function ordinaryWeightBuffer(values: Float32Array): boolean {
  return apply(bufferGetter, values, noArguments) instanceof ArrayBuffer;
}
