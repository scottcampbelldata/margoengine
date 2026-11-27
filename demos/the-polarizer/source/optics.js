const radians = Math.PI / 180;

/** Transmission after two ideal linear polarizers, normalized to their aligned output. */
export function transmissionAt(degrees) {
  const projectedField = Math.cos(radians * degrees);
  return projectedField * projectedField;
}
