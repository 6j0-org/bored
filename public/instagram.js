// Links to an Instagram post, reel, or video (instagram.com/p/…, /reel/…, /reels/…, or /tv/…), with or without
// https://. A post's Details may have them, for an event's flyer or announcement; a link to a profile
// (instagram.com/jane, or instagram.com/jane/p/… with the account's name in it) is still contact info.
// Shared by the PII check (public/pii.js) and linkify (app.js). It's global: reset lastIndex, or use it with
// replace, split, or matchAll.
export const INSTAGRAM_POST = /(?<![\w.\/@-])(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/(?:p|reels?|tv)\/[\w-]+\/?(?![\w\/-])(?:\?[^\s<>"']*)?/gi;
