#!/usr/bin/env python3
"""Build-time catalogue for Reel Pick: TMDB metadata + TypeSafe Jev affect profiles -> data/catalog.json.

Runs OFFLINE on the build machine only. Reads TMDB_API_KEY and TYPESAFE_API_KEY from the environment and never
prints or writes either value; the Jev key is never shipped to the client (only the scored JSON is).

Jev usage mirrors tcg-stock-finder/backend/jev.py: POST https://api.typesafe.ai/v1/systemone, model pinned to
jev-1.13.0, atomic one-thing-per-question nouls plus one choice, structured instructions, retry on 429/5xx,
every answer cached in SQLite keyed by a hash of (model, question-set version, film payload) so nothing is asked twice.

Affect dimensions (each a noul probability in 0..1, read as "degree"):
  Russell (1980) circumplex of affect -> valence (pleasant/unpleasant) and arousal (activation), plus a 4-way
  quadrant choice (excited / calm-content / tense / sad) whose probabilities give a second valence/arousal estimate.
  Zillmann (1988) mood-management theory -> the client uses valence/arousal/comfort to either sustain or repair a mood.
  Viewing-experience dimensions: darkness, humour, complexity (cognitive load), pace, emotional weight (tearjerker),
  comfort/rewatchability; content flags: violence, scares, sexual content, family-suitable, romance-centred.

Usage: scripts/build_catalog.py [--target 5000] [--jev-limit N] [--workers 8] [--pilot 20]
"""
import argparse, concurrent.futures as cf, hashlib, json, math, os, re, sqlite3, sys, threading, time
from collections import Counter
from datetime import datetime, timezone
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "scripts", ".cache"); os.makedirs(CACHE_DIR, exist_ok=True)
DB = os.path.join(CACHE_DIR, "catalog.sqlite")
OUT = os.path.join(ROOT, "data", "catalog.json")
TMDB = "https://api.themoviedb.org/3"
JEV_URL = os.getenv("TYPESAFE_API_URL", "https://api.typesafe.ai/v1/systemone")
MODEL = "jev-1.13.0"
QV = "reelpick-affect-v1"
PRICE_PER_MTOK = 0.042  # USD per 1M input tokens (docs.typesafe.ai/models, Oct 2026); output tokens free

_local = threading.local()
def sess():
    if not hasattr(_local, "s"): _local.s = requests.Session()
    return _local.s

lock = threading.Lock()
def db():
    c = sqlite3.connect(DB, timeout=30); c.row_factory = sqlite3.Row
    return c
with db() as c:
    c.execute("CREATE TABLE IF NOT EXISTS tmdb(id INTEGER PRIMARY KEY, v TEXT, fetched REAL)")
    c.execute("CREATE TABLE IF NOT EXISTS jev_cache(h TEXT PRIMARY KEY, v TEXT, usage INTEGER, created TEXT DEFAULT CURRENT_TIMESTAMP)")
    c.execute("CREATE TABLE IF NOT EXISTS runs(ts TEXT, calls INTEGER, tokens INTEGER)")

# ---------------- TMDB ----------------
def tmdb(path, **params):
    key = os.environ["TMDB_API_KEY"].strip()
    h = {"accept": "application/json"}
    if key.startswith("eyJ"): h["Authorization"] = "Bearer " + key
    else: params["api_key"] = key
    for attempt in range(5):
        try:
            r = sess().get(TMDB + path, params=params, headers=h, timeout=20)
            if r.status_code == 429: time.sleep(1 + attempt); continue
            r.raise_for_status(); return r.json()
        except requests.RequestException as e:
            if attempt == 4: raise RuntimeError(f"TMDB {path} failed: {type(e).__name__}") from None
            time.sleep(1 + attempt)

def collect_ids(target):
    lists = [  # (sort, extra params, pages)
        ("vote_count.desc", {}, 500),
        ("vote_average.desc", {"vote_count.gte": 800}, 60),
        ("popularity.desc", {"vote_count.gte": 250, "primary_release_date.gte": "2019-01-01"}, 40),
    ]
    ids, order = set(), []
    base = {"include_adult": "false", "include_video": "false", "with_runtime.gte": 60, "language": "en-GB"}
    for sort, extra, pages in lists:
        quota = target if sort == "vote_count.desc" else target // 6
        added = 0
        for p in range(1, pages + 1):
            j = tmdb("/discover/movie", sort_by=sort, page=p, **base, **extra)
            for r in j.get("results", []):
                if r["id"] not in ids and r.get("overview"):
                    ids.add(r["id"]); order.append(r["id"]); added += 1
            if added >= quota or p >= j.get("total_pages", 0): break
        print(f"  list {sort}: +{added}", flush=True)
    return order

