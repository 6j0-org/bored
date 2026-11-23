# Security policy

Bored's whole point is that the server learns as little as possible about the people using it, so security and
privacy bugs matter more here than most. Thank you for looking.

## Reporting a vulnerability

Please report it privately, not in a public issue or on the in-app Feedback page. Either:

- **GitHub**: [report a vulnerability](https://github.com/6j0-org/bored/security/advisories/new) (private vulnerability
  reporting), or
- **GitLab**: open a [confidential issue](https://gitlab.com/6j0-org/bored/-/issues/new) (tick "This issue is
  confidential" before you submit it, so only the maintainers can see it).

Include what you found, how to reproduce it, and what an attacker could do with it. A proof of concept helps, but
please test only against your own server (`npm start`, or `DEMO=1` for demo mode; see the README), never someone
else's accounts or data.

We'll acknowledge your report within a week, keep you posted while we fix it, and credit you when the fix ships,
unless you'd rather not be named. Please give us a reasonable time to fix it before you publish anything.

## What counts

Anything that breaks the promises in [`docs/encryption.md`](docs/encryption.md) and the
[Privacy Policy](public/privacy.html), for example:

- The server, or anyone watching it, learning what encrypted mail, vaults, private posts, or chats say, or who sent them
- Signing in as someone else, or getting at another account's data
- Forging posts, requests, matches, or chat messages, or getting another browser to accept them
- Cross-site scripting, or anything else that runs someone else's code in the app
- Ways to tie an anonymous account to a real person that aren't already listed as known limits

## Already known

[`TODO.md`](TODO.md) lists the open security and privacy issues we know about, by priority, and the README's
"Known limits" section explains the ones that come with the design (such as the metadata the server can still see,
and the limits of end-to-end encryption in a web app). Reports that improve on those are still welcome.

## Supported versions

Bored is in alpha and has no releases yet. Fixes go to the `main` branch; run the latest `main`.
