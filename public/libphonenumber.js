// libphonenumber-js in the browser, for @devopscoop/eat-the-pii: its one-file minified bundle
// (/vendor/libphonenumber-min.js, which sets globalThis.libphonenumber) instead of the 74 files of its module build.
// The import map in index.html points "libphonenumber-js/min" here.
import '/vendor/libphonenumber-min.js';

export const { findPhoneNumbersInText } = globalThis.libphonenumber;
