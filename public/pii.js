// Personal info in posts, found with @devopscoop/eat-the-pii. Shared by the server, which refuses a post or note with
// contact info or ID numbers in it, and the post form, which says so while you type and also warns about street
// addresses. In the browser, the import map in index.html points the package names at /vendor/ files.
import { checkPii } from '@devopscoop/eat-the-pii';

const WHAT = {
  email: 'an email address', link: 'a link to a profile', handle: 'a social media handle', phone: 'a phone number',
  card: 'a card number', iban: 'a bank account number', ssn: 'a Social Security number', address: 'a street address',
};
const CONTACT = new Set(['email', 'link', 'handle', 'phone']);
// Phone numbers without a country code are read as US numbers; ones with a code (+81 …) are found anywhere.
const DEFAULT_COUNTRY = 'US';

// What's wrong with one field's text: `error` when the server will refuse it, `warning` for a street address.
// `addresses: false` skips the warning, for the place name, where a venue's address is fine.
export function piiProblems(field, text, { addresses = true } = {}) {
  const { findings } = checkPii(text, { defaultCountry: DEFAULT_COUNTRY, severity: addresses ? {} : { address: 'off' } });
  const block = findings.find(f => f.severity === 'block'), warn = findings.find(f => f.severity === 'warn');
  const says = (f) => `${field}: that looks like ${WHAT[f.type]} (“${f.match}”).`;
  return {
    error: block ? `${says(block)} ${CONTACT.has(block.type) ? 'Share contact info in chat after you match.' : 'Please keep that private.'}` : null,
    warning: warn ? `${says(warn)} Everyone who can see the post will see it, so a public place nearby is safer.` : null,
  };
}
