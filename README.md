# REEL//PICK: what shall we watch?

Static movie chooser on the TCG//SCAN neon theme. Live: https://sfxhewitt.github.io/reel-pick/

## Data
- `data/catalog.json`: 10,049 popular and acclaimed films from TMDB with a build-time mood profile per film
  (valence, arousal, darkness, humour, complexity, pace, tearjerker, comfort, plus content flags: violence, scares, sex, family, romance),
  UK subscription availability at build time, and a UK certificate. `data/overviews.json` holds synopses and loads after first paint.
- Live TMDB (`tmdb.js`, key in `config.js`): refreshes UK watch providers on every card you see (Netflix, Prime Video, Disney+, Apple TV+,
  Now/Sky, HBO Max, BBC iPlayer, ITVX, Channel 4, Paramount+), backdrops, cast and trailers, live search, and an "All of TMDB" discover mode
  (genre, runtime, rating, era, moods mapped to genre + keyword combinations, and services).
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

## Suggestion rules (`rules.js`, localStorage with timestamps)
After a film is suggested, it isn't suggested again for 30 days. Each skip is a strike, and three strikes hide the film for a year.
"Not interested" hides it for a year straight away. Nothing repeats within a session.

## Tests
```
node --test tests/                       # rules (simulated clock) + recommender unit tests
python3 -m http.server 47391 & python3 tests/e2e.py http://localhost:47391/   # Playwright, desktop + iPhone 440x956
```
Film data and images: TMDB. Streaming availability: JustWatch via TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
