// The text of layout.json, so tests/orrery-gears.test.js can check the committed file is current.
import { orreryLayout } from '../layout.ts';

/** Six significant digits are far below a tenth of a millimetre at this size and keep the file readable. */
const round = (_key, value) =>
  typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(7)) : value;
export const layoutJSON = () => JSON.stringify(orreryLayout(), round, 1) + '\n';
