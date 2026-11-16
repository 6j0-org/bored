// On a first visit, "/" shows this introduction instead of the app. Links with a fragment (invitations
// "#invite=…", sign-in tokens from a 6j0.org identity server "#id_token=…") are meant for the app, and the server
// never sees fragments, so send them through "/?start" (which skips the introduction from now on) to the app.
// Runs in <head>, before the page draws, so nobody sees the introduction flash first.
if (location.hash.length > 1 && location.pathname === '/') {
  const q = new URLSearchParams(location.search);
  q.set('start', '');
  location.replace('/?' + q + location.hash);
}