def details(mid, max_age_days=3):
    with db() as c:
        row = c.execute("SELECT v, fetched FROM tmdb WHERE id=?", (mid,)).fetchone()
    if row and time.time() - row["fetched"] < max_age_days * 86400: return json.loads(row["v"])
    d = tmdb(f"/movie/{mid}", language="en-GB", append_to_response="keywords,watch/providers,release_dates")
    keep = {k: d.get(k) for k in ("id", "title", "release_date", "runtime", "vote_average", "vote_count", "popularity", "overview",
                                  "poster_path", "backdrop_path", "imdb_id", "original_language", "tagline")}
    keep["genres"] = [g["id"] for g in d.get("genres", [])]
    keep["keywords"] = [k["name"] for k in (d.get("keywords") or {}).get("keywords", [])][:20]
    keep["gb"] = ((d.get("watch/providers") or {}).get("results") or {}).get("GB") or {}
    cert = ""
    for rd in (d.get("release_dates") or {}).get("results", []):
        if rd.get("iso_3166_1") == "GB":
            cert = next((x["certification"] for x in rd["release_dates"] if x.get("certification")), "")
    keep["cert"] = cert
    with lock, db() as c:
        c.execute("REPLACE INTO tmdb(id, v, fetched) VALUES(?,?,?)", (mid, json.dumps(keep), time.time()))
    return keep

# ---------------- Jev ----------------
CONTEXT = ("A film recommender for viewers in the UK is profiling films by the feelings and viewing experience they give a "
           "typical adult viewer. Judge the film itself from its metadata (title, year, genres, keywords, synopsis); use what "
           "is widely known about the film if you recognise it.")
def nq(question, yes, no):
    return {"type": "noul", "instructions": {"question": question}, "criteria": {"true": yes, "false": no}}
QUESTIONS = {
    # Russell circumplex
    "valence": nq("Does `film` leave a typical viewer feeling good (pleasant, uplifted, satisfied) rather than unsettled or low?",
                  "Mostly pleasant feelings: joy, warmth, hope, satisfaction.", "Mostly unpleasant feelings: fear, sadness, disgust, bleakness."),
    "arousal": nq("Is `film` a high-energy, physiologically arousing watch (excitement, tension, adrenaline) for most of its runtime?",
                  "Keeps the viewer keyed up: thrills, suspense, action, scares.", "Low arousal: gentle, quiet, relaxed or contemplative."),
    "quadrant": {"type": "choice", "instructions": {"question": "Which feeling best describes the dominant emotional experience of watching `film`?"},
                 "criteria": {"excited": "Excited, elated, thrilled (pleasant and high energy).",
                              "content": "Calm, content, cosy, relaxed (pleasant and low energy).",
                              "tense": "Tense, anxious, scared, angry (unpleasant and high energy).",
                              "sad": "Sad, melancholy, bleak, heavy (unpleasant and low energy)."}},
    # experience dimensions
    "dark": nq("Is `film` dark in tone, centred on subjects such as violence, death, cruelty, crime or despair?",
               "Dark, grim or disturbing tone.", "Light or mostly bright tone."),
    "humour": nq("Is making the audience laugh a main aim of `film`?", "Comedy is central; many jokes.", "Little or no comedy."),
    "complex": nq("Does `film` demand close attention to follow, e.g. a twisty, layered, non-linear or intellectually demanding story?",
                  "Cognitively demanding; rewards concentration.", "Easy to follow while relaxed or half-watching."),
    "pace": nq("Is `film` fast-paced, with frequent events and quick momentum?", "Fast, propulsive pacing.", "Slow-burn, leisurely or contemplative pacing."),
    "weight": nq("Is `film` likely to make many viewers cry?", "A tearjerker; emotionally heavy moments.", "Unlikely to bring viewers to tears."),
    "comfort": nq("Is `film` a comforting, low-stress watch that people rewatch to relax or feel better?",
                  "Comfort viewing; reassuring and easy to return to.", "Not comfort viewing: stressful, upsetting or demanding."),
    # content flags
    "violence": nq("Does `film` contain strong or graphic violence?", "Strong, bloody or graphic violence.", "Little, mild or no violence."),
    "scary": nq("Is `film` likely to frighten viewers with horror, jump scares or gore?", "Frightening.", "Not frightening."),
    "sex": nq("Does `film` contain explicit sexual content or nudity?", "Explicit sex or nudity.", "None or only implied."),
    "family": nq("Is `film` suitable for children under 12 to watch with their family?", "Family-friendly.", "Not suitable for under-12s."),
    "romance": nq("Is a romantic relationship central to the story of `film`?", "Romance is a central thread.", "Romance is absent or minor."),
}
DIMS = ["valence", "arousal", "dark", "humour", "complex", "pace", "weight", "comfort", "violence", "scary", "sex", "family", "romance"]
GENRES = {}

