/** lowbias32 (C. Wellons, "Prospecting for Hash Functions", 2018): a well-mixed 32-bit integer hash. Internal to vfx. */
export const lowbias32 = (value: number): number => {
  let n = value >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
};
