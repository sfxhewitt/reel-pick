"""Playwright end-to-end checks for Reel Pick at desktop (1440x900), iPhone (440x956) and iPhone home-screen standalone emulation.
Usage: python3 tests/e2e.py [base_url]   (default http://localhost:47391/)
Writes screenshots to screenshots/ and prints a JSON summary. Exit code 1 on any failed check."""
import asyncio, json, sys, os, time, re
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:47391/"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "screenshots")
os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": str(detail)[:200]}); print(("PASS " if ok else "FAIL ") + name, detail if not ok else "")

PLEX_RE = re.compile(r"^https://([a-z0-9-]+\.)*plex\.(tv|direct)(:\d+)?/")
async def no_real_plex(ctx):
    """These suites run signed out; Settings pre-creates a sign-in PIN, so answer plex.tv locally instead of hitting it."""
    async def h(route):
        if route.request.method == "OPTIONS": return await route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"})
        await route.fulfill(status=201, headers={"access-control-allow-origin": "*", "content-type": "application/json"}, body=json.dumps({"id": 1, "code": "TESTPIN", "expiresIn": 1800}))
    await ctx.route(PLEX_RE, h)

async def posters_loaded(pg, sel):
    return await pg.evaluate("""s=>{const im=[...document.querySelectorAll(s+' .poster img')].filter(i=>i.getBoundingClientRect().top<innerHeight*1.5);
      return {n:im.length, ok:im.filter(i=>i.complete&&i.naturalWidth>0).length, tmdb:im.filter(i=>i.src.startsWith('https://image.tmdb.org/')).length}}""", sel)

PROVIDER_JS = """()=>{const t=document.body.innerText;return {svcBadges:document.querySelectorAll('.badge.svc,.dv-svc,#fServices,#onlyMine').length,
  words:['Netflix','Prime Video','Disney+','Apple TV+','HBO Max','iPlayer','ITVX','Paramount+','Where to watch','JustWatch','on your services'].filter(w=>t.includes(w))}}"""
def no_providers(x): return x["svcBadges"] == 0 and not x["words"]
GENRES_OF = "sel=>[...document.querySelectorAll(sel)].map(e=>e.closest('[data-id]')).filter(Boolean).map(e=>ReelPick.getM(e.dataset.id)).filter(Boolean).map(f=>f.g)"

