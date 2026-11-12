// Language support for Vomix Studio.
//
// The program's texts are written in Korean. For English, this module translates what is shown on the screen:
// text nodes and a few attributes (title, aria-label, placeholder, alt), plus window.confirm / alert messages.
// A text with no translation is shown in Korean as it is, so nothing breaks when a text is missing.
// The choice is kept in localStorage ('vomix.lang'); the first time the browser language decides.
// Add another language later by making lang_xx.js (same shape as lang_en.js) and listing it in LANGS.

const LANGS = { ko: null, en: './lang_en.js' };

function pick() {
  let s = null;
  try { s = localStorage.getItem('vomix.lang'); } catch (e) { /* storage blocked */ }
  if (s && Object.prototype.hasOwnProperty.call(LANGS, s)) return s;
  const nav = ((typeof navigator !== 'undefined' && navigator.language) || 'ko').toLowerCase();
  return nav.startsWith('ko') ? 'ko' : 'en';
}

export const LANG = pick();
window.VOMIX_LANG = LANG;
document.documentElement.lang = LANG;
window.vomixTr = (s) => s;
window.vomixSetLang = (l) => {
  try { localStorage.setItem('vomix.lang', l); } catch (e) { /* ignore */ }
  setTimeout(() => location.reload(), 900);   // the project is saved 0.7 s after the last change
};

const HAN = /[가-힣]/;

if (LANGS[LANG]) {
  const mod = await import(LANGS[LANG]);
  const EXACT = new Map(Object.entries(mod.EXACT));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // "texts with {a} {b} holes" -> regular expressions; the longest fixed text is tried first
  const PATS = mod.PATTERNS.map(([ko, en]) => {
    let re = '^', weight = 0;
    const names = [];
    ko.split(/(\{[a-j]\})/).forEach((p) => {
      const m = /^\{([a-j])\}$/.exec(p);
      if (m) { names.push(m[1]); re += '([\\s\\S]*?)'; } else { re += esc(p); weight += p.length; }
    });
    return { re: new RegExp(re + '$'), names, en, weight };
  }).sort((a, b) => b.weight - a.weight);

  // a few texts that are put together from pieces in the code (count + unit, name + verb ...)
  const RULES = [
    [/^왼쪽 (\d+)$/, 'Left $1'], [/^오른쪽 (\d+)$/, 'Right $1'],
    [/^(\d+)번$/, '$1'],
    [/^(\d+)번 타격$/, '$1 hits'], [/^(\d+)개 음$/, '$1 notes'],
    [/^(\d+)개 음 · 한 줄 정리$/, '$1 notes · merged to one line'],
    [/^([\s\S]+) 보기$/, '$1: show'], [/^([\s\S]+) 내려놓기$/, '$1: put down'], [/^([\s\S]+) 들기$/, '$1: pick up'],
    [/^([\s\S]+) 삭제$/, '$1: delete'],
    [/^([\s\S]+) 라인 정지$/, '$1: stop line'], [/^([\s\S]+) 라인 재생$/, '$1: play line'],
  ];

  const cache = new Map();
  const fill = (en, caps) => en.replace(/\{([a-j])(?:\|([^|}]*)\|([^}]*))?\}/g, (m, n, one, many) => {
    const v = caps[n] === undefined ? '' : caps[n];
    if (one === undefined) return tr(v);
    return v + ' ' + (parseFloat(v) === 1 ? one : many);
  });
  const core = (c) => {
    if (EXACT.has(c)) return EXACT.get(c);
    for (const p of PATS) {
      const m = p.re.exec(c);
      if (m) { const caps = {}; p.names.forEach((n, i) => { caps[n] = m[i + 1]; }); return fill(p.en, caps); }
    }
    for (const [re, en] of RULES) {
      const m = re.exec(c);
      if (m) return en.replace(/\$(\d)/g, (x, d) => tr(m[Number(d)]));
    }
    if (c.includes('\n')) {      // several lines: every line on its own
      const ls = c.split('\n'), t = ls.map((x) => tr(x));
      if (t.some((x, i) => x !== ls[i])) return t.join('\n');
    }
    if (c.includes(' · ')) {     // "a · b · c": every piece on its own
      const pieces = c.split(' · '), t = pieces.map((x) => tr(x));
      if (t.some((x, i) => x !== pieces[i])) return t.join(' · ');
    }
    // names made of known words, like "기타 C4", "베이스 D2 ×3" or "메인 멜로디 · 음량": longest known run of words first
    const parts = c.split(/(\s+)/), words = [], seps = [];
    parts.forEach((x, i) => (i % 2 === 0 ? words : seps).push(x));
    let out = '', changed = false;
    for (let i = 0; i < words.length;) {
      let hit = -1;
      for (let j = words.length - 1; j >= i && hit < 0; j--) {
        if (!HAN.test(words.slice(i, j + 1).join(' '))) continue;
        let cand = words[i];
        for (let k = i + 1; k <= j; k++) cand += seps[k - 1] + words[k];
        if (EXACT.has(cand)) { out += EXACT.get(cand); hit = j; changed = true; }
      }
      if (hit < 0) { out += words[i]; hit = i; }
      if (hit < words.length - 1) out += seps[hit];
      i = hit + 1;
    }
    return changed ? out : c;
  };
  function tr(s) {
    if (typeof s !== 'string' || !HAN.test(s)) return s;
    if (cache.has(s)) return cache.get(s);
    const lead = s.match(/^\s*/)[0];
    const trail = s.slice(lead.length).match(/\s*$/)[0];
    const r = lead + core(s.slice(lead.length, s.length - trail.length)) + trail;
    if (cache.size > 5000) cache.clear();
    cache.set(s, r);
    return r;
  }
  window.vomixTr = tr;

  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
  const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };
  const textNode = (n) => {
    const d = n.data;
    if (HAN.test(d)) { const t = tr(d); if (t !== d) n.data = t; }
  };
  const attrs = (el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && HAN.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); }
    }
  };
  const walk = (root) => {
    if (root.nodeType === 3) { if (!root.parentNode || !SKIP[root.parentNode.nodeName]) textNode(root); return; }
    if (root.nodeType !== 1 || SKIP[root.nodeName]) return;
    attrs(root);
    for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
  };
  const run = () => {
    walk(document.body);
    new MutationObserver((list) => {
      for (const r of list) {
        if (r.type === 'characterData') { if (!r.target.parentNode || !SKIP[r.target.parentNode.nodeName]) textNode(r.target); }
        else if (r.type === 'attributes') attrs(r.target);
        else r.addedNodes.forEach(walk);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.body) run(); else document.addEventListener('DOMContentLoaded', run);

  const confirm0 = window.confirm.bind(window), alert0 = window.alert.bind(window);
  window.confirm = (m) => confirm0(tr(String(m)));
  window.alert = (m) => alert0(tr(String(m)));
}
