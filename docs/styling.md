# Styling

How Bored looks, and why. All of it is in `public/style.css`. Its colors are CSS variables on `:root`, redefined for
dark mode, so use the variables rather than raw colors. The About and Privacy pages copy the few styles they need
inline; keep them matching the app (the About page's example cards, buttons, and "Alpha" note look the same).

The theme is the title board: wood browns for everything you tap, with fir green only for text.

## The rule for controls

Every control is brown, and its shape and fill say what it does, so people can tell what will happen before they tap
it:

| Looks like | Means | Class | Examples |
| --- | --- | --- | --- |
| **Brown filled rectangle** | Creates, updates, or deletes something | `.btn` | Post it, Save, Send, Delete, Remove, Mark as done, Can't make it, Leave, Block, Sign out, and the deck's Pass and I'm in |
| **Brown outlined rectangle** | Changes nothing: cancels, goes somewhere, opens a form, or shares | `.btn.ghost` | Cancel, Edit, Share, Keep swiping, Send a message, Find something to do |
| **Rounded brown outline**, **filled brown** when selected | A choice, a filter, a tag, or a contact to pick | `.seg-pick`, `.chip.filter`, `.chip.suggest` | Where (In person, Online, Both), Who can see it, Theme, Discover's filters, tags, and the people a post is shared with |
| **Brown filled tab** | Goes to a screen | `nav.tabs button` | The tab bar |

Choices where exactly one option is picked (Where, Who can see it, and Theme) are one joined, rounded bar
(`.seg-pick`), outlined in brown with brown dividers, and the picked one filled with wood. Choices where any number
can be picked (filters, tags, and people) are separate rounded chips, filled with wood when picked; tags you've added
to a post sit in the tag box already filled. The rotating post ideas above the Post form (`.idea`) are a brown
outlined box: picking one only fills in the form.

No control uses green. Green is for emphasis (`em`), links (`a`, `button.link`), and status: "It's on" labels, yes
stamps, and your own chat messages. Links are always underlined, so they're never mistaken for emphasis, which isn't.

To pick a button's kind, ask whether tapping it changes anything saved or sent. "Edit" only opens a form, so it's
outlined; the form's "Save" is filled. "Send a message" only opens the chat, so it's outlined; the chat's "Send" is
filled.

Destructive buttons (Delete, Remove, Block, and Sign out) are brown filled like any other change, not red. They ask
to confirm first instead.

Add `.small` for a compact version of either button (`.btn.small`, `.btn.ghost.small`), on cards, in rows, and in
chat headers.

## Labels that aren't controls

Anything that only says something has no box, outline, or fill, so it can't be mistaken for a button or a filter.
The Developer and Tester badges on Profile are cards in the stats row, like "events hosted", with their number or
word in green. The "Alpha:" under the board is ordinary emphasized text (`em`).

## Colors

| Variable | Light | Used for |
| --- | --- | --- |
| `--bg` | `#f2eee5` | The page |
| `--surface` | `#fffcf6` | Text fields, rows, notices, and other boxes on the page |
| `--text`, `--muted` | `#2b2219`, `#776a5a` | Text, and secondary text (notes, hints, and timestamps) |
| `--line` | `#e2d9c9` | Borders of fields, rows, and notices |
| `--accent` | `#2f6b3a` (fir green) | Emphasis, links, badges, and your own chat messages; never controls |
| `--yes`, `--no` | green, rust | Swipe stamps |
| `--wood`, `--wood-edge`, `--wood-text` | brown gradient, dark brown, cream | Filled buttons, the tab bar, and picked choices: the title board's wood, the same in light and dark |
| `--wood-line` | `#934e23` | Brown outlines: outlined buttons, choices, chips, cards, post ideas, and section flourishes |
| `--warn-*` | amber | Warnings (`.notice.warn`) |

Dark mode swaps these for dark equivalents, under `@media (prefers-color-scheme: dark)` when the theme is
Automatic, and under `:root[data-theme="dark"]` when someone picks Dark under Developer settings at the bottom of Profile (`public/theme.js`).

## Type

Everything is set in National Park (`public/fonts/`, under the OFL), the board's lettering. Buttons use it at weight
800 with a slight text shadow, like the board. The page's name sits under the board in `.page-title`.

## Cards

A card is a post: its title, the facts (when, where, cost, max attendees, and tags), the details, and at the
bottom, who's hosting or who's in (`.who`; on your own posts, who can see it). When is a link that adds the post to
your calendar, and Where always links to the map: to the spot, or to a search for the place's name. Cards are on the page's light surface (`--surface`) with a
brown outline (`--wood-line`) and rounded corners, so they stand out from the page without looking like filled
buttons. They're much bigger than buttons, too, and full of details rather than a single lettered label.

- **Deck** (`.deck .card`): Discover and Confirm show cards in a stack. Drag the top one right for yes or left for
  no, or use the two buttons under it (`.btn.round.no` and `.btn.round.yes`: Pass and I'm in, or No thanks and Let's
  do it). They answer the card, so they're brown filled buttons. A stamp (`.stamp.yes`, `.stamp.no`) fades in as you
  drag.
- **Flat cards** (`.card.flat`): the same card in a list, in the discard pile, Plans, and Posts. Each has a tilted
  label in its top right corner (`.label`) saying where it stands:
  - `.label.in` (green): it's on, or you said yes (It's on, I'm in, Let's do it).
  - `.label.pass` (rust): you said no, or it's off (Pass, No thanks, Cancelled).
  - `.label.warn` (amber): waiting on something (2 interested, Waitlist, Re-confirm?).
  - `.label.done` (dark): over or neutral (Done, Dropped out, Looking).