async def run(p, label, vp, mobile):
    ctx = await p.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
    await no_real_plex(ctx)
    pg = await ctx.new_page(); errs = []; tmdb_calls = []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("request", lambda r: tmdb_calls.append(r.url.split("?")[0]) if "api.themoviedb.org" in r.url else None)
    await pg.goto(BASE); await pg.wait_for_function("document.documentElement.dataset.ready==='1'", timeout=40000)
    st = await pg.evaluate("({live:ReelPick.live, src:ReelPick.source, n:ReelPick.films.length})")
    check(f"{label}: TMDB live + catalogue loaded", st["live"] and st["src"] == "catalog" and st["n"] > 9000, st)
    await pg.wait_for_function("ReelPick.stats", timeout=20000)
    check(f"{label}: reach stats", True, await pg.evaluate("ReelPick.stats"))
    await pg.wait_for_selector("#hero .poster img", timeout=20000)
    await pg.wait_for_timeout(1200)
    pl = await posters_loaded(pg, "#hero"); check(f"{label}: hero poster loads from TMDB", pl["ok"] >= 1 and pl["tmdb"] >= 1, pl)
    await pg.screenshot(path=f"{OUT}/{label}-tonight.png")

    # Browse (catalogue): mood chip + dimension slider
    await pg.click("nav.tabs button[data-view=browse]"); await pg.wait_for_selector("#results .card")
    if mobile: await pg.click("#toggleFilters"); await pg.wait_for_timeout(400)
    await pg.click("#fMood .chip[data-k=la]")
    await pg.locator("#fDims .dim[data-k=comfort] input").fill("80")
    if mobile: await pg.screenshot(path=f"{OUT}/{label}-filters.png"); await pg.click("#closeFilters"); await pg.wait_for_timeout(400)
    await pg.wait_for_timeout(600)
    cnt = await pg.inner_text("#resultCount"); check(f"{label}: mood+slider filter narrows catalogue", "film" in cnt.lower() and "10,049" not in cnt, cnt)
    await pg.wait_for_timeout(1500)
    pl = await posters_loaded(pg, "#results"); check(f"{label}: browse posters load", pl["ok"] >= 4 and pl["ok"] == pl["n"], pl)
    pv = await pg.evaluate(PROVIDER_JS); check(f"{label}: no streaming-provider UI in browse", no_providers(pv), pv)
    why = await pg.locator("#results .reason").first.inner_text() if not mobile else await pg.locator("#results .card .reason").first.inner_text()
    check(f"{label}: 'why' text on results", "weighted rating" in why, why)
    await pg.screenshot(path=f"{OUT}/{label}-browse.png")

    # Search: catalogue + live TMDB search
    await pg.click("#resetFilters") if not mobile else (await pg.click("#toggleFilters"), await pg.click("#resetFilters"), await pg.click("#closeFilters"))
    await pg.fill("#q", "paddington"); await pg.wait_for_selector("#liveMore .card", timeout=20000); await pg.wait_for_timeout(1500)
    n_cat = await pg.locator("#results > .card").count(); n_live = await pg.locator("#liveMore .card").count()
    check(f"{label}: search hits catalogue + live TMDB search", n_cat >= 1 and n_live >= 1, f"catalogue={n_cat} live={n_live}")
    await pg.screenshot(path=f"{OUT}/{label}-search.png")
    await pg.fill("#q", ""); await pg.wait_for_timeout(600)

    # Live TMDB discover with genre + runtime
    if mobile: await pg.click("#toggleFilters"); await pg.wait_for_timeout(300)
    await pg.click("#srcChips .chip[data-src=live]"); await pg.click("#fGenre .chip[data-k=Comedy]"); await pg.click("#fRuntime .chip[data-k=mid]")
    if mobile: await pg.click("#closeFilters")
    await pg.wait_for_function("document.querySelector('#resultCount').textContent.includes('live TMDB')", timeout=20000)
    await pg.wait_for_selector("#results .card", timeout=20000); await pg.wait_for_timeout(2500)
    cnt = await pg.inner_text("#resultCount")
    gs = await pg.evaluate(GENRES_OF, "#results .card")
    runs = await pg.eval_on_selector_all("#results [data-run]", "e=>e.map(x=>x.textContent)")
    check(f"{label}: live discover (Comedy, 90–120m) from TMDB", "live tmdb" in cnt.lower() and len(gs) >= 4 and all("Comedy" in g for g in gs), f"{cnt}; {len(gs)} cards; runtimes {runs[:6]}")
    pl = await posters_loaded(pg, "#results"); check(f"{label}: live discover posters load", pl["ok"] >= 4 and pl["tmdb"] == pl["n"], pl)
    await pg.screenshot(path=f"{OUT}/{label}-live-discover.png")

    # Detail view: live cast + trailer, no providers
    await pg.locator("#results .card [data-open]").first.click()
    await pg.wait_for_selector(".dv-cast li", timeout=20000); await pg.wait_for_timeout(1500)
    cast = await pg.locator(".dv-cast li").count(); trailer = await pg.locator(".dv-actions a", has_text="Trailer").count()
    pv = await pg.evaluate(PROVIDER_JS)
    check(f"{label}: detail shows live cast + trailer, no providers", cast >= 1 and trailer == 1 and no_providers(pv), f"cast={cast} trailer={trailer} {pv}")
    await pg.screenshot(path=f"{OUT}/{label}-detail.png")
    await pg.click("#sheetClose"); await pg.wait_for_selector("#modal", state="hidden")

    # Quiz (mood management)
    await pg.click("nav.tabs button[data-view=quiz]")
    for v in ["stressed", "change", "solo", "mid", "*"]: await pg.click(f"#quiz .opt[data-v='{v}']")
    await pg.click("#qGenres .gchip[data-g=Comedy]"); await pg.click("#qGenres .gchip[data-g=Horror]")
    st = await pg.eval_on_selector_all("#qGenres .gchip[data-st='1']", "e=>e.map(x=>x.dataset.g)")
    await pg.screenshot(path=f"{OUT}/{label}-quiz-genres.png")
    check(f"{label}: quiz genre step: tap excludes", sorted(st) == ["Comedy", "Horror"], st)
    await pg.click("#qNext"); await pg.click("#quiz .opt[data-v=classic]")
    await pg.wait_for_selector("#quiz .pick"); await pg.wait_for_timeout(2500)
    picks = await pg.locator("#quiz .pick").count(); why = await pg.locator("#quiz .pick .why").first.inner_text()
    check(f"{label}: quiz returns 3 picks with mood-management 'why'", picks == 3 and "change" in why.lower(), why)
    gs = await pg.evaluate(GENRES_OF, "#quiz .pick")
    check(f"{label}: quiz exclusions filter the picks (no Comedy/Horror)", len(gs) == 3 and not any(set(g) & {"Comedy", "Horror"} for g in gs), gs)
    await pg.screenshot(path=f"{OUT}/{label}-quiz.png", full_page=False)
    # exclusions persist and apply to Tonight + Browse
    await pg.reload(); await pg.wait_for_function("document.documentElement.dataset.ready==='1'", timeout=40000)
    gp = await pg.evaluate("ReelPick.store.genrePrefs")
    await pg.click("nav.tabs button[data-view=browse]"); await pg.wait_for_selector("#results .card"); await pg.wait_for_timeout(500)
    bg = await pg.evaluate(GENRES_OF, "#results > .card")
    await pg.click("nav.tabs button[data-view=tonight]"); await pg.wait_for_timeout(500)
    tg = await pg.evaluate(GENRES_OF, "#hero [data-id], #view-tonight .card")
    pool = await pg.evaluate("ReelPick.films.filter(f=>f.g.includes('Comedy')||f.g.includes('Horror')).length")
    check(f"{label}: exclusions persist after reload and filter Tonight + Browse", sorted(gp["exclude"]) == ["Comedy", "Horror"] and len(bg) >= 4 and len(tg) >= 2
          and not any(set(g) & {"Comedy", "Horror"} for g in bg + tg), f"prefs={gp} browse={len(bg)} tonight={len(tg)} (catalogue has {pool} such films)")

    # Picker: skip x2 = strikes, not interested = ban; no repeats in session
    await pg.click("nav.tabs button[data-view=tonight]"); await pg.click("#quickMoods .mood[data-mood=ch]")
    await pg.wait_for_selector(".dv"); seen_ids = []
    for _ in range(3):
        seen_ids.append(await pg.get_attribute(".dv", "data-id")); await pg.click("#againBtn"); await pg.wait_for_timeout(250)
    cur = await pg.get_attribute(".dv", "data-id"); seen_ids.append(cur)
    await pg.click(".dv [data-act=notint]"); await pg.wait_for_timeout(300)
    r = await pg.evaluate("ids=>ids.map(i=>[i, ReelPick.rules.reason(i), ReelPick.rules.strikes(i)])", seen_ids)
    check(f"{label}: picker never repeats + skips logged + not-interested bans", len(set(seen_ids)) == 4 and all(x[1] in ("cooldown", "session") for x in r[:3]) and all(x[2] == 1 for x in r[:3]) and r[3][1] in ("banned", "session")
          and await pg.evaluate("id=>!!ReelPick.rules.banInfo(id)", cur), r)
    await pg.click("#sheetClose"); await pg.wait_for_selector("#modal", state="hidden")
    check(f"{label}: no TMDB watch-provider requests", not [c for c in tmdb_calls if "provider" in c], [c for c in tmdb_calls if "provider" in c][:3])
    check(f"{label}: no console errors", not errs, errs[:5])
    check(f"{label}: TMDB endpoints used", len(set(tmdb_calls)) >= 4, sorted(set(c.replace("https://api.themoviedb.org/3", "") for c in tmdb_calls if "/movie/" not in c)) + ["/movie/{id}"])
    await ctx.close()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_insets import STANDALONE_CSS, INSET_JS
