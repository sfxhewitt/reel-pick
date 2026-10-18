"""Playwright end-to-end checks for Reel Pick at desktop (1440x900) and iPhone (440x956).
Usage: python3 tests/e2e.py [base_url]   (default http://localhost:47391/)
Writes screenshots to screenshots/ and prints a JSON summary. Exit code 1 on any failed check."""
import asyncio, json, sys, os, time
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:47391/"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "screenshots")
os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": str(detail)[:200]}); print(("PASS " if ok else "FAIL ") + name, detail if not ok else "")

async def posters_loaded(pg, sel):
    return await pg.evaluate("""s=>{const im=[...document.querySelectorAll(s+' .poster img')].filter(i=>i.getBoundingClientRect().top<innerHeight*1.5);
      return {n:im.length, ok:im.filter(i=>i.complete&&i.naturalWidth>0).length, tmdb:im.filter(i=>i.src.startsWith('https://image.tmdb.org/')).length}}""", sel)

async def run(p, label, vp, mobile):
    ctx = await p.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
    pg = await ctx.new_page(); errs = []; tmdb_calls = []
    pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("request", lambda r: tmdb_calls.append(r.url.split("?")[0]) if "api.themoviedb.org" in r.url else None)
    await pg.goto(BASE); await pg.wait_for_function("document.documentElement.dataset.ready==='1'", timeout=40000)
    st = await pg.evaluate("({live:ReelPick.live, src:ReelPick.source, n:ReelPick.films.length})")
    check(f"{label}: TMDB live + catalogue loaded", st["live"] and st["src"] == "catalog" and st["n"] > 9000, st)
    await pg.wait_for_function("ReelPick.stats", timeout=20000)
    check(f"{label}: reach stats", True, await pg.evaluate("ReelPick.stats"))
    await pg.wait_for_selector("#hero [data-badges] .badge.live", timeout=20000)
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
    await pg.wait_for_selector("#results [data-badges] .badge.live", timeout=20000); await pg.wait_for_timeout(1500)
    pl = await posters_loaded(pg, "#results"); check(f"{label}: browse posters load", pl["ok"] >= 4 and pl["ok"] == pl["n"], pl)
    live_badges = await pg.locator("#results .badge.live").count()
    svc = await pg.eval_on_selector_all("#results .badge.svc", "e=>[...new Set(e.map(x=>x.textContent))]")
    check(f"{label}: UK providers refreshed live on cards", live_badges >= 4 and len(svc) >= 2, f"live={live_badges} services={svc}")
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

    # Live TMDB discover with genre + runtime + rating + services
    if mobile: await pg.click("#toggleFilters"); await pg.wait_for_timeout(300)
    await pg.click("#srcChips .chip[data-src=live]"); await pg.click("#fGenre .chip[data-k=Comedy]"); await pg.click("#fRuntime .chip[data-k=mid]")
    await pg.click("#fServices .chip[data-k=N]"); await pg.check("#onlyMine") if not mobile else await pg.locator("label.tog:has(#onlyMine)").click()
    if mobile: await pg.click("#closeFilters")
    await pg.wait_for_function("document.querySelector('#resultCount').textContent.includes('live TMDB')", timeout=20000)
    await pg.wait_for_selector("#results [data-badges] .badge.live", timeout=20000); await pg.wait_for_timeout(2000)
    cnt = await pg.inner_text("#resultCount")
    netflix = await pg.eval_on_selector_all("#results .card", "cs=>cs.filter(c=>c.querySelector('.badge.live')).map(c=>[...c.querySelectorAll('.badge.svc')].map(b=>b.textContent))")
    on_n = sum(1 for b in netflix if "NETFLIX" in b)
    check(f"{label}: live discover (Comedy, 90–120m, Netflix) from TMDB", "live tmdb" in cnt.lower() and on_n >= max(1, int(len(netflix) * .8)), f"{cnt}; {on_n}/{len(netflix)} refreshed cards show Netflix")
    pl = await posters_loaded(pg, "#results"); check(f"{label}: live discover posters load", pl["ok"] >= 4 and pl["tmdb"] == pl["n"], pl)
    await pg.screenshot(path=f"{OUT}/{label}-live-discover.png")

    # Detail view with live providers + cast
    await pg.locator("#results .card [data-open]").first.click()
    await pg.wait_for_selector(".dv-svc", timeout=15000)
    await pg.wait_for_function("document.querySelector('.dv-side h4 small') && document.querySelector('.dv-side h4 small').textContent.includes('live') && document.querySelector('.dv-cast')", timeout=20000)
    await pg.wait_for_timeout(1500)
    logos = await pg.locator(".dv-svc img").count(); cast = await pg.locator(".dv-cast li").count()
    check(f"{label}: detail shows live UK providers + cast", logos >= 1 and cast >= 1, f"provider logos={logos} cast={cast}")
    await pg.screenshot(path=f"{OUT}/{label}-detail.png")
    await pg.click(".modal-card .close")

    # Quiz (mood management)
    await pg.click("nav.tabs button[data-view=quiz]")
    for v in ["stressed", "change", "solo", "mid", "*"]: await pg.click(f"#quiz .opt[data-v='{v}']")
    await pg.click("#quiz .opt[data-v=N]"); await pg.click("#qNext"); await pg.click("#quiz .opt[data-v=classic]")
    await pg.wait_for_selector("#quiz .pick"); await pg.wait_for_timeout(2500)
    picks = await pg.locator("#quiz .pick").count(); why = await pg.locator("#quiz .pick .why").first.inner_text()
    check(f"{label}: quiz returns 3 picks with mood-management 'why'", picks == 3 and "change" in why.lower(), why)
    await pg.screenshot(path=f"{OUT}/{label}-quiz.png", full_page=False)

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
    await pg.click(".modal-card .close")
    check(f"{label}: no console errors", not errs, errs[:5])
    check(f"{label}: TMDB endpoints used", len(set(tmdb_calls)) >= 4, sorted(set(c.replace("https://api.themoviedb.org/3", "") for c in tmdb_calls if "/movie/" not in c)) + ["/movie/{id}"])
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
        await clock_rules(b)
        await b.close()
    bad = [r for r in results if not r["ok"]]
    json.dump(results, open(os.path.join(OUT, "e2e-results.json"), "w"), indent=1)
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)
asyncio.run(main())
