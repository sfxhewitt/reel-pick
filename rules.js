/* Reel Pick suggestion rules, persisted with timestamps in localStorage.
   - Cooldown: a film shown as a suggestion can't be suggested again for 30 days.
   - Three strikes: each skip is a strike; the 3rd skip bans the film for 1 year.
   - "Not interested" bans for 1 year immediately.
   - Never repeats within a session (in-memory set, independent of the cooldown).
   Pure logic with an injectable clock + storage so tests can simulate time (tests/rules.test.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReelRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400e3;
  const COOLDOWN_MS = 30 * DAY, BAN_MS = 365 * DAY, STRIKES_TO_BAN = 3;
  const KEY = 'reelpick.rules.v1';

  function create({ storage = (typeof localStorage !== 'undefined' ? localStorage : null), now = () => Date.now(), key = KEY } = {}) {
    let st = { shown: {}, strikes: {}, bans: {}, log: [] };
    const session = new Set();
    function load() {
      st = { shown: {}, strikes: {}, bans: {}, log: [] };
      try { const j = storage && JSON.parse(storage.getItem(key)); if (j && typeof j === 'object') st = Object.assign(st, j); } catch (e) {}
      prune();
    }
    function save() { try { storage && storage.setItem(key, JSON.stringify(st)); } catch (e) {} }
    function prune() {
      const t = now();
      for (const id in st.shown) if (t - st.shown[id] >= COOLDOWN_MS) delete st.shown[id];
      for (const id in st.bans) if (st.bans[id].until <= t) delete st.bans[id];
      if (st.log.length > 500) st.log = st.log.slice(-500);
    }
    const ev = (type, id, t) => st.log.push({ type, id, ts: t });

    function banInfo(id) { const b = st.bans[id]; return b && b.until > now() ? b : null; }
    function cooldownLeft(id) { const s = st.shown[id]; if (s == null) return 0; const left = s + COOLDOWN_MS - now(); return left > 0 ? left : 0; }
    function reason(id) {
      if (banInfo(id)) return 'banned';
      if (cooldownLeft(id) > 0) return 'cooldown';
      if (session.has(id)) return 'session';
      return null;
    }
    const eligible = id => reason(id) === null;
    function markShown(ids) {
      const t = now(); [].concat(ids).forEach(id => { st.shown[id] = t; session.add(id); ev('shown', id, t); }); save();
    }
    function skip(id) {
      const t = now(); const s = (st.strikes[id] = (st.strikes[id] || []).concat(t)); ev('skip', id, t);
      let banned = false;
      if (s.length >= STRIKES_TO_BAN) { st.bans[id] = { until: t + BAN_MS, why: 'three-skips', at: t }; delete st.strikes[id]; banned = true; }
      save(); return { strikes: banned ? STRIKES_TO_BAN : s.length, banned };
    }
    function notInterested(id) { const t = now(); st.bans[id] = { until: t + BAN_MS, why: 'not-interested', at: t }; delete st.strikes[id]; ev('not-interested', id, t); save(); }
    function unban(id) { delete st.bans[id]; delete st.strikes[id]; save(); }
    function strikes(id) { return (st.strikes[id] || []).length; }
    function filter(ids) { return ids.filter(eligible); }
    function reset() { st = { shown: {}, strikes: {}, bans: {}, log: [] }; session.clear(); save(); }
    function stats() { prune(); return { cooldown: Object.keys(st.shown).length, banned: Object.keys(st.bans).length, struck: Object.keys(st.strikes).length, session: session.size }; }
    load();
    return { eligible, reason, markShown, skip, notInterested, unban, strikes, filter, banInfo, cooldownLeft, reset, stats, reload: load,
             get state() { return st; }, session, COOLDOWN_MS, BAN_MS, STRIKES_TO_BAN };
  }
  return { create, COOLDOWN_MS, BAN_MS, STRIKES_TO_BAN, DAY };
});