AUDIT_JS = """()=>[...document.querySelectorAll('button,a,[role=button]')].filter(b=>{const r=b.getBoundingClientRect();if(!r.width||!r.height)return false;
  const m=document.getElementById('modal');if(!m.hidden&&!m.contains(b))return false;
  const fp=document.querySelector('.filters.panel.open');if(fp&&!fp.contains(b))return false;
  const cs=getComputedStyle(b);if(cs.visibility==='hidden'||cs.display==='none')return false;
  const t=(b.textContent||'').trim(),a=(b.getAttribute('aria-label')||'');return /^(✕|×|x|X|close|done)$/i.test(t)||/close/i.test(a)||b.matches('[data-close],#closeFilters,#settingsBtn');})
  .map(b=>{const r=b.getBoundingClientRect();const h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
  return {id:b.id||b.className,text:(b.textContent||'').trim().slice(0,12),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),hit:!!h&&(h===b||b.contains(h))}})"""

async def standalone(p):
    """iPhone 17 Pro Max home-screen mode: 440x956 with injected safe-area insets (top 62px, bottom 34px) and
    opaque, tap-swallowing overlays where the status bar/Dynamic Island and home indicator sit."""
    label = "standalone"
    ctx = await p.new_context(viewport={"width": 440, "height": 956}, device_scale_factor=3, is_mobile=True, has_touch=True)
    await ctx.add_init_script(f"({INSET_JS})({json.dumps(STANDALONE_CSS)})"); await no_real_plex(ctx)
    pg = await ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    await pg.goto(BASE); await pg.wait_for_function("document.documentElement.dataset.ready==='1'", timeout=40000); await pg.wait_for_timeout(800)
    meta = await pg.evaluate("[document.querySelector('meta[name=viewport]').content, document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]').content, !!document.querySelector('link[rel=manifest]')]")
    check(f"{label}: viewport-fit=cover, status-bar style 'default', manifest", "viewport-fit=cover" in meta[0] and meta[1] == "default" and meta[2], meta)
    man = await (await pg.request.get(BASE + "manifest.json")).json()
    ati = await pg.evaluate("(()=>{const l=document.querySelector('link[rel=apple-touch-icon]');return [l.getAttribute('sizes'),l.href,document.querySelector('meta[name=apple-mobile-web-app-title]').content]})()")
    ic = {}
    for i in man["icons"]: ic[i["sizes"]] = [i.get("purpose"), (await pg.request.get(BASE + i["src"])).status]
    ati_ok = (await pg.request.get(ati[1])).status == 200
    check(f"{label}: home-screen name REEL//PICK, apple-touch-icon 180, manifest icons 192/512", man["name"] == "REEL//PICK" and ati[0] == "180x180" and ati[2] == "REEL//PICK" and ati_ok
          and ic.get("192x192") == ["any", 200] and ic.get("512x512") == ["any", 200], [man["name"], ati, ic])
    hb = await pg.evaluate("['#title','#settingsBtn','.top .brand'].map(s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return [s,Math.round(r.top),Math.round(r.height)]})")
    check(f"{label}: header sits below the 62px inset", all(x and x[1] >= 62 for x in hb if x), hb)
    nav = await pg.evaluate("[...document.querySelectorAll('nav.tabs button')].map(b=>{const r=b.getBoundingClientRect();return [b.dataset.view,Math.round(r.top),Math.round(r.bottom),Math.round(r.height)]})")
    check(f"{label}: bottom nav sits above the 34px home indicator, 44px+ targets", len(nav) == 4 and all(b[2] <= 956 - 34 and b[3] >= 44 for b in nav), nav)
    await pg.screenshot(path=f"{OUT}/{label}-tonight.png")

    async def audit(state):
        xs = await pg.evaluate(AUDIT_JS)
        bad = [x for x in xs if x["top"] < 62 or x["w"] < 44 or x["h"] < 44 or not x["hit"]]
        check(f"{label}: [{state}] every close/X control is below the inset, 44px+, and not covered", xs and not bad, bad or xs)
        return xs

    async def open_settings():
        await pg.click("#settingsBtn"); await pg.wait_for_selector("#modal:not([hidden]) #setGenres")

    # Settings: close button, nav tabs, back gesture, swipe-down
    await open_settings(); await pg.wait_for_timeout(300)
    await pg.screenshot(path=f"{OUT}/{label}-settings.png")
    await audit("settings")
    t = await pg.inner_text("#sheetTitle"); sb = await pg.locator("#sheetClose").bounding_box()
    check(f"{label}: settings sheet has a titled bar with a visible Close", t.strip().lower() == "settings" and sb["y"] >= 62 and sb["height"] >= 44, f"title={t!r} close={sb}")
    await pg.click("#sheetClose")  # Playwright click = real hit-test; fails if the inset overlay covers it
    await pg.wait_for_selector("#modal", state="hidden"); check(f"{label}: Close leaves settings", True)
    for v in ["browse", "saved", "quiz", "tonight"]:
        await open_settings()
        await pg.click(f"nav.tabs button[data-view={v}]")
        ok = await pg.evaluate("v=>document.getElementById('modal').hidden && !document.getElementById('view-'+v).hidden", v)
        check(f"{label}: nav tab '{v}' is tappable while settings is open and leaves it", ok)
    await open_settings(); await pg.go_back(); await pg.wait_for_timeout(400)
    ok = await pg.evaluate("[document.getElementById('modal').hidden, location.href]")
    check(f"{label}: browser back closes settings and stays in the app", ok[0] and ok[1].startswith(BASE), ok)
    await open_settings()
    bar = await pg.locator(".sheet-bar").bounding_box(); x0, y0 = bar["x"] + 60, bar["y"] + bar["height"] / 2
    await pg.evaluate("""([x,y])=>{const el=document.querySelector('.sheet-bar');const T=(yy)=>[new Touch({identifier:1,target:el,clientX:x,clientY:yy})];
      el.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:T(y)}));
      for(let d=20;d<=200;d+=20) el.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,touches:T(y+d)}));
      el.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[]}));}""", [x0, y0])
    await pg.wait_for_timeout(500)
    check(f"{label}: swipe-down closes the sheet", await pg.evaluate("document.getElementById('modal').hidden"))

    # Genre prefs in settings: tap = exclude, long-press = require, persists, applies everywhere
    await open_settings()
    await pg.click("#setGenres .gchip[data-g=Horror]"); await pg.click("#setGenres .gchip[data-g=Romance]")
    loc = pg.locator("#setGenres .gchip[data-g=Animation]")
    await loc.dispatch_event("pointerdown"); await pg.wait_for_timeout(650); await loc.dispatch_event("pointerup")
    st = await pg.evaluate("[...document.querySelectorAll('#setGenres .gchip')].filter(b=>b.dataset.st!=='0').map(b=>b.dataset.g+':'+b.dataset.st)")
    await pg.locator("#setGenres").scroll_into_view_if_needed(); await pg.screenshot(path=f"{OUT}/{label}-settings-genres.png")
    check(f"{label}: settings genre chips: tap excludes, long-press requires", sorted(st) == ["Animation:2", "Horror:1", "Romance:1"], st)
    # clear the 'require' (tap cycles 2 -> 0) so browse stays broad
    await pg.click("#setGenres .gchip[data-g=Animation]")
    await pg.click("#sheetClose"); await pg.wait_for_selector("#modal", state="hidden")
    await pg.reload(); await pg.wait_for_function("document.documentElement.dataset.ready==='1'", timeout=40000); await pg.wait_for_timeout(600)
    gp = await pg.evaluate("ReelPick.store.genrePrefs")
    check(f"{label}: genre prefs persist across reload", sorted(gp["exclude"]) == ["Horror", "Romance"] and gp["require"] == [], gp)
    tg = await pg.evaluate(GENRES_OF, "#hero [data-id], #view-tonight .card")
    await pg.click("nav.tabs button[data-view=browse]"); await pg.wait_for_selector("#results .card"); await pg.wait_for_timeout(500)
    bg = await pg.evaluate(GENRES_OF, "#results > .card")
    await pg.click("#toggleFilters"); await pg.wait_for_timeout(450)
    await audit("filters drawer")
    fp = await pg.eval_on_selector_all("#fGenrePrefs .gchip[data-st='1']", "e=>e.map(x=>x.dataset.g)")
    await pg.screenshot(path=f"{OUT}/{label}-filters.png")
    await pg.click("#closeFilters"); await pg.wait_for_timeout(400)
    surprise = []
    for _ in range(5):
        await pg.click("#fab")
        try: await pg.wait_for_selector("#modal:not([hidden]) .dv", timeout=8000)
        except Exception:
            print("DIAG", _, await pg.evaluate("[document.getElementById('modal').hidden, document.querySelector('#modalBody').innerHTML.slice(0,200), history.length, JSON.stringify(history.state), location.hash, document.getElementById('toast').textContent, document.querySelector('#resultCount').textContent]")); raise
        surprise.append(await pg.evaluate("ReelPick.getM(document.querySelector('#modal .dv').dataset.id).g"))
        if _ == 0: await audit("surprise detail"); await pg.screenshot(path=f"{OUT}/{label}-detail.png")
        await pg.click("#sheetClose"); await pg.wait_for_selector("#modal", state="hidden")
    allg = tg + bg + surprise
    check(f"{label}: exclusions are hard filters in Tonight, Browse and Surprise", len(tg) >= 2 and len(bg) >= 4 and not any(set(g) & {"Horror", "Romance"} for g in allg)
          and sorted(fp) == ["Horror", "Romance"], f"tonight={len(tg)} browse={len(bg)} surprise={surprise} browse-panel={fp}")
    pv = await pg.evaluate(PROVIDER_JS); check(f"{label}: no streaming-provider UI", no_providers(pv), pv)
    # Detail sheet from a card: Close reachable after scrolling the sheet
    await pg.locator("#results .card [data-open]").first.click(); await pg.wait_for_selector("#modal:not([hidden]) .dv")
    await pg.evaluate("document.querySelector('.modal-card').scrollTop=600"); await pg.wait_for_timeout(200)
    await audit("detail scrolled")
    ov = await pg.evaluate("[document.querySelector('.modal-card').scrollWidth, document.querySelector('.modal-card').clientWidth, document.documentElement.scrollWidth]")
    check(f"{label}: detail sheet has no sideways overflow", ov[0] <= ov[1] + 1 and ov[2] <= 441, ov)
    await pg.click("#sheetClose"); await pg.wait_for_selector("#modal", state="hidden")
    # Quiz + saved views: no stray X
    await pg.click("nav.tabs button[data-view=quiz]"); await pg.wait_for_timeout(300)
    xs = await pg.evaluate(AUDIT_JS); stray = [x for x in xs if x["text"] in ("✕", "×", "X", "x")]
    check(f"{label}: no stray X buttons on the quiz view", not stray, stray)
    await pg.screenshot(path=f"{OUT}/{label}-quiz.png")
    check(f"{label}: no console errors", not errs, errs[:5])
    await ctx.close()

