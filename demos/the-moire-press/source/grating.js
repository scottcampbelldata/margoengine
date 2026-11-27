export const pitch = .0105;
export const radians = Math.PI / 180;

export function bandSpacing(degrees) {
  return degrees === 0 ? Infinity : pitch / (2 * Math.sin(radians * Math.abs(degrees) / 2));
}