def film_payload(d):
    return {"title": d["title"], "year": (d.get("release_date") or "")[:4], "genres": [GENRES.get(g, str(g)) for g in d["genres"]],
            "keywords": d["keywords"][:12], "synopsis": (d.get("overview") or "")[:900], "uk_certificate": d.get("cert") or None}

def jev_hash(payload): return hashlib.sha256(json.dumps([MODEL, QV, payload], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]
stats = {"calls": 0, "tokens": 0, "errors": 0, "cached": 0, "auth_failed": False}

def jev_score(d):
    payload = film_payload(d); h = jev_hash(payload)
    with db() as c:
        row = c.execute("SELECT v FROM jev_cache WHERE h=?", (h,)).fetchone()
    if row:
        with lock: stats["cached"] += 1
        return json.loads(row["v"])
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key or stats.get("auth_failed"): return None
    body = {"model": MODEL, "state": {"context": CONTEXT, "film": payload}, "questions": QUESTIONS}
    for attempt in range(4):
        try:
            r = sess().post(JEV_URL, json=body, timeout=(5, 45), headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
            if r.status_code in (429, 500, 502, 503, 529):
                time.sleep(min(float(r.headers.get("Retry-After") or 2 ** attempt), 10)); continue
            if r.status_code in (401, 403):
                with lock: stats["errors"] += 1; stats["auth_failed"] = True
                return None
            if r.status_code != 200:
                with lock: stats["errors"] += 1
                print(f"  jev HTTP {r.status_code} for {d['id']}: {r.text[:160]}", flush=True); return None
            data = r.json(); a = data.get("answers") or {}
            tok = int((data.get("usage") or {}).get("input_tokens") or 0)
            with lock: stats["calls"] += 1; stats["tokens"] += tok
            v = {k: round(float(a[k]["noul"]), 3) for k in DIMS if k in a and "noul" in a[k]}
            if "quadrant" in a: v["quad"] = {k: round(float(p), 3) for k, p in (a["quadrant"].get("probabilities") or {}).items()}
            if len(v) < len(DIMS): return None
            v["model"] = data.get("model")
            with lock, db() as c:
                c.execute("REPLACE INTO jev_cache(h, v, usage) VALUES(?,?,?)", (h, json.dumps(v), tok))
            return v
        except requests.RequestException as e:
            if attempt == 3:
                with lock: stats["errors"] += 1
                print(f"  jev {type(e).__name__} for {d['id']}", flush=True); return None
            time.sleep(2 ** attempt)
    return None


# ---------------- heuristic fallback (used only for films Jev has not scored) ----------------
# Genre priors + keyword lexicon. Coarser than Jev; each film records which source scored it (src 1=Jev, 0=heuristic).
GP = {  # genre -> {dim: value 0..1}
 "Comedy": {"valence": .75, "humour": .9, "comfort": .65, "dark": .2, "arousal": .4},
 "Family": {"valence": .8, "family": .95, "comfort": .75, "dark": .1, "violence": .05, "sex": .02},
 "Animation": {"valence": .75, "family": .8, "comfort": .7, "humour": .55},
 "Romance": {"valence": .65, "romance": .95, "comfort": .6, "weight": .45},
 "Music": {"valence": .7, "comfort": .6},
 "Drama": {"weight": .55, "complex": .5, "pace": .3, "valence": .45},
 "Thriller": {"arousal": .85, "dark": .65, "valence": .35, "pace": .7, "complex": .55, "comfort": .15},
 "Crime": {"dark": .75, "violence": .6, "arousal": .65, "valence": .35},
 "Horror": {"scary": .95, "arousal": .85, "dark": .85, "valence": .15, "violence": .7, "comfort": .05, "family": .02},
 "Mystery": {"complex": .75, "arousal": .6, "dark": .5},
 "Sci-Fi": {"complex": .65, "arousal": .65},
 "Action": {"arousal": .9, "pace": .9, "violence": .6, "valence": .6},
 "Adventure": {"arousal": .7, "pace": .7, "valence": .7, "family": .5},
 "War": {"dark": .85, "violence": .8, "weight": .7, "valence": .2, "arousal": .7},
 "History": {"weight": .55, "complex": .55, "pace": .3},
 "Western": {"violence": .55, "pace": .45},
 "Fantasy": {"valence": .65, "arousal": .6, "family": .5},
 "Documentary": {"complex": .55, "pace": .3, "humour": .1},
}
KW = [(r"twist|non.?linear|time (loop|travel)|dream|puzzle|unreliable|mind", {"complex": .85}),
      (r"grief|death of|terminal|cancer|loss of|tragedy|holocaust|suicide|dying", {"weight": .85, "dark": .7, "valence": .25}),
      (r"feel.?good|friendship|heartwarming|christmas|holiday|underdog|cheerful", {"valence": .85, "comfort": .8}),
      (r"serial killer|murder|revenge|gore|torture|massacre|brutal", {"dark": .9, "violence": .85}),
      (r"zombie|ghost|demon|haunt|possession|slasher|monster", {"scary": .85}),
      (r"parody|spoof|slapstick|satire|stand.?up|buddy comedy", {"humour": .95}),
      (r"heist|chase|car race|martial arts|explosion|shootout|superhero", {"arousal": .9, "pace": .9}),
      (r"sex|erotic|nudity|affair|prostitut", {"sex": .7}),
      (r"love|romance|wedding|romantic", {"romance": .85}),
      (r"coming of age|small town|road trip|cooking|summer", {"comfort": .7, "valence": .7})]
def heuristic(f):
    names = [GENRES.get(g, "") for g in f["genres"]]
    v = {d: [] for d in DIMS}
    for n in names:
        for d, x in GP.get(n, {}).items(): v[d].append(x)
    text = " ".join(f["keywords"]).lower()
    for rx, dd in KW:
        if re.search(rx, text):
            for d, x in dd.items(): v[d].append(x); v[d].append(x)
    base = {"valence": .5, "arousal": .5, "dark": .35, "humour": .2, "complex": .4, "pace": .5, "weight": .3, "comfort": .35,
            "violence": .25, "scary": .1, "sex": .15, "family": .3, "romance": .2}
    out = {d: round(sum(v[d]) / len(v[d]), 3) if v[d] else base[d] for d in DIMS}
    cert = (f.get("cert") or "").upper()
    if cert in ("U", "PG"): out["family"] = max(out["family"], .8); out["sex"] = min(out["sex"], .05); out["violence"] = min(out["violence"], .3)
    if cert == "18": out["family"] = .02
    if cert == "15": out["family"] = min(out["family"], .15)
    va, ar = out["valence"], out["arousal"]
    q = {"excited": va * ar, "content": va * (1 - ar), "tense": (1 - va) * ar, "sad": (1 - va) * (1 - ar)}
    t = sum(q.values()) or 1
    out["quad"] = {k: round(x / t, 3) for k, x in q.items()}; out["src"] = "heuristic"
    return out

# ---------------- providers (same matchers as tmdb.js) ----------------
SVC = [("N", r"^netflix"), ("P", r"^amazon prime video"), ("D", r"^disney"), ("A", r"^apple tv( ?\+| plus)?$"),
       ("S", r"^(now( tv)?( cinema)?|sky go)$"), ("M", r"^(hbo )?max$"), ("B", r"^bbc iplayer"), ("I", r"^itvx"),
       ("C", r"^channel 4"), ("U", r"^paramount( ?\+| plus)( premium| basic.*)?$")]
def codes(gb):
    out = ""
    for p in (gb.get("flatrate") or []) + (gb.get("free") or []) + (gb.get("ads") or []):
        for code, rx in SVC:
            if re.search(rx, p["provider_name"], re.I) and code not in out: out += code
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=5000)
    ap.add_argument("--jev-limit", type=int, default=None, help="max films to send to Jev (cached ones are free)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--pilot", type=int, default=0, help="score only N films and print them (no JSON written)")
    a = ap.parse_args()
    if not os.environ.get("TMDB_API_KEY"): sys.exit("TMDB_API_KEY not set")
    t0 = time.time()
    GENRES.update({g["id"]: ("Sci-Fi" if g["id"] == 878 else g["name"]) for g in tmdb("/genre/movie/list", language="en")["genres"]})
    print("collecting ids…", flush=True)
    ids = collect_ids(a.target if not a.pilot else 40)
    if a.pilot: ids = ids[:a.pilot]
    print(f"{len(ids)} ids; fetching details…", flush=True)
    with cf.ThreadPoolExecutor(16) as ex: films = [f for f in ex.map(lambda i: _safe(details, i), ids) if f]
    films = [f for f in films if f.get("overview") and f.get("release_date") and f.get("runtime")]
    print(f"{len(films)} films with details ({time.time()-t0:.0f}s); scoring with Jev…", flush=True)
    todo = films if a.jev_limit is None else films[:a.jev_limit]
    scores = {}
    def work(f): scores[f["id"]] = jev_score(f)
    done = 0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for _ in ex.map(work, todo):
            done += 1
            if done % 250 == 0: print(f"  {done}/{len(todo)} · calls {stats['calls']} · tokens {stats['tokens']:,} · cached {stats['cached']} · errors {stats['errors']}", flush=True)
    with db() as c: c.execute("INSERT INTO runs VALUES(?,?,?)", (datetime.now(timezone.utc).isoformat(), stats["calls"], stats["tokens"]))
    if a.pilot:
        for f in todo: print(f["title"], f.get("release_date", "")[:4], json.dumps(scores.get(f["id"])))
        print(json.dumps(stats), f"est ${stats['tokens']*PRICE_PER_MTOK/1e6:.4f}"); return
    write(films, scores, time.time() - t0)

def _safe(fn, *x):
    try: return fn(*x)
    except Exception as e: print("  skip", x, type(e).__name__, flush=True); return None

def short(t, n=240):
    if len(t) <= n: return t
    cut = t[:n].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"

def write(films, scores, secs):
    with db() as c:
        tot_calls, tot_tok = c.execute("SELECT COUNT(*), COALESCE(SUM(usage),0) FROM jev_cache").fetchone()
    for f in films:
        if not scores.get(f["id"]): scores[f["id"]] = heuristic(f)
    scored = films
    n_jev = sum(1 for f in films if scores[f["id"]].get("src") != "heuristic")
    kwc = Counter(k for f in scored for k in set(f["keywords"]))
    vocab = sorted([k for k, n in kwc.items() if n >= 3], key=lambda k: -kwc[k])
    kix = {k: i for i, k in enumerate(vocab)}
    rows = []
    for f in sorted(scored, key=lambda f: -(f.get("vote_count") or 0)):
        s = scores[f["id"]]; q = s.get("quad") or {}
        rows.append([f["id"], f["title"], int(f["release_date"][:4]), f["runtime"], round(f.get("vote_average") or 0, 1), f.get("vote_count") or 0,
                     f["genres"], [kix[k] for k in f["keywords"] if k in kix][:8], f.get("poster_path") or "",
                     [round(s[d] * 100) for d in DIMS], [round((q.get(k) or 0) * 100) for k in ("excited", "content", "tense", "sad")],
                     codes(f.get("gb") or {}), f.get("cert") or "", f.get("imdb_id") or "", 0 if s.get("src") == "heuristic" else 1])
    meta = {"built": datetime.now(timezone.utc).isoformat(timespec="seconds"), "count": len(rows), "model": MODEL, "question_set": QV,
            "jev_calls_total": tot_calls, "jev_input_tokens_total": tot_tok, "est_cost_usd_total": round(tot_tok * PRICE_PER_MTOK / 1e6, 4),
            "jev_calls_this_run": stats["calls"], "jev_tokens_this_run": stats["tokens"], "cached_this_run": stats["cached"], "errors_this_run": stats["errors"], "jev_auth_failed": stats["auth_failed"],
            "price_per_mtok_usd": PRICE_PER_MTOK, "providers_region": "GB", "build_seconds": round(secs),
            "jev_scored": n_jev, "heuristic_scored": len(rows) - n_jev,
            "fields": ["tmdb_id", "title", "year", "runtime", "tmdb_rating", "votes", "genre_ids", "keyword_idx", "poster_path",
                       "dims_x100", "quadrant_x100", "uk_services", "uk_cert", "imdb_id", "score_src(1=jev,0=heuristic)"],
            "dims": DIMS, "quadrant": ["excited", "content", "tense", "sad"],
            "sources": "Film data and images: TMDB. UK streaming availability: JustWatch via TMDB. Affect scores: TypeSafe Jev (build time)."}
    out = {"meta": meta, "genres": {str(k): v for k, v in GENRES.items()}, "keywords": vocab, "films": rows}
    with open(OUT, "w") as fh: json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    # synopses ship separately and load after first render (keeps the core catalogue small)
    ov = {str(f["id"]): short(f.get("overview") or "") for f in scored}
    with open(os.path.join(ROOT, "data", "overviews.json"), "w") as fh: json.dump(ov, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT}: {len(rows)} films, {len(vocab)} keywords, {os.path.getsize(OUT)/1e6:.2f} MB")
    print(json.dumps({k: meta[k] for k in ("count", "jev_scored", "heuristic_scored", "jev_calls_total", "jev_input_tokens_total", "est_cost_usd_total", "jev_calls_this_run", "errors_this_run")}))

if __name__ == "__main__": main()