async def clock_rules(p):
    """Browser-level clock simulation: rules survive reloads; cooldown/ban expire on schedule."""
    ctx = await p.new_context(viewport={"width": 1280, "height": 860}); pg = await ctx.new_page()
    t0 = datetime(2026, 10, 18, 19, 0, tzinfo=timezone.utc)  # simulated "now"
    await pg.clock.install(time=t0)
    await pg.goto(BASE); await pg.wait_for_function("document.documentElement.dataset.ready==='1'", timeout=40000)
    hero = await pg.evaluate("ReelPick.store.hero.id")
    await pg.evaluate("ReelPick.rules.skip('tmdb-603');ReelPick.rules.skip('tmdb-603');ReelPick.rules.notInterested('tmdb-13')")
    await pg.reload(); await pg.wait_for_function("document.documentElement.dataset.ready==='1'")
    s1 = await pg.evaluate("h=>[ReelPick.rules.reason(h), ReelPick.rules.strikes('tmdb-603'), ReelPick.rules.reason('tmdb-13')]", hero)
    check("clock: after reload hero is on cooldown, strikes + ban persisted", s1 == ["cooldown", 2, "banned"], s1)
    await pg.clock.set_fixed_time(t0 + timedelta(days=31)); await pg.reload(); await pg.wait_for_function("document.documentElement.dataset.ready==='1'")
    s2 = await pg.evaluate("h=>[ReelPick.rules.state.shown[h]||null, !!ReelPick.rules.banInfo('tmdb-13'), ReelPick.store.hero.id!==h, Date.now()]", hero)
    # the day-0 cooldown must have expired: the film is either free or was legitimately re-suggested today (new timestamp)
    check("clock: +31 days day-0 cooldown expired (free or re-suggested), new hero picked", (s2[0] is None or s2[0] >= s2[3] - 60e3) and s2[2], s2)
    check("clock: +31 days ban still active", s2[1] is True, s2)
    await pg.evaluate("ReelPick.rules.skip('tmdb-603')")
    s3 = await pg.evaluate("[ReelPick.rules.reason('tmdb-603'), ReelPick.rules.banInfo('tmdb-603').why]")
    check("clock: third skip (a month later) bans for a year", s3 == ["banned", "three-skips"], s3)
    await pg.clock.set_fixed_time(t0 + timedelta(days=366)); await pg.reload(); await pg.wait_for_function("document.documentElement.dataset.ready==='1'")
    s4 = await pg.evaluate("[!!ReelPick.rules.banInfo('tmdb-13'), !!ReelPick.rules.banInfo('tmdb-603')]")
    check("clock: +366 days not-interested ban lifted; 3-skip ban (set at +31d) still active", s4 == [False, True], s4)
    await ctx.close()

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        await run(b, "desktop", {"width": 1440, "height": 900}, False)
        await run(b, "iphone", {"width": 440, "height": 956}, True)
        await standalone(b)
        await clock_rules(b)
        await b.close()
    bad = [r for r in results if not r["ok"]]
    json.dump(results, open(os.path.join(OUT, "e2e-results.json"), "w"), indent=1)
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)
asyncio.run(main())
