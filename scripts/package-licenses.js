// Licence of each published package. Every package ships the root MIT LICENSE except those listed here, which keep
// their own LICENSE file (and LICENSE-COMMERCIAL.md for dual-licensed packages).
export const ownLicenses = new Map([['brep', 'AGPL-3.0-only OR LicenseRef-Commercial']]);

/** @param {string} name package directory name, e.g. `brep` */
export const expectedLicense = (name) => ownLicenses.get(name) ?? (name === 'materials' ? 'MIT AND Apache-2.0' : 'MIT');
