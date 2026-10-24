/** Unit normal (the light's direction), right (`up x normal`) and up (`normal x right`) of a rectangle light. */
export function rectFrame(
  direction: ArrayLike<number>,
  up: ArrayLike<number> | undefined,
  label: string,
): { normal: [number, number, number]; right: [number, number, number]; up: [number, number, number] };
