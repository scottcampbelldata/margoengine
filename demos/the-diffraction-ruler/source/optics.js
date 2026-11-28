import { gratingAngle, gratingOrders } from '@margoengine/optics/diffraction';
import { spectralColor } from '@margoengine/optics/spectrum';

export const radians = Math.PI / 180;
/** The ruler's printed scale reaches 70 degrees either side of the normal. */
export const rulerLimit = 70 * radians;

export const orderAngle = (order, wavelengthNm, groovesPerMm) => gratingAngle(order, wavelengthNm, groovesPerMm);
export const displayedOrders = (wavelength, density) => gratingOrders(wavelength, density, 0, rulerLimit);
export { spectralColor };
