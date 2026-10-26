# REEL//PICK: what shall we watch?

Static movie chooser on the TCG//SCAN neon theme. Live: https://sfxhewitt.github.io/reel-pick/

## Data
- `data/catalog.json`: 10,049 popular and acclaimed films from TMDB with a build-time mood profile per film
  (valence, arousal, darkness, humour, complexity, pace, tearjerker, comfort, plus content flags: violence, scares, sex, family, romance),
  and a UK certificate. `data/overviews.json` holds synopses and loads after first paint.
- Live TMDB (`tmdb.js`, key in `config.js`): backdrops, cast, trailers and runtimes, live search, and an "All of TMDB" discover mode
  (genre, runtime, rating, era, and moods mapped to genre + keyword combinations).
- UK where-to-watch (stream / rent) in the film sheet from TMDB `watch/providers` (JustWatch data, same TMDB key). Plex (optional, `plex.js`) shows what's on your own server instead; see below.
- `data.js`: the original 170-film list, used offline when the catalogue can't load.

## Build the catalogue (offline, build machine only)
```
TMDB_API_KEY=… TYPESAFE_API_KEY=… python3 scripts/build_catalog.py --target 11000
./scripts/gen-config.sh        # writes config.js from $TMDB_API_KEY (a TMDB read key, public by design)
```
Mood profiles come from TypeSafe Jev (`jev-1.13.0`): one request per film, with the film as `state` and 13 atomic nouls plus a
4-way circumplex choice. Answers are cached in `scripts/.cache/catalog.sqlite`, so nothing is asked twice. Films Jev hasn't scored get
an estimate from genre priors and a keyword lexicon (`score_src` = 0 in the JSON). The Jev key is never shipped to the client.

## Recommender (`reco.js`)
Circumplex affect space (Russell 1980). The quiz offers "match my mood" or "change my mood" (Zillmann's mood management).
Ranking uses cosine similarity over the affect vector plus genre/keyword TF-IDF, a Bayesian-average rating, and MMR for diversity.
Like, dislike, skip and "not interested" feed a Rocchio-style taste profile. Every suggestion comes with a short "why this pick".
Quiz result cards have three actions: **Watchlist**, **Seen it** and **Not interested**. Each does its job and clears the film from
the picks with a quick fade/collapse; the next pick is promoted to Top pick and the list is backfilled from the remaining ranked
candidates, so it stays at three while there are any. Dismissed films don't come back for the rest of the visit.
(Like/dislike are still in the film detail sheet.)

## Plex (optional)
Settings → **Sign in with Plex** uses Plex's PIN flow for web apps: `POST plex.tv/api/v2/pins?strong=true` (X-Plex-Product
`Reel Pick`, a random X-Plex-Client-Identifier kept in localStorage), then `app.plex.tv/auth#?clientID…&code…&forwardUrl=<app>#plexauth`,
then the app polls the PIN for `authToken`. The PIN is created when Settings opens, so the tap can open Plex straight away (no popup
blocking). Polling also runs on resume/relaunch: on an iPhone home-screen app the Plex page can open in Safari, so you sign in there,
come back, and the app picks up the token. A popup that lands on `#plexauth` finishes the PIN and closes itself.

- **Token**: stored only in this browser's `localStorage['reelpick.plex.auth']`. It's never logged, never put in a URL, and only sent
  to Plex hosts. Server access tokens stay in memory. **Sign out** clears everything Plex-related.
- **Watchlist**: on cards (◆ button) and in the detail sheet. The film is matched by TMDB id via
  `discover.provider.plex.tv/library/metadata/matches?type=1&guid=tmdb://ID`, then `PUT /actions/addToWatchlist|removeFromWatchlist?ratingKey=`.
  Current state comes from `/library/sections/watchlist/all` (cached 15 min).
- **On my server**: `clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1` gives your own servers. Only **https**
  `*.plex.direct` connections are tried (http from an https page is blocked as mixed content): local first (2.5 s), then remote
  (6 s), then relay (9 s). Movie sections are read with `includeGuids=1` into TMDB and IMDb id sets (new and legacy agents),
  cached in localStorage and refreshed every 6 h in the background, or with **Refresh library**. Cards get an **On Plex** chip; the
  detail sheet adds **Play on Plex** (app.plex.tv deep link). Tonight and Browse get *All films / Only on my Plex / Hide ones I own*.
- **Limits**: away from home the server must have **Remote Access** enabled (or Plex Relay, which is slow but fine for metadata).
  On the same Wi-Fi the local plex.direct address works in Safari; Chrome may block the local address from a public site
  (Private Network Access) and falls back to remote. Plex's hosts send `Access-Control-Allow-Origin: *`, so there are no CORS
  problems. If no connection answers, the app says so, keeps the last library copy, and the watchlist still works.

## Genre preferences
The quiz asks "Anything you never want to see?". Tap a genre chip to exclude it (red, struck through); tap again or long-press to
require it (green, +); a third tap clears it. The choice is saved and applies as a hard filter to Tonight, Browse, live search and
Surprise. Edit it under Settings → Genres or Browse → Never show.

## iPhone home-screen app
`viewport-fit=cover`, status-bar style `default`, and safe-area padding on the header, sheets and bottom nav. Sheets have a sticky
Close bar below the status bar, close on swipe-down or browser back, and stop above the bottom nav so the nav is always tappable.
`sw.js` is network-first with a versioned cache; bump `CACHE` on release.

## Suggestion rules (`rules.js`, localStorage with timestamps)
After a film is suggested, it isn't suggested again for 30 days. Each skip is a strike, and three strikes hide the film for a year.
"Not interested" hides it for a year straight away. Nothing repeats within a session.

## Tests
```
node --test tests/                       # rules (simulated clock), recommender and plex.js unit tests
python3 -m http.server 47391 & python3 tests/e2e.py http://localhost:47391/   # Playwright: desktop, iPhone 440x956, and standalone emulation (62px/34px safe-area insets)
python3 tests/plex_e2e.py http://localhost:47391/   # Plex with every endpoint mocked (route interception)
```
Film data and images: TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
