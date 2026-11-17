// Seed demo accounts and posts so Discover has something in it (see demo.js).
// Demo accounts have no passkeys, so nobody can sign in as them; create your own accounts to try matching and chat.
// Demo posts are public, so they show up for everyone in Discover.
// For a throwaway demo with no sign-in at all, run the server with DEMO=1 instead.
// Usage: node seed.js
import { seedDemo } from './demo.js';

const { users, events } = seedDemo();
console.log(`Seeded ${users} demo accounts (no passkeys; they can't sign in) and ${events} posts.`);
