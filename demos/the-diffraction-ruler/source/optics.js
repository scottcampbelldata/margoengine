export const radians = Math.PI / 180;
export const rulerLimit = 70 * radians;

export function orderAngle(order, wavelengthNm, groovesPerMm) {
  const sine = order * wavelengthNm * groovesPerMm / 1e6;
  return Math.abs(sine) <= 1 ? Math.asin(sine) : null;
}

export function displayedOrders(wavelength, density) {
  const limit = Math.floor(1e6 / (wavelength * density));
  const orders = [];
  for (let order = -limit; order <= limit; order++) {
    const angle = orderAngle(order, wavelength, density);
    if (angle !== null && Math.abs(angle) <= rulerLimit) orders.push({ order, angle });
  }
  return orders;
}

function bell(w, center, lower, upper) {
  const x = w - center;
  return Math.exp(-.5 * (x * (x < 0 ? lower : upper)) ** 2);
}

export function spectralColor(w) {
  const x = .362*bell(w,442,.0624,.0374)+1.056*bell(w,599.8,.0264,.0323)-.065*bell(w,501.1,.049,.0382);
  const y = .821*bell(w,568.8,.0213,.0247)+.286*bell(w,530.9,.0613,.0322);
  const z = 1.217*bell(w,437,.0845,.0278)+.681*bell(w,459,.0385,.0725);
  const channels = [
    3.2406*x - 1.5372*y - .4986*z,
    -.9689*x + 1.8758*y + .0415*z,
    .0557*x - .2040*y + 1.057*z,
  ];
  const peak = Math.max(...channels);
  return channels.map((value) => Math.max(0,value)/peak);
}
