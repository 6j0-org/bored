// pii.js: what a post's fields may not have in them. Details may link to an Instagram post or reel, but not to a
// profile, and the rest of the details are still checked.
import assert from 'node:assert/strict';
import { piiProblems } from '../../public/pii.js';

const details = (text) => piiProblems('Details', text, { instagramPosts: true });

for (const ok of ['Flyer: https://www.instagram.com/p/C9xYz_1-AB/', 'instagram.com/reel/AbC123?igsh=xyz', 'See (instagram.com/tv/X1).',
  'http://instagr.am/p/abc/ and https://m.instagram.com/reels/Def_9', 'Two: instagram.com/p/A, instagram.com/p/B.'])
  assert.equal(details(ok).error, null, ok);

for (const [text, what] of [['instagram.com/jane', 'instagram.com/jane'], ['https://instagram.com/jane/p/ABC', 'instagram.com/jane/p/ABC'],
  ['instagram.com/p/X/jane', 'instagram.com/p/X/jane'], ['https://tiktok.com/@jane', 'tiktok.com/@jane']]) {
  const { error } = details(text);
  assert.match(error, /looks like a link to a profile/, text);
  assert.ok(error.includes(what), `${text}: ${error}`);
  assert.match(error, /A link to an Instagram post or reel is fine\.$/, text);
}

// The rest of the text is still checked.
assert.match(details('instagram.com/p/ABC or text me at 619-555-0123').error, /phone number/);
assert.match(details('https://instagram.com/p/ABC, DM @jane_doe').error, /social media handle/);
assert.doesNotMatch(details('call 619-555-0123').error, /Instagram/, 'the hint is only for links');

// Only the details: elsewhere, an Instagram post link is still refused.
assert.match(piiProblems('Title', 'instagram.com/p/ABC').error, /link to a profile/);
assert.doesNotMatch(piiProblems('Title', 'instagram.com/jane').error, /Instagram post/);
