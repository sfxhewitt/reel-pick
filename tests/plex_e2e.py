"""Playwright tests for the Plex integration with every Plex endpoint mocked by route interception (no real Plex calls).
Usage: python3 tests/plex_e2e.py [base_url]   (default http://localhost:47391/)
Covers: signed-out state, PIN sign-in via popup + forwardUrl, resume-polling after relaunch, token hygiene, 'On Plex' badges,
Play on Plex link, watchlist add/remove (detail + card), Only/Hide filters (Browse + Tonight, persisted), unreachable server, sign out."""
import asyncio, json, os, re, sys
from urllib.parse import urlparse, parse_qs, unquote
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:47391/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "screenshots"); os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
TOKEN, SRV_TOKEN, MID = "MOCK-USER-TOKEN-9f3", "MOCK-SERVER-TOKEN-77", "mock-machine-01"
results = []
def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": str(detail)[:300]}); print(("PASS " if ok else "FAIL ") + name, "" if ok else detail)

cat = json.load(open(os.path.join(ROOT, "data/catalog.json")))
rows = cat["films"]                                # sorted by votes desc
OWNED = {r[0] for i, r in enumerate(rows[:600]) if i % 2 == 0}   # half of the popular films are "on the server"
LEGACY = set(list(sorted(OWNED))[:10])             # some items only carry a legacy IMDb guid
IMDB = {r[0]: r[13] for r in rows[:600]}
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS"}

class Plex:
    def __init__(self, reachable=True):
        self.authorized = False; self.reachable = reachable; self.wl = {rows[1][0]}; self.calls = []; self.bad_token = []
    async def handle(self, route):
        req = route.request; url = req.url; m = req.method; h = {k.lower(): v for k, v in req.headers.items()}
        if m == "OPTIONS": return await route.fulfill(status=204, headers=CORS)
        self.calls.append((m, url))
        J = lambda body, status=200: route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=json.dumps(body))
        u = urlparse(url); q = parse_qs(u.query)
        if u.netloc == "plex.tv":
            if u.path == "/api/v2/pins" and m == "POST":
                ok = h.get("x-plex-product") == "Reel Pick" and h.get("x-plex-client-identifier") and "x-plex-token" not in h
                return await J({"id": 4242, "code": "MOCKCODE", "expiresIn": 1800, "authToken": None} if ok else {"error": "bad headers"}, 201 if ok else 400)
            if u.path == "/api/v2/pins/4242": return await J({"id": 4242, "code": "MOCKCODE", "authToken": TOKEN if self.authorized else None})
            if u.path == "/api/v2/user":
                if h.get("x-plex-token") != TOKEN: self.bad_token.append(url); return await J({}, 401)
                return await J({"friendlyName": "Rust", "username": "rust"})
        if u.netloc in ("clients.plex.tv", "discover.provider.plex.tv") and h.get("x-plex-token") != TOKEN:
            self.bad_token.append(url); return await J({}, 401)
        if u.netloc == "clients.plex.tv" and u.path == "/api/v2/resources":
            assert q.get("includeHttps") == ["1"] and q.get("includeRelay") == ["1"]
            return await J([{"name": "Mock Box", "product": "Plex Media Server", "provides": "server", "owned": True, "clientIdentifier": MID, "accessToken": SRV_TOKEN,
                "connections": [{"protocol": "http", "uri": "http://192.168.1.9:32400", "local": True, "relay": False},
                                {"protocol": "https", "uri": "https://192-168-1-9.abc.plex.direct:32400", "local": True, "relay": False},
                                {"protocol": "https", "uri": "https://81-1-1-1.abc.plex.direct:32400", "local": False, "relay": False},
                                {"protocol": "https", "uri": "https://relay-1.abc.plex.direct:8443", "local": False, "relay": True}]},
                {"name": "Friend's server", "provides": "server", "owned": False, "clientIdentifier": "x", "connections": []},
                {"name": "iPhone", "provides": "client,player", "owned": True, "clientIdentifier": "y", "connections": []}])
        if u.netloc == "discover.provider.plex.tv":
            if u.path == "/library/sections/watchlist/all":
                items = [{"ratingKey": f"rk-{t}", "type": "movie", "Guid": [{"id": f"tmdb://{t}"}]} for t in sorted(self.wl)]
                st = int(q.get("X-Plex-Container-Start", ["0"])[0]); sz = int(q.get("X-Plex-Container-Size", ["50"])[0])
                return await J({"MediaContainer": {"totalSize": len(items), "Metadata": items[st:st + sz]}})
            if u.path == "/library/metadata/matches":
                t = int(q["guid"][0].split("://")[1]); return await J({"MediaContainer": {"Metadata": [{"ratingKey": f"rk-{t}", "type": "movie"}]}})
            if u.path.startswith("/actions/") and m == "PUT":
                if getattr(self, "fail_actions", 0) > 0: self.fail_actions -= 1; return await J({"error": "boom"}, 503)
                t = int(q["ratingKey"][0][3:]); (self.wl.add if "add" in u.path else self.wl.discard)(t); return await J({})
        if u.netloc.endswith(".plex.direct:32400") or u.netloc.endswith(".plex.direct:8443"):
            if not self.reachable or u.netloc.startswith("192-168"): return await route.abort("connectionrefused")   # local LAN not reachable from the test box
            if h.get("x-plex-token") != SRV_TOKEN: self.bad_token.append(url); return await J({}, 401)
            if u.path == "/identity": return await J({"MediaContainer": {"machineIdentifier": MID}})
            if u.path == "/library/sections": return await J({"MediaContainer": {"Directory": [{"key": "1", "type": "movie", "title": "Films"}, {"key": "2", "type": "show", "title": "TV"}]}})
            if u.path == "/library/sections/1/all":
                assert q.get("includeGuids") == ["1"] and q.get("type") == ["1"]
                items = [({"ratingKey": 9000 + i, "guid": f"com.plexapp.agents.imdb://{IMDB[t]}?lang=en"} if t in LEGACY else
                          {"ratingKey": 9000 + i, "guid": f"plex://movie/{t}", "Guid": [{"id": f"imdb://{IMDB[t]}"}, {"id": f"tmdb://{t}"}]}) for i, t in enumerate(sorted(OWNED))]
                st = int(q.get("X-Plex-Container-Start", ["0"])[0]); sz = int(q.get("X-Plex-Container-Size", ["1000"])[0])
                return await J({"MediaContainer": {"totalSize": len(items), "Metadata": items[st:st + sz]}})
        if u.netloc == "app.plex.tv":
            return await route.fulfill(status=200, headers={"content-type": "text/html"}, body="<html><body><h1>Fake Plex sign-in</h1></body></html>")
        return await J({"error": "unmocked " + url}, 404)

