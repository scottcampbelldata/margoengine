// Decoders of web-ifc 0.0.78 line values: {type:1,value:string}, {type:3,value:enum|boolean}, {type:4,_representationValue},
// {type:5,value:expressID}, {type:10,value:number[]}, arrays, null.

/** A decoded IFC value: text, number, boolean (null for LOGICAL UNKNOWN), or a list of them. */
export type RawValue = string | number | boolean | null | RawValue[];
// biome-ignore lint/suspicious/noExplicitAny: web-ifc lines are untyped JSON
export type Raw = any;
export const refOf = (v: Raw): number | undefined =>
  v && v.type === 5 && typeof v.value === 'number' ? v.value : undefined;
export const refsOf = (v: Raw): number[] =>
  Array.isArray(v)
    ? v.map(refOf).filter((x): x is number => x !== undefined)
    : refOf(v) !== undefined
      ? [refOf(v)!]
      : [];
export const text = (v: Raw): string | undefined =>
  v && typeof v.value === 'string' && v.type !== 5 ? v.value : undefined;
export const decode = (v: Raw): RawValue | undefined => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(decode).filter((x): x is RawValue => x !== undefined);
  if (typeof v !== 'object') return v;
  if (v.type === 5) return undefined;
  if ('_representationValue' in v) return v._representationValue;
  if (v.type === 3 && (v.name === 'IFCBOOLEAN' || v.name === 'IFCLOGICAL'))
    return v.value === true || v.value === 'T' ? true : v.value === false || v.value === 'F' ? false : null;
  if (Array.isArray(v.value)) return v.value;
  return v.value ?? null;
};
