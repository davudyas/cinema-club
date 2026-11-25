# Cinema Club 🎬 — Play a movie game, then talk films

A movie version of the "game first, then chat" idea: get matched with a random film fan (or invite a friend with a room code), play a quick movie mini-game, and the winner picks two question cards that get pinned at the top of your chat.

Includes a light and dark theme (follows your device, toggle with ☾/☀︎) and a ✕ Leave button on every screen of a match, from searching to the chat (tap twice).

## Talk about a film
Just finished a movie? Tap **💬 Talk about a film**, search it (or tap one of the *Popular this week* posters), and you're matched with someone who picked the same film. The "Now discussing" list shows which films others are waiting to talk about, so you can join with one tap. The chat opens straight away with the film pinned and three spoiler-friendly question cards; tap a question card to ask it; either person can tap 🎲 to play a movie game together and come back to the chat afterwards.

## When nobody's around
Online counts never include you ("just you here" / "1 other online"). While you wait for a match you can **play the Projectionist** — you stay in the queue (a bar at the bottom says so) and get pulled into a real match the moment someone joins.

## Installable + sound
Cinema Club can be installed as an app (manifest, icons, network-first service worker in `sw.js`; "📲 Install app" appears in the footer when the browser offers it). Sound effects are generated with Web Audio (`js/sound.js`), with vibration on phones and a mute button.

## Daily challenge
📅 Five rounds that are the same for everyone each day (UTC), picked with a date-based seed. Up to 200 points per round (100 for a correct answer + up to 100 for speed), one try per day, streaks, and a shareable result like `🟩🟥🟩🟩🟩 790/1000`. Results are stored only in the player's browser.

## Safety
- 🚩 **Report** (top right whenever you're connected to someone): pick a reason, add details, optionally block & leave. Reports land in the Supabase table `cinema_club_reports` (insert-only for visitors) with the reported person's recent messages attached. Read them in Supabase → Table editor.
- **Block & leave** stops you from being matched with that device again.
- **Chat filter** (`js/filter.js`): blurs common insults/slurs in English, German and Turkish and hides emails, phone numbers and @handles. Reports keep the unfiltered text for review.
- **About & rules** panel in the footer, with the TMDB credit and a feedback link.

## Your name
Tap your name on the home page to choose your emoji and both words yourself, or ↻ for a random one.

## Mini-games
| Game | How it works |
|---|---|
| 🍿 Emoji Flick | Guess the film from three emojis (80 curated puzzles) |
| ⚖️ Higher or Lower | Which came out first / is rated higher / is longer? |
| 🔗 Actor Chain | Take turns linking films through a shared actor; each actor max 3×; run out of time = lose |
| 🌫️ Blur Reveal | A poster slowly sharpens — first correct answer wins |
| 📅 Year Guess | Closest release year wins the round |
| 🎭 Cast Call | The cast is revealed from the bottom of the billing up |
| 🔍 Scene Zoom | A film still zooms out from a random spot |
| 📜 Plot Twist | Guess the film from its synopsis — title words are blacked out |
| 🎬 Director's Cut | Who directed it? Four names, one is right |
| 🪪 Who's Who | Name the film from its character names |
| 🕰️ Timeline | Put four films in release order — one shot |

Matches are first to 3 rounds (max 7). Actor Chain is a single sudden-death duel.

## How it works
- **No sign-up.** Random nickname + emoji (tap to reroll), stored in the browser.
- **Random match:** everyone on the site joins a Supabase Realtime *presence* channel; people who tap "Random match" are paired in order of waiting.
- **Rooms:** 4-letter code + shareable link (`?room=ABCD`).
- **Solo:** play any game against a bot ("The Projectionist") — also useful when nobody's online.
- **Game logic:** one player's browser acts as the host (generates rounds, judges answers, keeps score) and broadcasts to the other. Speed is measured on each player's own device, so ping doesn't decide who was faster.
- **Chat:** live messages, typing indicator, "Another game" rematch, leave, and **Block & leave** (you won't be matched with that device again). Links are stripped from messages.
- **No database tables.** Supabase is only used for Realtime presence + broadcast. Chats are not stored anywhere.

## Files
```
index.html            page shell
css/style.css         all styling
js/app.js             screens, matchmaking, host game loop, chat
js/games.js           game definitions, round generators, solo bot
js/movies.js          TMDB data layer (+ demo fallback)
js/net.js             realtime transport (Supabase / local test / bot loop)
js/content.js         emoji puzzles, question cards, nicknames
js/demo-data.js       58 offline demo films (used until TMDB is connected)
js/config.js          Supabase URL + publishable key, TMDB settings
netlify/functions/tmdb.mjs   read-only TMDB proxy (keeps your key secret)
netlify.toml
```

## Deploy on Netlify (with the TMDB proxy)
1. Get a free TMDB key: themoviedb.org → Settings → API (the v3 "API Key" or the v4 "Read Access Token" both work).
2. Put this folder in a GitHub repo and import it in Netlify (**Add new site → Import an existing project**). No build command, publish directory `.`.
3. In Netlify → **Site configuration → Environment variables**, add `TMDB_API_KEY` = your key, then redeploy.

Netlify Drop (drag and drop a folder) doesn't run Functions. If you use it, paste your TMDB v3 key into `TMDB_KEY` in `js/config.js` instead. That key is then visible in the page source; it's read-only, but the proxy is the cleaner option.

Without a TMDB key the site still works using the built-in **demo films**. Blur Reveal and Scene Zoom are hidden in that mode because they need real posters.

## Supabase
`js/config.js` points at your existing Supabase project and uses only Realtime channels (prefixed `coldopen-`). Nothing is written to your database. To move Cinema Club to its own project, create one and swap in its URL and publishable key.

## Testing locally
Serve the folder (e.g. `python3 -m http.server`) and open two tabs with `?net=local&data=demo`. They talk to each other through the browser without needing Supabase or TMDB.

## Ideas for later
- Report button with a Supabase table + moderation queue
- Daily challenge / leaderboard
- Letterboxd username on your profile card
- Turkish/German language toggle
