# Reel Pick — movie chooser

Open `index.html` directly in a browser (file:///workspace/movie-chooser/index.html) — no server or build needed.
Or serve: `cd /workspace/movie-chooser && python3 -m http.server 8080` → http://localhost:8080

Files: index.html · style.css · app.js · data.js (170 curated films; edit to add more).
Data line format: [title, year, runtimeMins, imdb, "Genres", "moods", "services", "synopsis"]
moods: fg feel-good, th thriller, cr cry, la laugh, mb mind-bender, ch chill, ad adrenaline
services: N Netflix, P Prime Video, D Disney+, M Max, A Apple TV+, S Now/Sky (UK, approximate)
Optional: paste a free TMDB API key in ⚙︎ Settings for real posters (cached in localStorage).
