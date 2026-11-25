export const STANDISH_ORBITS: Readonly<
  Record<
    'mercury' | 'venus' | 'earth' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune',
    { readonly at: readonly number[]; readonly rate: readonly number[] }
  >
>;