- A flat card's buttons go in `.card-actions` (or `.pile-actions`), under the card's content, right-aligned.

## Discard pile

Under the Discover and Confirm decks, the discard pile (`.pile`) shows the cards you've already swiped, newest first,
as flat cards labelled with your answer. A pass is slightly faded (`.pile-card.pass`). Each card has "Change to …"
to flip your answer, and on Discover, Delete to clear it out for good. Both change something, so both are brown
filled.

Cards can only be deleted in three places: a discard pile, Past in Plans, and your own posts in Posts.

## Page structure

- **Section headings** (`.section-title`): centered and bold, between two little tree branches: wood brown, thick
  next to the title and thinning to a point, with a couple of twigs and green leaves (an SVG in `--branch`, one per
  theme; the right branch is the left one mirrored). The same room above and below, so sections stand apart.
- **Notes and hints** (`.note`, `.hint`): small muted text that explains what's around it.
- **Notices** (`.notice`): a box for something to know, like a blocked person's chat or the demo account.
  `.notice.warn` is amber, for something that needs attention, like the warning that guests' swipes do nothing.
- **Rows** (`.row`): a line in a list, like a contact, an invitation, or a passkey: an avatar or title on the left,
  buttons on the right.
- **Sheets** (`.sheet`, `.panel`): forms that slide up over the page, like editing a post, a contact, or an
  invitation. Cancel (outlined) and the form's action (filled) sit side by side at the bottom (`.two`).
- **Text links** (`button.link`): green text, for small in-line actions that open something, like "Share what you
  think" or "Invite them to connect".

## Navigation

The tab bar at the bottom (`nav.tabs`) has wood buttons with cream line icons, like the board: binoculars
(Discover), a checkmark (Confirm), a calendar (Plans), a plus (Post), and a person (Profile). The open tab looks
pressed in. A red count (`.badge`) shows what's waiting. The bar sits on the page's own background, with no strip or
border around it, and above everything on the page except sheets, overlays, and messages.

## Chat

Plans chats and feedback threads are chats: your messages on the right in green, theirs on the left in a box, and
what happened (matched, marked as done, and so on) centered in muted text. Tap one of your own messages to edit it;
an edited message says so. Feedback threads label the developers ("Developer") and the person who posted
("Tester"), and show each person's profile icon.

## Accessibility

- Every control has a visible focus ring, in the board's brown.
- Icons have text labels (`aria-label` or `title`); decorative ones are `aria-hidden`.
- Choices are real radio buttons and checkboxes under the styling, so keyboards and screen readers work.
- Check text contrast in both themes when adding colors, and respect `prefers-reduced-motion` for new animations
  (the post ideas already do).
