# Contributing to Bored

Thanks for helping! Bored is a small project in alpha, so ideas, bug reports, and code are all welcome.

By taking part, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security or privacy hole?
Please don't open a public issue: see [SECURITY.md](SECURITY.md).

## Where

The code is mirrored on [Codeberg](https://codeberg.org/6j0-org/bored), [GitLab](https://gitlab.com/6j0-org/bored),
[GitHub](https://github.com/6j0-org/bored), and
[Radicle](https://app.radicle.xyz/nodes/iris.radicle.network/rad:z2j6Pog3cY6azMjstGj1utmB81kTZ). Open issues and
pull or merge requests on whichever one you use; they all reach the same people.

- **Bugs**: say what you did, what you expected, and what happened instead, with your browser and device. Screenshots
  help, but check them for anything personal first.
- **Ideas**: describe the problem before the solution, so we can talk about other ways to solve it. If you use Bored,
  the in-app Feedback page works too.
- **Bigger changes** (new features, anything touching encryption or the server's API): open an issue first, so nobody
  spends a weekend on something that won't fit.

## Getting started

You need Node 24 or later and, for the browser tests, Chrome or Chromium.

```sh
npm ci                  # install the exact versions in package-lock.json
DEMO=1 npm run dev      # http://localhost:3000, with demo accounts and posts, restarting on changes
npm test                # unit, server, and browser tests
```

The README explains how everything fits together: [Run](README.md#run), [Tests](README.md#tests),
[Demo mode](README.md#demo-mode), [How it works](README.md#how-it-works), and the list of [Files](README.md#files).
There's no build step: the browser loads the files in `public/` as they are.

## Making a change

- **Keep it small and focused.** One change per pull request is easiest to review.
- **Add or update tests** in `test/` for what you change, and make sure `npm test` passes. CI runs it on every push
  and pull or merge request.
- **No new dependencies without asking.** The app is vanilla JavaScript on Node's standard library, and loads nothing
  from outside its own server (except OpenStreetMap tiles in the location picker). Browser packages are vendored and
  served by the server (see `VENDOR` in `server.js`).
- **Privacy first.** The server must not learn names, who knows whom, or what people say to each other. If a change
  affects what the server can see or store, update [`docs/encryption.md`](docs/encryption.md), the
  [Privacy Policy](public/privacy.html), and [`TODO.md`](TODO.md) to match.
- **Database changes** go in a new migration at the end of `MIGRATIONS` in `db.js`. Never edit or reorder old ones.
- **Look and feel**: follow [`docs/styling.md`](docs/styling.md) (brown controls: filled for changes, outlined for
  navigation), use the CSS variables rather than raw colors, and check light mode, dark mode, and a phone-sized
  screen.
- **Accessibility**: real buttons and labels, keyboard access, and visible focus. Swiping always has a button and a
  keyboard alternative.

## Style

- **Code**: match what's around it. Two-space indents, ES modules, single quotes, and semicolons. Comments explain
  why, not what.
- **Words** (UI text, docs, and comments): plain and friendly. Use the serial (Oxford) comma ("a, b, and c"), and no
  emoji. Say "tap" only for steps that happen on a phone; elsewhere use `tap`/`Tap` from `public/pointer.js`, which
  says "tap", "click", or "tap or click" to match the device.
- **Commits**: a short summary in the [Conventional Commits](https://www.conventionalcommits.org/) style, like
  `feat: delete chat messages` or `fix: keep the Ask to join dialog on screen on phones`, with a body explaining why
  if it isn't obvious.

## License

Bored is under the [GNU AGPL v3 or later](LICENSE). By contributing, you agree that your contributions are licensed
under the same terms. Bundled third-party files keep their own licenses (see the README's [License](README.md#license)
section).