PLEX_RE = re.compile(r"^https://([a-z0-9-]+\.)*plex\.(tv|direct)(:\d+)?/")
async def setup(browser, plex, mobile=False, seed_token=False):
    vp = {"width": 440, "height": 956} if mobile else {"width": 1366, "height": 900}
    ctx = await browser.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, device_scale_factor=3 if mobile else 1)
    if mobile:
        from e2e_insets import STANDALONE_CSS, INSET_JS
        await ctx.add_init_script(f"({INSET_JS})({json.dumps(STANDALONE_CSS)})")
    if seed_token: await ctx.add_init_script(f"if(!localStorage.getItem('reelpick.plex.auth'))localStorage.setItem('reelpick.plex.auth',JSON.stringify({{token:{json.dumps(TOKEN)}}}))")
    await ctx.route(PLEX_RE, plex.handle)
    pg = await ctx.new_page(); logs = []; errs = []
    pg.on("console", lambda m: logs.append(m.text)); pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(BASE); await pg.wait_for_function("document.documentElement.dataset.ready==='1'", timeout=40000)
    return ctx, pg, logs, errs

CARD_TMDB = "sel=>[...document.querySelectorAll(sel)].map(c=>{const f=ReelPick.getM(c.dataset.id);return f?[f.tmdb,!!c.querySelector('.badge.onplex'),!!c.querySelector('[data-act=plexwl]')]:null}).filter(Boolean)"
async def open_settings(pg): await pg.click("#settingsBtn"); await pg.wait_for_selector("#setPlex h3")
async def close_sheet(pg): await pg.click("#sheetClose"); await pg.wait_for_selector("#modal", state="hidden")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        # ---------- signed out ----------
        plex = Plex(); ctx, pg, logs, errs = await setup(b, plex)
        await pg.wait_for_timeout(1500)
        cards = await pg.evaluate(CARD_TMDB, "#tonightRow .card")
        check("signed out: no Plex badges or watchlist buttons on cards", cards and not any(c[1] or c[2] for c in cards), cards[:3])
        check("signed out: Plex bar shows 'not connected' + Connect Plex", await pg.evaluate("!document.getElementById('plexBar').hidden && !!document.getElementById('plexConnectBar')"))
        check("signed out: no calls to Plex until Settings is opened", not plex.calls, plex.calls[:3])
        await pg.locator("#tonightRow .card [data-open]").first.click(); await pg.wait_for_selector("#modal .dv")
        check("signed out: detail offers 'Connect Plex' and no Plex buttons", await pg.locator("#modal [data-plexsettings]").count() == 1 and await pg.locator("#modal [data-act=plexwl]").count() == 0)
        await pg.click("#modal [data-plexsettings]"); await pg.wait_for_selector("#setPlex #plexSignIn")
        check("signed out: Connect Plex opens Settings with 'Sign in with Plex'", "sign in with plex" in (await pg.inner_text("#plexSignIn")).lower())
        await pg.wait_for_timeout(400)
        check("settings pre-creates a strong PIN (no token sent)", any(m == "POST" and "/pins?strong=true" in u for m, u in plex.calls), plex.calls)

        # ---------- sign in: popup -> app.plex.tv -> forwardUrl ----------
        async with pg.expect_popup() as pop: await pg.click("#plexSignIn")
        popup = await pop.value; await popup.wait_for_load_state()
        au = popup.url; frag = parse_qs(au.split("#?", 1)[1]) if "#?" in au else {}
        cid = await pg.evaluate("localStorage.getItem('reelpick.plex.cid')")
        check("auth page: app.plex.tv/auth with clientID, code, product, forwardUrl", au.startswith("https://app.plex.tv/auth#?") and frag.get("clientID") == [cid]
              and frag.get("code") == ["MOCKCODE"] and frag.get("context[device][product]") == ["Reel Pick"] and frag.get("forwardUrl") == [BASE + "#plexauth"], au)
        await pg.wait_for_selector("#plexWait"); check("settings shows 'Waiting for Plex…' while the PIN is open", True)
        plex.authorized = True
        await popup.goto(frag["forwardUrl"][0])           # what Plex does after a successful sign-in
        try: await popup.wait_for_event("close", timeout=8000); closed = True
        except Exception:
            closed = popup.is_closed()
            if not closed: print("DIAG popup", popup.url, await popup.evaluate("[!!window.opener, document.body.innerText.slice(0,120), document.documentElement.dataset.ready]"))
        check("forwardUrl in the popup finishes the PIN and closes itself", closed)
        await pg.wait_for_selector("#plexUser", timeout=10000)
        check("main window: signed in as the Plex user", "Rust" in await pg.inner_text("#plexUser"))
        await pg.wait_for_function("document.querySelector('#plexLib') && document.querySelector('#plexLib').textContent.includes('Mock Box')", timeout=15000)
        lib = await pg.inner_text("#plexLib")
        check("library read from owned server via https plex.direct (local refused -> remote)", f"{len(OWNED)} films on Mock Box" in lib.replace(",", "") and "remote" in lib, lib)
        check("never tried http:// connections or non-owned servers", not any(u.startswith("http://") for _, u in plex.calls) and not plex.bad_token, plex.bad_token[:3])
        await pg.screenshot(path=f"{OUT}/plex-desktop-settings.png")
        # token hygiene
        keys = await pg.evaluate("Object.keys(localStorage).filter(k=>(localStorage.getItem(k)||'').includes(%s))" % json.dumps(TOKEN))
        dom = await pg.evaluate("document.documentElement.outerHTML.includes(%s)" % json.dumps(TOKEN))
        check("token stored only in localStorage['reelpick.plex.auth'], never in URLs, DOM or console",
              keys == ["reelpick.plex.auth"] and not dom and not any(TOKEN in u for _, u in plex.calls) and not any(TOKEN in l for l in logs) and TOKEN not in pg.url, keys)
        check("server token is not persisted", not await pg.evaluate("Object.keys(localStorage).some(k=>(localStorage.getItem(k)||'').includes(%s))" % json.dumps(SRV_TOKEN)))
        await close_sheet(pg)

        # ---------- badges ----------
        await pg.wait_for_timeout(600)
        cards = await pg.evaluate(CARD_TMDB, "#tonightRow .card")
        good = all(c[1] == (c[0] in OWNED) for c in cards)
        check("Tonight cards: 'On Plex' badge exactly on owned films (incl. legacy IMDb guids)", cards and good and any(c[1] for c in cards) and all(c[2] for c in cards), cards)
        await pg.click("nav.tabs button[data-view=browse]"); await pg.wait_for_selector("#results .card"); await pg.wait_for_timeout(500)
        bc = await pg.evaluate(CARD_TMDB, "#results > .card")
        check("Browse cards: badge matches library", bc and all(c[1] == (c[0] in OWNED) for c in bc) and any(c[1] for c in bc), f"{sum(c[1] for c in bc)}/{len(bc)} owned")
        leg = await pg.evaluate("ids=>ids.map(t=>{const f=ReelPick.films.find(f=>f.tmdb===t);return f?!!ReelPick.plex.owned(f):null})", sorted(LEGACY))
        check("legacy-agent items matched through IMDb ids", all(leg), leg)
        await pg.screenshot(path=f"{OUT}/plex-desktop-browse.png")
        # detail of an owned film: Play on Plex
        own_id = next(c[0] for c in bc if c[1])
        await pg.locator(f"#results > .card[data-id='tmdb-{own_id}'] [data-open]").first.click(); await pg.wait_for_selector("#modal .dv")
        href = await pg.get_attribute("#modal a.plexplay", "href")
        rk = 9000 + sorted(OWNED).index(own_id)
        check("detail: 'On Plex' chip + 'Play on Plex' deep link", await pg.locator("#modal .dv-meta .badge.onplex").count() == 1
              and href == f"https://app.plex.tv/desktop/#!/server/{MID}/details?key=%2Flibrary%2Fmetadata%2F{rk}", href)

        # ---------- watchlist ----------
        btn = pg.locator("#modal .btn.plexwl")
        before = await btn.get_attribute("aria-pressed")
        await btn.click(); await pg.wait_for_function("document.querySelector('#modal .btn.plexwl').getAttribute('aria-pressed')==='true'", timeout=8000)
        added = ("PUT", f"https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=rk-{own_id}") in plex.calls
        matched = any("/library/metadata/matches" in u and f"tmdb%3A%2F%2F{own_id}" in u for _, u in plex.calls)
        check("detail: Add to Plex watchlist -> discover match + PUT addToWatchlist", before == "false" and added and matched and own_id in plex.wl)
        await pg.screenshot(path=f"{OUT}/plex-desktop-detail.png")
        await btn.click(); await pg.wait_for_function("document.querySelector('#modal .btn.plexwl').getAttribute('aria-pressed')==='false'", timeout=8000)
        check("detail: second tap removes (PUT removeFromWatchlist)", ("PUT", f"https://discover.provider.plex.tv/actions/removeFromWatchlist?ratingKey=rk-{own_id}") in plex.calls and own_id not in plex.wl)
        await close_sheet(pg)
        pre = rows[1][0]   # already on the mocked watchlist
        st = await pg.evaluate("t=>ReelPick.plex.onWatchlist(t)", pre)
        check("existing watchlist state loaded from library/sections/watchlist/all", st and any("/library/sections/watchlist/all" in u for _, u in plex.calls))
        cb = pg.locator("#results > .card [data-act=plexwl]").nth(2); cid2 = await cb.evaluate("b=>ReelPick.getM(b.closest('[data-id]').dataset.id).tmdb")
        await cb.click(); await pg.wait_for_timeout(600)
        on1 = await cb.get_attribute("aria-pressed"); await cb.click(); await pg.wait_for_timeout(600); on2 = await cb.get_attribute("aria-pressed")
        check("card button toggles add/remove", on1 == "true" and on2 == "false" and cid2 not in plex.wl, [on1, on2])

        # ---------- the main Watchlist buttons (pin / 'Watchlist') also write to Plex ----------
        async def wl_put(t, add=True, timeout=8000):
            want = ("PUT", f"https://discover.provider.plex.tv/actions/{'add' if add else 'remove'}FromWatchlist?ratingKey=rk-{t}".replace("addFrom", "addTo"))
            for _ in range(timeout // 100):
                if want in plex.calls: return True
                await pg.wait_for_timeout(100)
            return False
        pin = pg.locator("#results > .card [data-act=watch]").nth(3); id3 = await pin.evaluate("b=>b.closest('[data-id]').dataset.id"); t3 = await pg.evaluate("i=>ReelPick.getM(i).tmdb", id3)
        await pin.click(); ok_add = await wl_put(t3) and t3 in plex.wl
        toast_txt = await pg.inner_text("#toast")
        await pg.wait_for_timeout(300); await pg.locator(f"#results > .card[data-id='{id3}'] [data-act=watch]").click(); ok_rm = await wl_put(t3, False) and t3 not in plex.wl
        check("Browse pin (Watchlist) adds to Plex watchlist + toast, second tap removes", ok_add and ok_rm and "plex watchlist" in toast_txt.lower(), toast_txt)
        await pg.locator("#results > .card [data-open]").nth(4).first.click(); await pg.wait_for_selector("#modal .btn[data-act=watch]")
        t4 = await pg.evaluate("ReelPick.getM(document.querySelector('#modal [data-id]').dataset.id).tmdb")
        await pg.click("#modal .btn[data-act=watch]")
        check("detail 'Watchlist' button adds to Plex watchlist", await wl_put(t4) and t4 in plex.wl)
        await close_sheet(pg)
        plex.fail_actions = 1
        pin5 = pg.locator("#results > .card [data-act=watch]").nth(5); t5 = await pin5.evaluate("b=>ReelPick.getM(b.closest('[data-id]').dataset.id).tmdb")
        await pin5.click(); await pg.wait_for_selector("#toast .toast-act", timeout=8000)
        err = await pg.inner_text("#toast")
        await pg.click("#toast .toast-act")
        check("Plex failure shows a clear error with Retry; Retry adds it", "failed" in err.lower() and "503" in err and await wl_put(t5) and t5 in plex.wl, err)
        await pg.click("nav.tabs button[data-view=tonight]"); await pg.wait_for_timeout(400)
        hb = pg.locator("#hero [data-act=watch]").first; th = await hb.evaluate("b=>ReelPick.getM(b.closest('[data-id]').dataset.id).tmdb")
        if th in plex.wl: await hb.click(); await pg.wait_for_timeout(600); hb = pg.locator("#hero [data-act=watch]").first
        await hb.click()
        check("Tonight hero 'Watchlist' adds to Plex watchlist", await wl_put(th) and th in plex.wl)
        await pg.click("nav.tabs button[data-view=quiz]")
        if await pg.locator("#quiz .opt[data-v='stressed']").count() == 0 and await pg.locator("#quiz .pick").count() == 0:
            await pg.locator("#quiz button", has_text="Start").first.click()
        for v in ["stressed", "change", "solo", "mid", "*"]: await pg.click(f"#quiz .opt[data-v='{v}']")
        await pg.click("#qNext"); await pg.click("#quiz .opt[data-v=classic]"); await pg.wait_for_selector("#quiz .pick"); await pg.wait_for_timeout(800)
        qp = pg.locator("#quiz .pick").first; qid = await qp.get_attribute("data-id"); tq = await pg.evaluate("i=>ReelPick.getM(i).tmdb", qid)
        await qp.locator("[data-act=watch]").click(); await pg.wait_for_timeout(700)
        gone = await pg.locator(f"#quiz .pick[data-id='{qid}']").count() == 0
        check("quiz 'Watchlist' adds to Plex watchlist and the card is still removed", await wl_put(tq) and tq in plex.wl and gone, [gone])
        await pg.click("nav.tabs button[data-view=browse]"); await pg.wait_for_selector("#results .card"); await pg.wait_for_timeout(500)

        # ---------- filters ----------
        await pg.click("#fPlex [data-pf=only]"); await pg.wait_for_timeout(500)
        oc = await pg.evaluate(CARD_TMDB, "#results > .card"); n_only = await pg.inner_text("#resultCount")
        check("Browse 'Only on my Plex': every result owned", oc and all(c[0] in OWNED for c in oc), n_only)
        await pg.click("#fPlex [data-pf=hide]"); await pg.wait_for_timeout(500)
        hc = await pg.evaluate(CARD_TMDB, "#results > .card")
        check("Browse 'Hide ones I own': no owned results", hc and not any(c[0] in OWNED for c in hc), await pg.inner_text("#resultCount"))
        await pg.click("nav.tabs button[data-view=tonight]"); await pg.wait_for_timeout(300)
        check("Tonight shows the Plex bar with the same choice", not await pg.evaluate("document.getElementById('plexBar').hidden") and await pg.get_attribute("#plexBar [data-pf=hide]", "aria-pressed") == "true")
        await pg.click("#plexBar [data-pf=only]"); await pg.wait_for_timeout(600)
        hero = await pg.evaluate("ReelPick.getM(document.querySelector('#hero [data-id]').dataset.id).tmdb"); trow = await pg.evaluate(CARD_TMDB, "#tonightRow .card")
        check("Tonight 'Only on my Plex': hero + row all owned", hero in OWNED and trow and all(c[0] in OWNED for c in trow), [hero, len(trow)])
        await pg.screenshot(path=f"{OUT}/plex-desktop-tonight-only.png")
        await pg.reload(); await pg.wait_for_function("document.documentElement.dataset.ready==='1'"); await pg.wait_for_timeout(600)
        check("filter choice + library cache survive reload", await pg.evaluate("ReelPick.store.plexFilter") == "only" and await pg.evaluate("ReelPick.plex.libraryReady"))
        await pg.click("#plexBar [data-pf=all]")
        # ---------- sign out ----------
        await open_settings(pg); await pg.click("#plexSignOut"); await pg.wait_for_selector("#setPlex #plexSignIn")
        left = await pg.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('reelpick.plex.')&&k!=='reelpick.plex.cid'&&k!=='reelpick.plex.pin')")
        await close_sheet(pg); await pg.wait_for_timeout(400)
        cards = await pg.evaluate(CARD_TMDB, "#tonightRow .card")
        check("sign out clears token/library/watchlist and removes Plex UI", not left and not any(c[1] or c[2] for c in cards) and await pg.evaluate("!!document.getElementById('plexConnectBar')"), left)
        check("no page errors (main flow)", not errs, errs[:3])
        await ctx.close()

        # ---------- iOS standalone: auth opened elsewhere, app relaunched/resumed -> poll finishes ----------
        plex = Plex(); ctx, pg, logs, errs = await setup(b, plex, mobile=True)
        await open_settings(pg); await pg.wait_for_timeout(400)
        async with pg.expect_popup() as pop: await pg.click("#plexSignIn")
        p2 = await pop.value; await p2.close()           # user finishes in Safari; this context never sees forwardUrl
        await pg.screenshot(path=f"{OUT}/plex-iphone-waiting.png")
        plex.authorized = True
        await pg.reload(); await pg.wait_for_function("document.documentElement.dataset.ready==='1'")
        await pg.wait_for_function("ReelPick.plex.signedIn", timeout=10000)
        check("standalone: pending PIN is polled on relaunch/resume and completes sign-in", True)
        await pg.wait_for_function("ReelPick.plex.libraryReady", timeout=15000); await pg.wait_for_timeout(800)
        await pg.screenshot(path=f"{OUT}/plex-iphone-tonight.png")
        await open_settings(pg); await pg.screenshot(path=f"{OUT}/plex-iphone-settings.png"); await close_sheet(pg)
        await pg.locator("#tonightRow .card:has(.badge.onplex) [data-open]").first.click(); await pg.wait_for_selector("#modal .dv"); await pg.wait_for_timeout(700)
        await pg.screenshot(path=f"{OUT}/plex-iphone-detail.png")
        xs = await pg.evaluate("[...document.querySelectorAll('#modal .btn.plexwl,#modal a.plexplay')].map(b=>{const r=b.getBoundingClientRect();return [Math.round(r.height),Math.round(r.top)]})")
        check("standalone: Plex buttons in detail are 44px+ and below the inset", len(xs) == 2 and all(h >= 44 and t >= 62 for h, t in xs), xs)
        await close_sheet(pg)
        check("no page errors (standalone)", not errs, errs[:3])
        await ctx.close()

        # ---------- server unreachable (no remote access) ----------
        plex = Plex(reachable=False); ctx, pg, logs, errs = await setup(b, plex, seed_token=True)
        await open_settings(pg)
        await pg.wait_for_function("document.querySelector('#plexLib') && document.querySelector('#plexLib').textContent.includes('unreachable')", timeout=30000)
        txt = await pg.inner_text("#plexLib")
        check("unreachable server: clear message mentioning Remote Access", "Remote Access" in txt, txt)
        await pg.screenshot(path=f"{OUT}/plex-desktop-unreachable.png"); await close_sheet(pg)
        cards = await pg.evaluate(CARD_TMDB, "#tonightRow .card")
        check("unreachable server: no badges, watchlist buttons still work, filter hidden", cards and not any(c[1] for c in cards) and all(c[2] for c in cards)
              and await pg.evaluate("document.getElementById('plexBar').hidden"))
        check("no page errors (unreachable)", not errs, errs[:3])
        await ctx.close()
        await b.close()
    bad = [r for r in results if not r["ok"]]
    json.dump(results, open(os.path.join(OUT, "plex-results.json"), "w"), indent=1)
    print(f"\n{len(results) - len(bad)}/{len(results)} Plex checks passed"); sys.exit(1 if bad else 0)
asyncio.run(main())
