import { html, render, useState, useEffect, useRef, useMemo } from './vendor/htm-preact.js';
import './i18n.js';   // language support (Korean / English); window.vomixTr translates a text for the chosen language
const tx = (s) => window.vomixTr(s);   // names that are stored in Korean (default line names ...) are shown in the chosen language

let PX = 96;   // pixels per beat: set from the project's horizontal zoom at the start of every App render
const BUILD = '11/13-66';   // shown in the top bar so it is obvious whether the browser runs the newest code
let dragLib = null;   // the node-library entry that is being dragged (drag data cannot be read while dragging over)
const HEADW = 168, TAB = 12, PILLTOP = 16;
// heights that follow the vertical-size slider (set at the start of every App render); the minimums keep the
// left-hand header boxes (name, buttons, sample ...) from overflowing when the user shrinks everything
let SMALLH = 84, REFH = 64, PILLH = 52;
const MIN_LINE_H = 160, MIN_REF_H = 60;
const COLORS = ['#2dd4bf', '#a78bfa', '#f59e0b', '#f472b6', '#60a5fa', '#34d399', '#fb923c'];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (p) => NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
const sgn = (v) => (v >= 0 ? '+' : '') + v;
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const q4 = (v) => Math.round(v * 4) / 4;
const r6 = (v) => Math.round(v * 192) / 192;              // keeps fractional beats free of float drift (1/192 fits 1/3, 1/4, 1/6, 1/8, 1/12, 1/16)
const fmt = (x) => String(Math.round(x * 1000) / 1000);    // 1.5 -> "1.5", 2 -> "2", 1/16 -> "0.063"
const EPS = 1e-6;
const GRID_OPTIONS = [[1, '1박'], [0.5, '1/2박'], [1 / 3, '1/3박 (셋잇단)'], [0.25, '1/4박'], [1 / 6, '1/6박'], [0.125, '1/8박'], [1 / 12, '1/12박'], [0.0625, '1/16박'], [1 / 192, '자유 (격자 없음)']];
// a node keeps its own pitch offset (node.shift, in semitones) when its notes are rebuilt from the reference
const shifted = (ns, sh) => (sh ? ns.map((k) => ({ ...k, p: clamp(k.p + sh, 24, 96) })) : ns);
// whole beats keep the old "21~24박" wording (first~last beat); fractional ranges show start and end positions
const rangeText = (a, b) => (Number.isInteger(a) && Number.isInteger(b) ? (a + 1) + '~' + b + '박' : fmt(a + 1) + '박 ~ ' + fmt(b + 1) + '박');
// beat lines: bars, beats, and the chosen grid (--g is set on .tl from the grid setting)
const GRID_BG = 'repeating-linear-gradient(to right,rgba(120,132,150,.45) 0 1px,transparent 1px calc(var(--px)*4)),repeating-linear-gradient(to right,rgba(90,100,116,.22) 0 1px,transparent 1px var(--px)),repeating-linear-gradient(to right,rgba(90,100,116,.12) 0 1px,transparent 1px calc(var(--px)*var(--g)))';
const black = (p) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

const MODEL_LABEL = { htdemucs_6s: '소리 6개 (빠르게)', mega53: '소리 최대 53개 (정밀)' };
const modelLabel = (m) => MODEL_LABEL[m] || '소리 4개 (옛 방식)';

// Reference stems are whatever the separation model produced; names are only defaults
// (users can rename them). `poly` stems are mixes of several notes: only the loudest line is imported.
const LEGACY_META = {
  other: { name: '그 외 소리', kind: 'pitch', poly: true }, bass: { name: '베이스', kind: 'pitch' },
  drums: { name: '드럼', kind: 'drum' }, vocals: { name: '보컬', kind: 'pitch' }
};
function refDefs(ref) {
  if (!ref || !ref.lanes) return [];
  const meta = ref.meta || {};
  const keys = ref.order || Object.keys(ref.lanes);
  return keys.filter((k) => ref.lanes[k]).map((k) => {
    const m = meta[k] || LEGACY_META[k] || { name: k, kind: k === 'drums' ? 'drum' : 'pitch' };
    return { key: k, name: (ref.names && ref.names[k]) || m.name, kind: m.kind, poly: !!m.poly, count: ref.lanes[k].length };
  });
}

// ------------------------------------------------------------------ api / audio
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let m = r.statusText;
    try { m = (await r.json()).detail || m; } catch (e) { /* ignore */ }
    throw new Error(m);
  }
  return r;
}
const Ctl = { el: new Audio(), bpm: 120, startBeat: 0 };
const Prev = new Audio();
const Rng = { on: false, offset: 0, bpm: 120, ctx: null, src: null, gain: null, t0: 0, startCtx: 0, token: 0, bufs: new Map() }; // reference range preview (drives the playhead too)
const urlCache = new Map();
window.__otomad = { Ctl, Prev, Rng }; // handy for debugging in the console
async function renderUrl(payload) {
  const key = JSON.stringify(payload);
  if (urlCache.has(key)) return urlCache.get(key);
  const r = await api('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key });
  const url = URL.createObjectURL(await r.blob());
  urlCache.set(key, url);
  if (urlCache.size > 12) {
    const k = urlCache.keys().next().value;
    URL.revokeObjectURL(urlCache.get(k));
    urlCache.delete(k);
  }
  return url;
}

// mixer settings of one line (what the server's render() understands)
const mixOf = (L) => ({ vol: L.vol != null ? L.vol : 1, pan: L.pan || 0, mute: !!L.mute, solo: !!L.solo, eq: { lo: (L.eq && L.eq.lo) || 0, mid: (L.eq && L.eq.mid) || 0, hi: (L.eq && L.eq.hi) || 0 }, rev: L.rev || 0, comp: L.comp || 0, auto: !!L.auto });
const panText = (p) => (Math.abs(p) < 0.02 ? '가운데' : (p < 0 ? '왼쪽 ' : '오른쪽 ') + Math.round(Math.abs(p) * 100));
function defaultProject() {
  return {
    bpm: 120, grid: 0.25, samples: [], ref: null, lib: [], master: { vol: 1, fade_in: 0, fade_out: 0 },
    lines: [
      { id: 'L1', name: '메인 멜로디', color: COLORS[0], size: 'large', sampleId: null, nodes: [] },
      { id: 'L2', name: '베이스', color: COLORS[1], size: 'small', sampleId: null, nodes: [] }
    ]
  };
}
function toBeats(ref) {
  const f = ref.bpm / 60, off = ref.offset;
  const out = {};
  for (const [k, arr] of Object.entries(ref.lanes || {})) {
    const kind = ref.meta && ref.meta[k] ? ref.meta[k].kind : k === 'drums' ? 'drum' : 'pitch';
    out[k] = kind === 'drum'
      ? arr.map((h) => ({ t: (h.t - off) * f, k: h.k })).filter((h) => h.t > -0.5)
      : arr.map((n) => ({ t: (n.t - off) * f, l: n.l * f, p: n.p, m: n.m, a: n.a })).filter((n) => n.t > -0.5);
  }
  return out;
}

// new sounds that start inside a time span of a recording (re-hits / repeated notes that were analysed as one long note)
function findOnsets(buf, t0, t1) {
  const sr = buf.sampleRate, ch = buf.getChannelData(0), hop = Math.round(sr * 0.01), win = Math.round(sr * 0.02);
  const a = Math.max(0, Math.floor((t0 - 0.1) * sr)), b = Math.min(ch.length, Math.ceil((t1 + 0.02) * sr));
  const env = [];
  for (let p = a; p + win <= b; p += hop) { let e = 0; for (let k = p; k < p + win; k += 2) e += ch[k] * ch[k]; env.push(10 * Math.log10(e / (win / 2) + 1e-12)); }
  let peak = -120;
  for (const v of env) if (v > peak) peak = v;
  const out = [];
  let last = -9;
  for (let i = 8; i < env.length; i++) {
    const t = (a + i * hop) / sr;
    if (t < t0 + 0.09 || t > t1 - 0.03) continue;
    let lo = 1e9;
    for (let j = i - 8; j < i - 1; j++) lo = Math.min(lo, env[j]);
    if (env[i] > peak - 40 && env[i] - lo > 5 && env[i] >= env[i - 1] && t - last > 0.12) { out.push(t); last = t; }
  }
  return out;
}

// ------------------------------------------------------------------ playhead
function Playhead({ scrollRef }) {
  const [x, setX] = useState(null);
  useEffect(() => {
    let raf;
    const tick = () => {
      let beat = null;
      if (!Ctl.el.paused && !Ctl.el.ended) beat = Ctl.startBeat + (Ctl.el.currentTime * Ctl.bpm) / 60;
      else if (Rng.on && Rng.ctx) beat = ((Rng.t0 + (Rng.ctx.currentTime - Rng.startCtx) - Rng.offset) * Rng.bpm) / 60;
      if (beat != null) {
        const vx = HEADW + beat * PX;
        setX(vx);
        const sc = scrollRef.current;
        if (sc && (vx > sc.scrollLeft + sc.clientWidth - 40 || vx < sc.scrollLeft + HEADW)) sc.scrollLeft = Math.max(0, vx - HEADW - 60);
      } else setX(null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return x == null ? null : html`<div class="playhead" style=${{ left: x + 'px' }}></div>`;
}

// ------------------------------------------------------------------ sample cutter
// ------------------------------------------------------------------ mixer dock (bottom of the screen)
// one "column" = one vertical fader per line; the pan section is the last one, at the far right of the horizontally scrolling dock
const MIX_COLS = [
  { key: 'vol', label: '음량', min: 0, max: 2, step: 0.05, def: 1, fmt: (v) => Math.round(v * 100) + '%' },
  { key: 'rev', label: '리버브', min: 0, max: 1, step: 0.05, def: 0, fmt: (v) => Math.round(v * 100) + '%' },
  { key: 'comp', label: '컴프레서', min: 0, max: 1, step: 0.05, def: 0, fmt: (v) => Math.round(v * 100) + '%' },
  { key: 'eq.lo', label: 'EQ 낮은음', min: -12, max: 12, step: 1, def: 0, fmt: (v) => sgn(v) + 'dB' },
  { key: 'eq.mid', label: 'EQ 중간음', min: -12, max: 12, step: 1, def: 0, fmt: (v) => sgn(v) + 'dB' },
  { key: 'eq.hi', label: 'EQ 높은음', min: -12, max: 12, step: 1, def: 0, fmt: (v) => sgn(v) + 'dB' },
];
const PAN = { min: -1, max: 1, step: 0.1, def: 0 };
const r3 = (v) => Math.round(v * 1000) / 1000;
function getMixVal(L, key) {
  if (key.startsWith('eq.')) return (L.eq && L.eq[key.slice(3)]) || 0;
  return L[key] != null ? L[key] : (key === 'vol' ? 1 : 0);
}
function Fader({ val, min, max, step, def, fmt, label, onSet, color, title, dotOnly }) {
  return html`<div class="mixcol" title=${title || label}>
    <span class="mixval">${fmt(val)}</span>
    <button class="stepb" aria-label=${label + ' 한 칸 올리기'} onClick=${() => onSet(clamp(r3(val + step), min, max))}>▲</button>
    <input class="vfader" type="range" min=${min} max=${max} step=${step} value=${val} aria-label=${label} onInput=${(e) => onSet(Number(e.target.value))} onDblClick=${() => onSet(def)} />
    <button class="stepb" aria-label=${label + ' 한 칸 내리기'} onClick=${() => onSet(clamp(r3(val - step), min, max))}>▼</button>
    <span class="mixname" title=${label}><i class="mixdot" style=${{ background: color || '#9aa4b5' }}></i>${dotOnly ? '' : (label.length > 6 ? label.slice(0, 6) : label)}</span></div>`;
}
function MixDock({ P, setMix, setMaster, ui, resetAll, open }) {
  const mv = P.master && P.master.vol != null ? P.master.vol : 1;
  const put = (L, key, v) => setMix(L.id, key.startsWith('eq.') ? { eq: { ...(L.eq || {}), [key.slice(3)]: v } } : { [key]: v });
  return html`<div class="mixdock">
    <div class="mixhead"><b>믹서</b>
      <span class="hint">▲▼ 한 칸씩 · 막대를 두 번 누르면 처음 값 · 라인은 색 점으로 구분 (마우스를 올리면 이름) · 옆으로 밀면 오른쪽 끝에 좌우 위치</span>
      <div style=${{ flex: 1 }}></div>
      ${open && html`<button class="btn sm ghost" onClick=${resetAll}>믹서 전부 처음대로</button>`}
      <button class="btn sm" onClick=${() => ui({ mixOpen: !open })}>${open ? '▾ 접기' : '▴ 믹서 열기'}</button></div>
    ${open && html`<div class="mixbody scroll">
      <div class="mixsec mixmaster"><div class="mixt">마스터</div>
        <div class="mixcols">
          <${Fader} val=${mv} min=${0} max=${2} step=${0.05} def=${1} fmt=${(v) => Math.round(v * 100) + '%'} label="마스터" title="마스터 음량" color="#2dd4bf" onSet=${(v) => setMaster({ vol: v })} />
          <div class="mixcol" style=${{ width: '74px', justifyContent: 'center', gap: '6px' }}>
            <label class="mixfade">페이드 인<input class="chip-in" type="number" min="0" max="30" step="0.5" aria-label="페이드 인 (초)" value=${(P.master && P.master.fade_in) || 0} onChange=${(e) => setMaster({ fade_in: clamp(Number(e.target.value) || 0, 0, 30) })} /></label>
            <label class="mixfade">페이드 아웃<input class="chip-in" type="number" min="0" max="30" step="0.5" aria-label="페이드 아웃 (초)" value=${(P.master && P.master.fade_out) || 0} onChange=${(e) => setMaster({ fade_out: clamp(Number(e.target.value) || 0, 0, 30) })} /></label>
            <span class="hint" style=${{ fontSize: '10px', textAlign: 'center' }}>초</span></div>
        </div></div>
      ${MIX_COLS.map((c) => html`<div class="mixsec" key=${c.key}><div class="mixt">${c.label}</div>
        <div class="mixcols">${P.lines.map((L) => html`<${Fader} key=${L.id} val=${getMixVal(L, c.key)} min=${c.min} max=${c.max} step=${c.step} def=${c.def} fmt=${c.fmt}
          label=${L.name} dotOnly=${true} title=${L.name + ' · ' + c.label} color=${L.color} onSet=${(v) => put(L, c.key, v)} />`)}</div></div>`)}
      <div class="mixsec mixpan"><div class="mixt">좌우 위치 (왼쪽 ◀ ▶ 오른쪽)</div>
        ${P.lines.map((L) => html`<div class="panrow" key=${L.id} title=${L.name}>
          <span class="mixname" style=${{ width: '130px', fontSize: '12px', color: 'var(--text)' }} title=${L.name}><i class="mixdot" style=${{ background: L.color }}></i><span style=${{ overflow: 'hidden', textOverflow: 'ellipsis' }}>${L.name}</span></span>
          <button class="stepb" aria-label=${L.name + ' 왼쪽으로 한 칸'} onClick=${() => setMix(L.id, { pan: clamp(r3((L.pan || 0) - PAN.step), PAN.min, PAN.max) })}>◀</button>
          <input type="range" min=${PAN.min} max=${PAN.max} step=${PAN.step} style=${{ flex: 1, minWidth: '150px' }} aria-label=${L.name + ' 좌우 위치'} value=${L.pan || 0} onInput=${(e) => setMix(L.id, { pan: Number(e.target.value) })} onDblClick=${() => setMix(L.id, { pan: 0 })} />
          <button class="stepb" aria-label=${L.name + ' 오른쪽으로 한 칸'} onClick=${() => setMix(L.id, { pan: clamp(r3((L.pan || 0) + PAN.step), PAN.min, PAN.max) })}>▶</button>
          <span class="mixval" style=${{ width: '58px', textAlign: 'left' }}>${panText(L.pan || 0)}</span></div>`)}
      </div>
    </div>`}
  </div>`;
}

// ------------------------------------------------------------------ help window
const HELP = [
  { id: 'start', title: '시작하기', body: [
    ['p', '이 프로그램은 짧은 소리 조각(샘플)을 멜로디의 음높이와 길이에 맞춰 연주시키는 도구예요. 곡을 대신 만들어 주지 않고, 음을 하나하나 맞추는 번거로운 일만 대신해요.'],
    ['h', '기본 흐름'],
    ['ol', ['왼쪽 "샘플"에 소리 파일을 추가하고, "자르기"로 쓸 부분을 고릅니다.', '(선택) "참조곡"에 따라 만들고 싶은 곡을 넣으면 악기별로 나뉘어 음이 표시돼요. 만들 곡의 힌트예요.', '참조곡의 구간을 끌어서 고르고 샘플을 놓거나, "노드 모음"의 노드를 라인에 끌어다 놓아요.', '"내 라인"에서 노드를 옮기고 길이와 음을 고쳐요.', '"전체 재생"으로 들어 보고 "WAV 내보내기"로 저장해요.']],
    ['p', '작업 내용은 자동으로 저장돼요. 프로그램을 껐다 켜도 이어서 할 수 있어요.']] },
  { id: 'sample', title: '샘플', body: [
    ['p', '"소리 파일 추가"로 mp3, wav 같은 파일을 넣어요. 파일 이름이 그대로 샘플 이름이에요.'],
    ['h', '자르기'],
    ['ul', ['"자르기"를 누르면 소리 모양이 나와요. 소리 덩어리를 눌러 고르거나 끌어서 직접 구간을 정해요.', '한 번에 소리 하나(한 번 울린 소리)만 고르면 음높이가 가장 잘 맞아요.', '"이 구간 사용"은 그 샘플의 쓸 구간을 정하고, 정한 구간은 파형에서 주황색으로 보여요. "사용 구간 해제"를 누르면 처음 상태로 돌아가요.', '"잘라서 노드로 만들기"는 잘라낸 소리를 바로 노드 모음에 넣어요. 소리의 음높이가 바뀌는 곳마다 자동으로 나뉘어 음이 하나씩 생겨요. 직접 나누려면 구간 안을 Shift+클릭해 나눔 표시를 넣으세요.', '만든 노드는 원본 소리를 보정 없이 그대로 들려줘요. 음높이나 길이를 크게 바꾸면 그 음만 합성으로 맞춰요. 노드는 자기 구간을 따로 기억해서, 샘플의 쓰는 구간을 바꿔도 변하지 않아요.']],
    ['p', '샘플의 "기준음"(처음 소리의 높이)은 자동으로 찾아요. 이 음을 기준으로 다른 음높이가 만들어져요. 음높이를 찾지 못한 소리(짧은 말소리나 타격음)는 라(A3)를 기준으로 소리를 빠르게 또는 느리게 해서 음을 맞춰요.']] },
  { id: 'ref', title: '참조곡 힌트', body: [
    ['p', '참조곡은 내가 만들 곡의 모델이에요. 곡을 악기별 소리로 나누고, 각 소리에서 음을 뽑아서 보여 줘요. 이 음들은 힌트일 뿐이고, 어떻게 쓸지는 직접 정해요.'],
    ['h', '분리 정밀도'],
    ['ul', ['"빠르게": 소리 6개로 나눠요. 약 4분이 걸려요.', '"정밀하게": 소리를 최대 53개로 나눠요. 곡 길이의 약 11배가 걸려요. (프로 플랜)', '이미 넣은 곡도 "다시 분석"으로 다른 방식으로 나눌 수 있어요. 끝날 때까지 지금 결과는 그대로예요.', '분석 중에는 이 프로그램을 닫거나 컴퓨터를 끄지 마세요.']],
    ['h', '레인 보기'],
    ['ul', ['레인 이름 옆 "작게/크게"로 막대 모양과 피아노 롤 모양을 바꿔요.', '"듣기"로 그 악기 소리만 들어요. 소리가 큰 레인 8개만 먼저 켜져 있어요.', '아주 조용한 소리에서 잘못 뽑힌 음은 자동으로 빼요.']],
    ['h', '음 하나 고르기'],
    ['ul', ['레인의 음을 누르면 그 음 하나만 선택돼요. 같은 음이 이어져 있어도 따로 선택돼요.', '"이 음만 듣기"는 겹치는 다른 음을 줄여서 그 음만 들려줘요. "녹음 그대로 듣기"는 겹친 소리까지 들려요.', '"음높이만 듣기"는 단순한 소리로 그 음의 높이만 확인해요.', '같은 시간에 다른 음이 울리면 알려 주고, 옥타브나 5도 관계라 떼어 내기 어려운 음에는 "분리 어려움"이 붙어요.', '녹음에서는 소리가 여러 번 나는데 한 덩어리로 분석된 음도 경고로 알려 줘요.']]] },
  { id: 'node', title: '노드와 라인', body: [
    ['p', '노드는 "어떤 음들을 어떤 길이로 연주할지"를 담은 덩어리예요. 라인은 노드를 놓는 한 줄이에요(메인 멜로디, 베이스 등).'],
    ['h', '노드 만들기'],
    ['ul', ['참조곡 레인에서 구간을 끌어 고르고, 왼쪽 샘플을 끌어다 놓으면 그 구간의 음으로 노드가 만들어져요.', '샘플을 눌러 "든" 뒤 선택한 구간을 눌러도 돼요.', '"노드 모음"에 저장해 둔 노드는 라인으로 끌어다 놓거나, 눌러서 "선택 라인에 추가"해요.', '라인의 빈 곳을 두 번 누르면 음을 직접 추가해요.', '참조곡 레인 이름 옆의 ⧉ 버튼을 누르면 그 레인의 음 전체가 내 라인의 새 라인으로 복사돼요. 정밀 분석으로 나눈 베이스 레인을 통째로 가져올 때 좋아요. 여러 음이 섞인 레인은 아래 옵션에 따라 멜로디 후보만 가져오거나 모든 음을 가져와요.', '여러 소리가 든 잘라낸 소리(예: 야 / 임 / 마)를 참조곡 구간에 놓으면, 잘라낸 소리 전체를 그 구간에 맞춰 펴고 조각을 멜로디 음에 순서대로 배정해요. 음이 조각보다 많으면 조각 하나가 이어진 음 여러 개를 맡고, 조각이 음보다 많으면 음 하나가 이어진 조각 여러 개를 맡아요.', '참조곡에서 가져오는 음은 참조곡과 같은 높이예요. 샘플의 기준음에서 많이 멀면 소리가 부자연스러울 수 있어요. 구간 위쪽의 "섞인 레인은 멜로디 후보 한 줄만"을 끄면 피아노 같은 섞인 레인의 모든 음을 가져와요.']],
    ['h', '참조곡 구간 → 노드 모음 → 노드 편집'],
    ['ol', ['참조곡에서 구간을 끌어 고르고 왼쪽 샘플을 끌어다 놓으면 "어디에 넣을까요?" 창이 떠요. 내 라인 중 하나를 고르면 그 라인에 놓이고 노드 모음에도 자동으로 저장돼요. "노드 모음에만 넣기"를 고르면 라인에는 놓지 않고 노드 뭉치만 노드 모음에 들어가요.', '노드 모음의 뭉치를 누르면 아래에 버튼이 나와요. "노드 편집"(또는 두 번 누르기)으로 편집 창을 열어요.', '편집 창에서 뭉치 안의 노드를 하나씩 고르고 음높이, 위치, 길이를 고치거나 지워요. 끌어서 옮길 수도 있어요.', '고른 노드(또는 전부 하나씩)를 "노드 모음에 따로 저장"해서 새 항목으로 내보낼 수 있어요.', '다 만든 뭉치는 노드 모음에서 라인으로 끌어다 놓아요. 라인의 빈 곳에 놓으면 그 위치에, 라인 이름 칸에 놓으면 그 라인의 첫 빈자리에 놓여요. 라인이 화면 밖에 있으면 끈 채로 타임라인의 아래 가장자리로 가져가면 스크롤돼요.']],
    ['h', '말 박자 맞추기 (보컬, 랩, 대사)'],
    ['p', '"어디에 넣을까요?" 창 위쪽의 "말 박자에 맞추기"를 켜면, 선택한 구간의 말이 시작되는 자리(음절)마다 샘플의 소리 조각이 하나씩 놓여요. 소리 조각은 샘플을 음절 단위로 나눈 것이고, 길이는 그 음절에 맞춰져요. 음높이는 샘플 그대로라서 말의 박자만 따라 해요. 샘플 조각이 모자라면 처음부터 다시 쓰고, 한 번 켠 설정은 기억해요. 단일 음 하나만 고른 경우에는 적용되지 않아요.'],
    ['h', '노드 뭉치와 노드'],
    ['ul', ['참조곡 구간을 가져오거나 노드 모음에서 놓으면 라인에 "노드 뭉치"가 생겨요. 뭉치 안에는 음 하나(또는 목소리 한 발음)에 해당하는 "노드"가 여러 칸 들어 있어요.', '뭉치를 선택하면 뭉치 전체(위치, 길이, 전체 음높이)를 조정하고, 라인을 "크게"로 바꾸고 노드를 누르면 그 한 칸만 조정해요.', '노드 하나하나의 음높이, 위치, 길이를 따로 고쳐도 되고, Shift나 Ctrl을 누르고 여러 개를 골라 함께 고칠 수도 있어요.', '고친 노드는 "노드 모음에 저장"으로 따로 저장해 두었다가 다른 곳에 쓸 수 있어요. 뭉치 카드의 "하나씩 모음에 저장"은 뭉치 안의 모든 노드를 각각 저장해요.', '한 번 손으로 고친 뭉치는 뭉치 끝을 줄이거나 늘려도 참조곡에서 음을 다시 가져오지 않고 내가 고친 음을 그대로 둬요.']],
    ['h', '고치기'],
    ['ul', ['노드 뭉치를 끌어서 옮겨요. 다른 라인으로도 옮길 수 있어요.', '노드를 선택하면 오른쪽에서 이름, 소리, 길이, 음높이(반음, 옥타브)를 바꿔요.', '라인을 "크게" 보기로 바꾸면 음을 하나씩 끌어서 높낮이와 위치를 고칠 수 있어요.', '"이 음 앞에서 노드 쪼개기", "이 음 지우기"도 있어요.', '노드 이름은 선택하거나 마우스를 올렸을 때만 보여요.', '오른쪽 위의 "노드 뭉치 / 노드" 탭은 지금 무엇을 고치는지 보여 줘요. 노드를 고르면 "노드" 탭이 켜지고, "노드 뭉치" 탭을 누르면 뭉치 전체로 돌아가요. 뭉치를 고른 상태에서 "노드" 탭을 누르면 라인이 "크게"로 바뀌고 뭉치의 첫 노드가 열려요.', '뭉치와 노드는 각각 "노드 모음에 저장" 버튼으로 노드 모음에 넣을 수 있어요. 노드 하나는 한 칸짜리 뭉치로 저장돼요.', '노드마다 소리를 따로 정해요(노드 카드의 "소리"). 새로 놓는 노드는 그 라인에서 마지막으로 고른 소리로 시작해요. 참조곡에서 온 노드는 "참조곡의 원래 소리"를 고르면 샘플 대신 그 레인의 실제 연주가 나와요. 노드의 음높이를 바꾸면 그만큼 소리의 높이도 바뀌어요.', '노드 뭉치 카드의 "음높이 곡선" 줄에서 "곡선 편집"을 누르면 소리 전체의 음높이 흐름이 곡선으로 나와요(노드 모음의 노드 편집 창에도 같은 버튼이 있어요). 곡선을 잡고 위아래로 끌면 그 자리에 점이 생기고 주변이 부드럽게 따라와요. 점을 다시 잡아 옮기거나, 원본 선까지 끌어 놓아 지울 수 있어요. 고치지 않은 부분은 원본 소리 그대로 나와요.', '곡선 창에서 "눈금"을 ±24반음으로 바꾸면 최대 두 옥타브까지 올리고 내릴 수 있어요. 아래 소리 모양 줄을 좌우로 끌어 듣는 구간을 정하면 "구간 듣기"로 그 부분만 들어 볼 수 있어요. 점의 범위는 슬라이더나 마우스 휠로 바꿔요. 곡선은 그 소리에 저장돼서 같은 소리를 쓰는 모든 노드에 적용돼요.']],
    ['p', '라인 이름은 직접 고쳐요. "+ 라인 추가"로 라인을 늘리고, 라인 이름 옆 ✕(또는 오른쪽 "이 라인 삭제")로 지워요. 라인은 최소 1개가 있어야 해요. 무료 플랜은 3개까지예요.']] },
  { id: 'place', title: '정밀 배치와 기준선', body: [
    ['h', '노드 위치를 정확히'],
    ['ul', ['오른쪽 카드의 "시작(박째)"과 "길이(박)"에 숫자를 직접 넣어요. 0.448박 같은 값도 돼요.', '−0.1, −0.01, +0.01, +0.1 버튼으로 아주 조금씩 움직여요.', '참조곡에서 만든 노드는 "참조곡 위치에 맞추기"로 원래 위치에 되돌려요.', '위쪽 "격자"에서 "자유"를 고르면 격자 없이 움직여요. 끌 때 Alt를 눌러도 같아요.']],
    ['h', '세로 기준선'],
    ['ul', ['위쪽 박 눈금자를 누르거나 끌면 분홍색 세로선이 생겨요. 여러 라인이 같은 박자에 놓이는지 맞춰 볼 때 써요.', '오른쪽 맨 위 "세로 기준선" 카드에 그 박자에 나오는 참조 음과 내 라인의 음이 나와요.', '"＋"로 참조 음을 같은 음으로 내 라인에 넣거나, 음을 골라 "기준선에 넣기"로 직접 넣어요.', '"기준선부터 재생"으로 그 위치부터 들어요.', '노드를 끌거나 노드 모음에서 놓을 때 기준선 근처에서 자석처럼 붙어요.']]] },
  { id: 'fit', title: '길이 맞추기', body: [
    ['p', '샘플보다 긴 음을 어떻게 채울지 정해요. 라인 전체에 정하고, 노드마다 따로 바꿀 수도 있어요.'],
    ['ul', ['"늘리기": 소리를 음 길이만큼 늘려요. 목소리처럼 길게 끌 수 있는 소리에 좋아요.', '"반복하기": 음이 샘플보다 훨씬 길면(1.5배 이상) 샘플을 되풀이해서 채워요. 짧게 끝나는 소리에 좋아요.', '"원래 속도로": 소리를 늘이거나 줄이지 않고 원래 속도로 재생해요. 예를 들어 5박짜리 소리는 노드의 5박 동안 흘러가면서 그 시간에 있는 음의 높이로 바뀌고, 끝나면 처음부터 다시 이어가요. 음이 없는 곳은 조용해요. 소리 안에 음높이가 없는 부분(자음 등)은 높이가 바뀌지 않아요.', '짧은 음은 "늘리기"와 "반복하기" 어느 쪽이든 한 번만 소리 나요.']],
    ['p', '"라인 설정 따르기"를 고르면 노드가 라인의 방식을 따라가요. 노드 모음에 저장해도 이 설정이 같이 저장돼요.']] },
  { id: 'mix', title: '믹서', body: [
    ['p', '여러 라인을 한 곡으로 합칠 때의 소리를 다듬어요. 재생 중에 바꾸면 잠시 뒤 바뀐 소리로 이어서 들려요. 멈춰 있을 때는 ▶로 들어 보세요.'],
    ['h', '라인 머리의 M, S'],
    ['ul', ['M(뮤트): 그 라인 소리를 꺼요.', 'S(솔로): 솔로가 켜진 라인만 들려요. 여러 라인에 켤 수 있어요.', '라인 옆 ▶로 한 라인만 들을 때는 뮤트와 솔로에 상관없이 그 라인이 나와요.']],
    ['h', '화면 아래의 믹서'],
    ['ul', ['라인마다 세로 막대(페이더)가 있고, 항목별로 묶여 있어요. 막대 아래 색 점이 라인 색이에요(마우스를 올리면 라인 이름이 보여요). 막대를 끌거나 ▲▼로 한 칸씩 움직여요. 막대를 두 번 누르면 처음 값으로 돌아가요.', '음량: 0~200%. 라인 사이의 크기 균형을 맞춰요.', '리버브: 울림(공간감)을 더해요.', '컴프레서: 큰 소리와 작은 소리의 차이를 줄여 고르게 해요.', 'EQ: 낮은음, 중간음, 높은음을 ±12dB로 키우거나 줄여요.', '좌우 위치: 소리를 왼쪽이나 오른쪽으로 보내요. 믹서를 옆으로 밀면 맨 오른쪽 끝에 있어요. ◀ ▶로 한 칸씩 움직여요.', '"믹서 전부 처음대로"는 모든 라인과 마스터를 되돌려요. "접기"로 믹서를 접으면 작업 공간이 넓어져요.']],
    ['h', '마스터 (믹서의 맨 왼쪽)'],
    ['ul', ['마스터 음량: 최종 소리 크기예요. 100%를 넘기면 부드럽게 눌러서 소리가 깨지는 걸 줄여요.', '페이드 인, 페이드 아웃: 곡의 시작과 끝을 서서히 키우고 줄이는 시간(초)이에요.', '라인 소리를 합친 뒤 가장 큰 소리가 일정해지도록 자동으로 맞추고 나서 마스터 음량을 적용해요. 그래서 한 라인을 키우면 나머지가 상대적으로 작아져요.']]] },
  { id: 'export', title: '저장과 내보내기', body: [
    ['ul', ['작업 내용은 자동 저장돼요. 파일은 프로그램 폴더의 app/data에 있어요.', '"WAV 내보내기"는 모든 라인을 합친 스테레오 WAV 파일을 만들어요.', '컴퓨터를 옮길 때는 app/data 폴더를 복사해요.']]] },
  { id: 'keys', title: '마우스와 단축키', body: [
    ['ul', ['Ctrl + 마우스 휠: 타임라인 가로 크기', 'Alt + 마우스 휠: 모든 레인과 라인의 세로 크기', '위쪽 "가로", "세로" 슬라이더로도 같은 걸 조절해요.', 'Esc: 선택 해제 (빈 곳을 눌러도 선택이 풀려요)', '박 눈금자를 끌 때 Alt: 기준선을 격자 없이 놓기', '노드를 끌 때 기준선 근처에서는 자동으로 붙어요.', '라인의 빈 곳 두 번 누르기: 음 추가']]] },
  { id: 'plan', title: '무료와 프로', body: [
    ['p', '위쪽 "무료 플랜" 버튼에서 차이를 보고 라이선스 키를 넣을 수 있어요.'],
    ['ul', ['무료: 내 라인 3개까지, 참조곡은 기본(소리 6개) 분리', '프로: 내 라인 제한 없음, 정밀(최대 53개) 분리', '무료로 돌아와도 이미 정밀 분석한 곡은 계속 볼 수 있어요.']]] },
];
function HelpModal({ onClose }) {
  const [tab, setTab] = useState(HELP[0].id);
  const cur = HELP.find((h) => h.id === tab) || HELP[0];
  return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" style=${{ width: '860px', height: 'min(640px, 88vh)' }} role="dialog" aria-label="사용법">
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b style=${{ fontSize: '16px' }}>사용법</b>
        <button class="btn sm" onClick=${onClose}>닫기</button></div>
      <div style=${{ display: 'flex', gap: '14px', minHeight: 0, flex: 1 }}>
        <div class="scroll" style=${{ width: '170px', flex: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          ${HELP.map((h) => html`<button key=${h.id} class=${'tbtn' + (h.id === tab ? ' on' : '')} style=${{ height: '34px', flex: 'none', textAlign: 'left', padding: '0 10px', fontSize: '13px' }} onClick=${() => setTab(h.id)}>${h.title}</button>`)}
        </div>
        <div class="scroll" style=${{ flex: 1, minWidth: 0, paddingRight: '8px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px', lineHeight: 1.65 }}>
          <div style=${{ fontSize: '17px', fontWeight: 700 }}>${cur.title}</div>
          ${cur.body.map(([kind, v], i) => (kind === 'h'
            ? html`<div key=${i} class="h-label" style=${{ marginTop: '6px' }}>${v}</div>`
            : kind === 'p' ? html`<div key=${i}>${v}</div>`
            : kind === 'ol' ? html`<ol key=${i} style=${{ margin: 0, paddingLeft: '22px' }}>${v.map((t, j) => html`<li key=${j}>${t}</li>`)}</ol>`
            : html`<ul key=${i} style=${{ margin: 0, paddingLeft: '20px' }}>${v.map((t, j) => html`<li key=${j}>${t}</li>`)}</ul>`))}
        </div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ editor of one entry of the node library (a "node bundle")
function EntryEditor({ P, entryId, grid, upd, ui, sampleOf, specOf, defaultSampleId, onClose }) {
  const e = P.lib.find((x) => x.id === entryId);
  const [sel, setSel] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [msg, setMsg] = useState('');
  const range = useRef(null);
  useEffect(() => () => { if (Ctl.playingEntry) { Ctl.el.pause(); Ctl.playingEntry = false; } }, []);
  if (!e) return null;
  const ps = e.notes.map((k) => k.p);
  const lo0 = Math.min(...ps) - 1, hi0 = Math.max(...ps) + 1;
  if (!range.current || range.current.id !== entryId) range.current = { id: entryId, lo: lo0, hi: hi0 };
  range.current.lo = Math.min(range.current.lo, lo0);
  range.current.hi = Math.max(range.current.hi, hi0);
  const rows = [];
  for (let p = range.current.hi; p >= range.current.lo; p--) rows.push(p);
  const RH = 22, W = 800;
  const px = clamp(Math.floor(W / Math.max(e.l, 0.5)), 24, 260);
  const idx = sel.filter((i) => e.notes[i]);
  const edit = (fn) => upd((p) => { const x = p.lib.find((q) => q.id === entryId); fn(x); });
  const editSel = (fn) => edit((x) => { idx.forEach((i) => { if (x.notes[i]) fn(x.notes[i], x); }); });
  const pitch = (d) => editSel((k) => { k.p = clamp(k.p + d, 24, 96); });
  const move = (d) => editSel((k, x) => { k.s = clamp(r6(k.s + d), 0, Math.max(0, r6(x.l - k.l))); });
  const len = (d) => editSel((k, x) => { k.l = clamp(r6(k.l + d), 0.0625, Math.max(0.0625, r6(x.l - k.s))); });
  const toNext = () => editSel((k, x) => {
    const nx = x.notes.filter((q) => q.s > k.s + EPS && q !== k).map((q) => q.s);
    k.l = Math.max(0.0625, r6((nx.length ? Math.min(...nx) : x.l) - k.s));
  });
  const del = () => {
    if (!idx.length) return;
    if (idx.length >= e.notes.length) { setMsg('노드를 전부 지울 수는 없어요. 뭉치를 지우려면 노드 모음에서 삭제하세요'); return; }
    edit((x) => { x.notes = x.notes.filter((_, i) => !idx.includes(i)); });
    setSel([]);
  };
  const dup = () => {
    if (idx.length !== 1) return;
    const k = e.notes[idx[0]];
    const s = r6(k.s + k.l);
    if (s + k.l > e.l + EPS) { setMsg('뭉치 끝을 넘어서 복제할 수 없어요. 뭉치 길이를 먼저 늘리세요'); return; }
    edit((x) => { x.notes.push({ s, l: k.l, p: k.p }); });
    setSel([e.notes.length]);
  };
  const setLenAll = (v) => {
    if (!Number.isFinite(v)) return;
    const need = Math.max(...e.notes.map((k) => k.s + k.l));
    edit((x) => { x.l = Math.max(r6(v), r6(need), 0.0625); });
  };
  const transposeAll = (d) => edit((x) => { x.notes.forEach((k) => { k.p = clamp(k.p + d, 24, 96); }); });
  // nodes -> new entries of the library
  const entryOf = (list, name) => {
    const ns = list.map((i) => e.notes[i]).filter(Boolean).sort((x, y) => x.s - y.s);
    const a0 = ns[0].s;
    const end = Math.max(...ns.map((k) => k.s + k.l));
    const l = Math.max(grid, r6(Math.ceil((end - a0) / grid - EPS) * grid));
    return { id: uid('d'), name, l, notes: ns.map((k) => ({ s: r6(k.s - a0), l: k.l, p: k.p, ...(k.cs != null ? { cs: k.cs, ce: k.ce } : {}), ...(k.ts != null ? { ts: k.ts } : {}), ...(k.te != null ? { te: k.te } : {}) })), at: e.at != null ? r6(e.at + a0) : null, fit: e.fit || null, sampleId: e.sampleId || null };
  };
  const exportSel = () => {
    if (!idx.length) return;
    const name = idx.length === 1 ? noteName(e.notes[idx[0]].p) + ' ' + e.name : e.name + ' · 노드 ' + idx.length + '개';
    upd((p) => { p.lib.push(entryOf(idx, name)); });
    setMsg("'" + name + "' 을(를) 노드 모음에 따로 저장했어요");
  };
  const exportEach = () => {
    const n = e.notes.length;
    if (n > 24 && !window.confirm('노드 ' + n + '개를 하나씩 노드 모음에 저장할까요?')) return;
    const list = e.notes.map((k, i) => entryOf([i], noteName(k.p) + ' ' + e.name + ' ' + (i + 1)));
    upd((p) => { list.forEach((x) => p.lib.push(x)); });
    setMsg('노드 ' + n + '개를 하나씩 노드 모음에 저장했어요');
  };
  // preview
  const sid = sampleOf(e.sampleId) ? e.sampleId : defaultSampleId;
  const play = async () => {
    if (playing) { Ctl.el.pause(); Ctl.playingEntry = false; setPlaying(false); return; }
    const spec = specOf(sid);
    if (!spec) { setMsg('들어 보려면 소리(샘플)를 골라 주세요'); return; }
    try {
      setMsg('소리 만드는 중…');
      const url = await renderUrl({ bpm: P.bpm, target: 'all', master: {}, lines: [{ id: 'n', sample: spec, fit: e.fit || 'stretch', vol: 1, pan: 0, nodes: [{ s: 0, l: e.l, notes: e.notes, sample: null, fit: e.fit || null }] }] });
      Ctl.el.pause(); Ctl.bpm = P.bpm; Ctl.startBeat = 0; Ctl.el.src = url; Ctl.el.currentTime = 0;
      Ctl.playingEntry = true;
      Ctl.el.addEventListener('ended', () => { Ctl.playingEntry = false; setPlaying(false); }, { once: true });
      await Ctl.el.play();
      setPlaying(true); setMsg('');
    } catch (err) { setMsg(err.message); }
  };
  // roll: click = select (Shift / Ctrl = several), drag = pitch (up/down) and position (sideways), double click on empty space = add a node
  const pick = (ev, i) => {
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) setSel((s) => (s.includes(i) ? s.filter((q) => q !== i) : [...s, i]));
    else setSel([i]);
  };
  const down = (ev, i) => {
    if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    setSel([i]);
    const k0 = { ...e.notes[i] }, sx = ev.clientX, sy = ev.clientY, i0 = rows.indexOf(k0.p);
    let moved = false;
    const done = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', done); window.removeEventListener('blur', done); };
    const mv = (m) => {
      if (m.buttons === 0) { done(); return; }
      if (!moved && Math.abs(m.clientX - sx) < 4 && Math.abs(m.clientY - sy) < 4) return;
      moved = true;
      const p = rows[clamp(i0 + Math.round((m.clientY - sy) / RH), 0, rows.length - 1)];
      const step = m.altKey ? 1 / 192 : grid;
      const s = clamp(r6(k0.s + Math.round((m.clientX - sx) / px / step) * step), 0, Math.max(0, r6(e.l - k0.l)));
      edit((x) => { x.notes[i].p = p; x.notes[i].s = s; });
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', done); window.addEventListener('blur', done);
  };
  const addAt = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const s = clamp(r6(Math.floor((ev.clientX - r.left) / px / grid) * grid), 0, Math.max(0, r6(e.l - grid)));
    const p = rows[clamp(Math.floor((ev.clientY - r.top) / RH), 0, rows.length - 1)];
    edit((x) => { x.notes.push({ s, l: grid, p }); });
    setSel([e.notes.length]);
  };
  const first = idx.length === 1 ? e.notes[idx[0]] : null;
  const row2 = { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' };
  const bar = { display: 'flex', gap: '4px' };
  const B = ({ t, f, danger, primary, title }) => html`<button class=${'btn sm' + (danger ? ' danger' : '') + (primary ? ' primary' : '')} title=${title || ''} onClick=${f}>${t}</button>`;
  return html`<div class="modal-bg" onMouseDown=${(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
    <div class="modal" style=${{ width: '900px', height: 'min(700px, 92vh)' }} role="dialog" aria-label="노드 뭉치 편집">
      <div style=${{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <b style=${{ fontSize: '15px', flex: 'none' }}>노드 뭉치 편집</b>
        <input class="in" style=${{ flex: 1, fontWeight: 700 }} aria-label="노드 뭉치 이름" value=${tx(e.name)} onInput=${(ev) => edit((x) => { x.name = ev.target.value; })} />
        <button class="btn sm" onClick=${onClose}>닫기</button></div>
      <div style=${row2}>
        <label class="hint">소리 <select class="in" style=${{ width: '200px', padding: '4px 6px', fontSize: '12px' }} value=${e.sampleId || defaultSampleId || ''} onChange=${(ev) => edit((x) => { x.sampleId = ev.target.value || null; })}>
          ${soundOptions(P, e.sampleId || defaultSampleId)}</select></label>
        ${sampleOf(sid) && sampleOf(sid).sel && html`<button class="btn sm" title="소리의 음높이 흐름을 마우스로 잡아당겨 고쳐요" onClick=${() => { Ctl.el.pause(); Ctl.playingEntry = false; setPlaying(false); ui({ pitchEdit: sid }); }}>${sampleOf(sid).bend && sampleOf(sid).bend.length ? `음높이 곡선 · 점 ${sampleOf(sid).bend.length}개` : '음높이 곡선 편집'}</button>`}
        <label class="hint">길이 맞추기 <select class="in" style=${{ width: '150px', padding: '4px 6px', fontSize: '12px' }} value=${e.fit || ''} onChange=${(ev) => edit((x) => { if (ev.target.value) x.fit = ev.target.value; else delete x.fit; })}>
          <option value="">라인 설정 따르기</option><option value="stretch">늘리기</option><option value="repeat">반복하기</option><option value="keep">원래 속도로</option></select></label>
        <label class="hint">뭉치 길이(박) <input class="chip-in" type="number" step="0.25" min="0.0625" style=${{ width: '74px' }} key=${'el' + e.l} defaultValue=${fmt(e.l)} onChange=${(ev) => setLenAll(Number(ev.target.value))} /></label>
        <${B} primary=${true} t=${playing ? '■ 멈춤' : '▶ 듣기'} f=${play} />
        <span class="hint">전체 음높이</span><${B} t="↓" f=${() => transposeAll(-1)} title="뭉치 전체 반음 내리기" /><${B} t="↑" f=${() => transposeAll(1)} title="뭉치 전체 반음 올리기" /><${B} t="옥타브↓" f=${() => transposeAll(-12)} /><${B} t="옥타브↑" f=${() => transposeAll(12)} />
      </div>
      <div class="scroll" style=${{ flex: 'none', maxHeight: '250px', border: '1px solid var(--line)', borderRadius: '8px', background: 'var(--panel)' }}>
        <div style=${{ position: 'relative', width: e.l * px + 'px', minWidth: '100%', height: rows.length * RH + 'px', backgroundImage: 'repeating-linear-gradient(to right,rgba(120,132,150,.35) 0 1px,transparent 1px ' + px + 'px),repeating-linear-gradient(to bottom,transparent 0 ' + (RH - 1) + 'px,#20252d ' + (RH - 1) + 'px ' + RH + 'px)' }}
          onDblClick=${addAt} title="빈 곳을 두 번 누르면 노드가 추가돼요">
          ${rows.map((p, r) => ([1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12) ? html`<div key=${'k' + p} style=${{ position: 'absolute', left: 0, right: 0, top: r * RH + 'px', height: RH + 'px', background: 'rgba(0,0,0,.2)', pointerEvents: 'none' }}></div>` : null))}
          ${e.notes.map((k, i) => html`<button key=${i} class=${'note' + (idx.includes(i) ? ' sel' : '')} aria-label=${noteName(k.p) + ' ' + fmt(k.l) + '박'}
            onMouseDown=${(ev) => down(ev, i)} onClick=${(ev) => pick(ev, i)} onDblClick=${(ev) => ev.stopPropagation()}
            style=${{ left: k.s * px + 1 + 'px', top: rows.indexOf(k.p) * RH + 2 + 'px', height: RH - 4 + 'px', width: Math.max(4, k.l * px - 2) + 'px', background: '#2dd4bf', fontSize: '10px' }}>${noteName(k.p)}</button>`)}
        </div>
      </div>
      <div class="hint">${`노드를 누르면 고르고(Shift나 Ctrl을 누르면 여러 개), 위아래로 끌면 음높이, 옆으로 끌면 위치가 바뀌어요 (Alt: 격자 무시). ${e.notes.length}개 · ${fmt(e.l)}박`}</div>
      <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0, overflowY: 'auto' }} class="scroll">
        <div style=${row2}><b class="hint" style=${{ width: '86px' }}>${`고른 노드 ${idx.length ? idx.length + '개' : '(없음)'}`}</b>
          ${idx.length > 0 && html`<span style=${bar}><${B} t="반음 ↓" f=${() => pitch(-1)} /><${B} t="반음 ↑" f=${() => pitch(1)} /><${B} t="옥타브 ↓" f=${() => pitch(-12)} /><${B} t="옥타브 ↑" f=${() => pitch(12)} /></span>
          ${first && html`<label class="hint">시작(뭉치 안, 박) <input class="chip-in" type="number" step="0.01" style=${{ width: '78px' }} key=${'es' + idx[0] + first.s + msg} defaultValue=${fmt(first.s)} onChange=${(ev) => { const v = Number(ev.target.value); if (Number.isFinite(v)) editSel((k, x) => { k.s = clamp(r6(v), 0, Math.max(0, r6(x.l - k.l))); }); }} /></label>
            <label class="hint">길이(박) <input class="chip-in" type="number" step="0.01" min="0.06" style=${{ width: '78px' }} key=${'ee' + idx[0] + first.l + msg} defaultValue=${fmt(first.l)} onChange=${(ev) => { const v = Number(ev.target.value); if (Number.isFinite(v)) editSel((k, x) => { k.l = clamp(r6(v), 0.0625, Math.max(0.0625, r6(x.l - k.s))); }); }} /></label>`}`}
        </div>
        ${idx.length > 0 && html`<div style=${row2}><span class="hint" style=${{ width: '86px' }}>위치 미세 이동</span><span style=${bar}><${B} t="−0.1" f=${() => move(-0.1)} /><${B} t="−0.01" f=${() => move(-0.01)} /><${B} t="+0.01" f=${() => move(0.01)} /><${B} t="+0.1" f=${() => move(0.1)} /></span>
          <span class="hint" style=${{ marginLeft: '12px' }}>길이</span><span style=${bar}><${B} t="−0.1" f=${() => len(-0.1)} /><${B} t="−0.01" f=${() => len(-0.01)} /><${B} t="+0.01" f=${() => len(0.01)} /><${B} t="+0.1" f=${() => len(0.1)} /><${B} t=${fmt(grid) + '박 짧게'} f=${() => len(-grid)} /><${B} t=${fmt(grid) + '박 길게'} f=${() => len(grid)} /><${B} t="다음 노드 앞까지" f=${toNext} /></span></div>
          <div style=${row2}><${B} primary=${true} t=${idx.length > 1 ? '고른 노드 ' + idx.length + '개를 노드 모음에 따로 저장' : '이 노드를 노드 모음에 따로 저장'} f=${exportSel} />
            ${idx.length === 1 && html`<${B} t="한 칸 뒤에 복제" f=${dup} />`}<${B} danger=${true} t="지우기" f=${del} /></div>`}
        <div style=${row2}><${B} t=${'뭉치 안의 노드 ' + e.notes.length + '개를 하나씩 노드 모음에 저장'} f=${exportEach} />
          <${B} t="모두 선택" f=${() => setSel(e.notes.map((_, i) => i))} /><${B} t="선택 해제" f=${() => setSel([])} /></div>
        ${msg && html`<div class="notice">${msg}</div>`}
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ "where should it go?" after a sample was dropped on a reference range
function DropChooser({ P, choice, selLineId, onPick, onClose, onRhythm, onRhythmPitch }) {
  return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" style=${{ width: '460px' }} role="dialog" aria-label="어디에 넣을까요">
      <b style=${{ fontSize: '16px' }}>어디에 넣을까요?</b>
      <div class="hint">${`'${choice.file}' 소리로 만든`} <b>${choice.name}</b> ${`· 노드 ${choice.count}개 · ${fmt(choice.l)}박`}</div>
      <label style=${{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', padding: '6px 8px', border: '1px solid ' + (choice.rhythm ? 'var(--accent)' : 'var(--line)'), borderRadius: '8px' }} title="보컬이나 랩의 음절 시작 위치마다 샘플의 소리 조각을 하나씩 놓아요">
        <input type="checkbox" checked=${!!choice.rhythm} onChange=${(e) => onRhythm(e.target.checked)} style=${{ marginTop: '3px' }} />
        <span><b>말 박자에 맞추기</b> <span class="hint">(음절 단위)</span><br /><span class="hint">구간의 말(보컬, 랩)이 시작되는 자리마다 샘플의 소리 조각을 하나씩 놓고, 길이도 그 음절에 맞춰요. 샘플 조각이 모자라면 처음부터 다시 써요.</span></span></label>
      ${choice.rhythm && html`<label style=${{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '0 8px 0 28px' }}>
        <input type="checkbox" checked=${choice.pitch !== false} onChange=${(e) => onRhythmPitch(e.target.checked)} />
        <span><b>음높이도 참조곡 보컬에 맞추기</b> <span class="hint">(끄면 샘플 음높이 그대로)</span></span></label>`}
      <div class="h-label">내 라인에 놓기 <span style=${{ fontWeight: 400, color: 'var(--dim)' }}>(노드 모음에도 자동으로 저장돼요)</span></div>
      <div style=${{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        ${P.lines.map((L) => html`<button key=${L.id} class=${'btn' + (L.id === selLineId ? ' primary' : '')} style=${{ display: 'flex', alignItems: 'center', gap: '8px', textAlign: 'left' }} onClick=${() => onPick(L.id)}>
          <i style=${{ width: '10px', height: '10px', borderRadius: '50%', background: L.color, flex: 'none' }}></i><span style=${{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${L.name}</span>
          <span style=${{ fontWeight: 400, opacity: 0.8, fontSize: '12px' }}>${`노드 뭉치 ${L.nodes.length}개`}</span></button>`)}
      </div>
      <div class="h-label">라인에는 놓지 않고</div>
      <button class="btn" onClick=${() => onPick('lib')}>노드 모음에만 넣기 <span style=${{ fontWeight: 400, opacity: 0.8, fontSize: '12px' }}>(노드 뭉치만 저장)</span></button>
      ${choice.err && html`<div class="notice">${choice.err}</div>`}
      <div style=${{ display: 'flex', justifyContent: 'flex-end' }}><button class="btn ghost" onClick=${onClose}>취소</button></div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ plan (free / pro)
const FREE_DEFAULT = { plan: 'free', owner: '', limits: { name: '무료', max_lines: 3, precise_hints: false }, all: {} };
function PlanModal({ plan, onClose, onChange, notice }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const pro = plan.plan === 'pro';
  const free = (plan.all && plan.all.free) || FREE_DEFAULT.limits;
  const lim = (n) => (n == null ? '무제한' : n + '개');
  const send = async (path, body) => {
    try {
      const r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      onChange(await r.json());
      setMsg(path.endsWith('activate') ? '프로 플랜이 켜졌어요' : '무료 플랜으로 돌아왔어요');
      setKey('');
    } catch (e) { setMsg(e.message); }
  };
  const cell = { padding: '8px 10px', borderTop: '1px solid var(--line)', fontSize: '13px' };
  return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" style=${{ width: '560px' }} role="dialog" aria-label="플랜">
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b style=${{ fontSize: '16px' }}>플랜</b><span class="hint">지금: <b>${pro ? '프로' : '무료'}</b>${pro && plan.owner ? ' · ' + plan.owner : ''}</span></div>
      ${notice && html`<div class="notice">${notice}</div>`}
      <div style=${{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', background: 'var(--card)', borderRadius: '8px', overflow: 'hidden' }}>
        <div style=${{ padding: '8px 10px', fontSize: '12px', color: 'var(--sub)' }}>기능</div>
        <div style=${{ padding: '8px 10px', fontSize: '12px', color: 'var(--sub)' }}>${`무료${!pro ? ' (지금)' : ''}`}</div>
        <div style=${{ padding: '8px 10px', fontSize: '12px', color: 'var(--accent-text)' }}>${`프로${pro ? ' (지금)' : ''}`}</div>
        <div style=${cell}>내 라인 개수</div><div style=${cell}>${lim(free.max_lines)}</div><div style=${cell}>무제한</div>
        <div style=${cell}>참조곡 힌트</div><div style=${cell}>기본 (소리 6개로 나눔)</div><div style=${cell}>정밀 (최대 53개로 나눔)</div>
        <div style=${cell}>그 밖의 모든 기능</div><div style=${cell}>같음</div><div style=${cell}>같음</div>
      </div>
      <div class="hint">이미 정밀하게 분석해 둔 곡은 무료로 돌아와도 계속 볼 수 있어요. 새로 정밀 분석하거나 라인을 더 만드는 것만 막혀요.</div>
      <label class="h-label" for="lic">라이선스 키</label>
      <div style=${{ display: 'flex', gap: '8px' }}>
        <input id="lic" class="in" placeholder="OTM2.…" value=${key} onInput=${(e) => setKey(e.target.value)} />
        <button class="btn primary" disabled=${!key.trim()} onClick=${() => send('/api/plan/activate', { key })}>켜기</button></div>
      ${msg && html`<div class="notice">${msg}</div>`}
      <div class="hint" style=${{ fontSize: '11.5px', lineHeight: 1.5 }}>정밀 분석에 쓰는 53개 소리 분리 모델(MVSep Mega 53 stems, BS-RoFormer)은 만든 사람 ZFTurbo가 MIT 라이선스로 공개한 것이에요. 학습에 쓴 음원의 저작권을 모두 갖고 있지는 않다고 밝혔고, 보증 없이 "있는 그대로" 제공돼요. 이 프로그램은 모델을 학습하거나 고치지 않고 내 컴퓨터에서 실행만 해요. 사용 권리가 있는 곡만 분석해 주세요. 자세한 라이선스는 설치 폴더의 THIRD_PARTY_NOTICES.txt에 있어요.</div>
      <div style=${{ display: 'flex', justifyContent: 'space-between' }}>
        ${pro && !plan.forced ? html`<button class="btn sm ghost" onClick=${() => send('/api/plan/deactivate')}>이 컴퓨터에서 라이선스 끄기</button>` : html`<span></span>`}
        <button class="btn" onClick=${onClose}>닫기</button></div>
    </div>
  </div>`;
}

// notes rebuilt from the reference song keep handing out the pieces of the cut in order
// The choices for "which sound": only the samples (the cut pieces made while trying things out would be far too many to choose from).
// A cut piece that is the current choice is still shown, so the list always matches what the node uses.
function soundOptions(P, cur, refLane) {
  const base = P.samples.filter((x) => !x.piece);
  // the sounds that the entries of the Node Library use (cut pieces) can be chosen too
  const seen = new Set(base.map((x) => x.id));
  const lib = [];
  (P.lib || []).forEach((d) => {
    if (d.sampleId && d.sampleId !== 'ref' && !seen.has(d.sampleId) && P.samples.some((x) => x.id === d.sampleId)) { seen.add(d.sampleId); lib.push(d); }
  });
  const curPiece = cur && cur !== 'ref' && !seen.has(cur) ? P.samples.find((x) => x.id === cur && x.piece) : null;
  return html`${refLane && html`<option value="ref">${'참조곡의 원래 소리 (' + refLane + ' 레인)'}</option>`}
    <optgroup label="샘플">${base.map((x) => html`<option value=${x.id} key=${x.id}>${x.file}</option>`)}</optgroup>
    ${lib.length > 0 && html`<optgroup label="노드 모음의 소리">${lib.map((d) => html`<option value=${d.sampleId} key=${d.sampleId}>${d.name}</option>`)}</optgroup>`}
    ${curPiece && html`<optgroup label="지금 쓰는 조각"><option value=${curPiece.id}>${curPiece.label || curPiece.file}</option></optgroup>`}`;
}
// Every node has a sound of its own. A line only remembers the sound used last, which new nodes on it start with
// (this also gives old projects, where nodes followed a "line default", an explicit sound on each node).
function fixSounds(p) {
  const first = (p.samples || []).find((x) => !x.piece);
  (p.lines || []).forEach((L) => {
    if (!L.sampleId || !(p.samples || []).some((x) => x.id === L.sampleId)) L.sampleId = first ? first.id : null;
    (L.nodes || []).forEach((n) => {
      if (!n.sampleId) n.sampleId = L.sampleId;
      // a note's own sound that no longer exists is dropped (the note then follows the bundle's sound)
      (n.notes || []).forEach((k) => { if (k.sampleId && !(k.sampleId === 'ref' ? n.src && p.ref : (p.samples || []).some((x) => x.id === k.sampleId))) delete k.sampleId; });
    });
  });
  return p;
}
// cut pieces nothing uses any more (left over from trying things out) are dropped when the project is opened
function pruneSamples(p) {
  const used = new Set();
  (p.lines || []).forEach((L) => { if (L.sampleId) used.add(L.sampleId); (L.nodes || []).forEach((n) => { if (n.sampleId) used.add(n.sampleId); (n.notes || []).forEach((k) => { if (k.sampleId) used.add(k.sampleId); }); }); });
  (p.lib || []).forEach((d) => { if (d.sampleId) used.add(d.sampleId); });
  p.samples = (p.samples || []).filter((x) => !x.piece || used.has(x.id));
  return p;
}

// The whole cut is laid along the whole melody range (stretched or squeezed to fit) and the pieces (ya / im / ma) are matched to
// the notes by position: with more notes than pieces a piece holds several notes in a row (do~ / re mi -> ya / a),
// with more pieces than notes a note takes several pieces in a row. Notes are taken in time order (the notes of a lane are
// not always listed in that order).
function assignPieces(ns, pieces) {
  const order = ns.map((_, i) => i).sort((a, b) => ns[a].s - ns[b].s || a - b);
  const N = order.length, P = pieces.length;
  const out = ns.map((k) => ({ ...k }));
  const give = (r, a, b) => { out[order[r]].cs = a; out[order[r]].ce = b; };
  const whole = [pieces[0].cs, pieces[P - 1].ce];
  if (N === 1) { give(0, whole[0], whole[1]); return out; }
  if (P === 1) { order.forEach((_, r) => give(r, pieces[0].cs, pieces[0].ce)); return out; }
  const st = (r) => ns[order[r]].s, en = (r) => ns[order[r]].s + ns[order[r]].l;
  const s0 = Math.min(...order.map((_, r) => st(r))), s1 = Math.max(...order.map((_, r) => en(r)));
  const nb = []; for (let r = 0; r < N - 1; r++) nb.push((((en(r) + st(r + 1)) / 2) - s0) / Math.max(1e-6, s1 - s0));   // where note r ends, 0..1
  const pb = []; for (let j = 0; j < P - 1; j++) pb.push((pieces[j].ce - whole[0]) / Math.max(1e-6, whole[1] - whole[0]));       // where piece j ends, 0..1
  const pick = (target, arr, lo, hi, prev) => {
    let best = Math.max(lo, prev + 1), bd = Infinity;
    for (let k = Math.max(lo, prev + 1); k <= hi; k++) { const d = Math.abs(arr[k] - target); if (d < bd) { bd = d; best = k; } }
    return best;
  };
  if (N >= P) {
    let prev = -1, first = 0;
    for (let j = 0; j < P; j++) {
      const k = j < P - 1 ? pick(pb[j], nb, j, N - P + j, prev) : N - 1;   // last note that piece j holds
      for (let r = first; r <= k; r++) give(r, pieces[j].cs, pieces[j].ce);
      first = k + 1; prev = k;
    }
  } else {
    let prev = -1, first = 0;
    for (let r = 0; r < N; r++) {
      const m = r < N - 1 ? pick(nb[r], pb, r, P - N + r, prev) : P - 1;   // last piece that note r takes
      give(r, pieces[first].cs, pieces[m].ce);
      first = m + 1; prev = m;
    }
  }
  return out;
}
function applyPieces(nd, ns) {
  return nd.pieces && nd.pieces.length ? assignPieces(ns, nd.pieces) : ns;
}

function SampleModal({ sample, onClose, onApply, onMakeNode, onRelease }) {
  const cv = useRef(null);
  const box = useRef(null);
  const [sel, setSel] = useState(sample.sel ? { start: sample.sel.start, end: sample.sel.end } : null);
  const [marks, setMarks] = useState([]);   // split points inside the chosen range (Shift+click): one note per piece
  const drag = useRef(null);
  const dur = sample.duration;
  const wrap = useRef(null);
  // zoom: a long sample starts zoomed so that about 10 seconds fill the window; the window scrolls sideways
  const [zoom, setZoom] = useState(() => Math.max(1, Math.min(20, Math.round((dur / 10) * 2) / 2)));
  const [hp, setHp] = useState(null);   // fine peaks of the whole sample (the stored ones are too coarse to zoom into)
  const bufRef = useRef(null), srcRef = useRef(null), ctxRef = useRef(null);   // the decoded sample: the preview plays exactly the chosen range
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const buf = await (await fetch('/api/samples/' + encodeURIComponent(sample.file) + '/audio')).arrayBuffer();
        const ab = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
        bufRef.current = ab;
        const ch = ab.getChannelData(0), nb = Math.max(700, Math.min(30000, Math.round(dur * 500)));
        const pk = new Array(nb).fill(0), per = ch.length / nb;
        for (let i = 0; i < nb; i++) {
          let m = 0;
          for (let j = Math.floor(i * per), e = Math.min(ch.length, Math.floor((i + 1) * per)); j < e; j++) { const v = Math.abs(ch[j]); if (v > m) m = v; }
          pk[i] = m;
        }
        if (!dead) setHp(pk);
      } catch (e) { /* the stored peaks are used */ }
    })();
    return () => { dead = true; };
  }, [sample.file]);
  const keepAt = useRef(null);
  const zoomTo = (z, clientX) => {
    const w = wrap.current;
    z = Math.max(1, Math.min(60, z));
    if (!w || z === zoom) return;
    const r = w.getBoundingClientRect(), px = clientX != null ? clientX - r.left : r.width / 2;
    keepAt.current = { t: ((w.scrollLeft + px) / (w.clientWidth * zoom)) * dur, px };
    setZoom(z);
  };
  useEffect(() => {
    const w = wrap.current, k = keepAt.current;
    if (!w) return;
    if (k) { w.scrollLeft = (k.t / dur) * w.clientWidth * zoom - k.px; keepAt.current = null; }
  }, [zoom]);
  useEffect(() => {   // first view: show the chosen range
    const w = wrap.current;
    if (w && sel) w.scrollLeft = Math.max(0, (sel.start / dur) * w.clientWidth * zoom - 40);
  }, []);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const CW = Math.min(30000, Math.round(1400 * zoom));
    c.width = CW; c.height = 260;
    const g = c.getContext('2d');
    g.clearRect(0, 0, CW, 260);
    const pk = hp || sample.peaks;
    const n = pk.length;
    let mx = 0.001;
    for (let i = 0; i < n; i++) if (pk[i] > mx) mx = pk[i];
    const us = sample.used && sample.sel ? sample.sel : null;   // the range in use gets its own colour
    const bw = Math.max(1, CW / n);
    for (let i = 0; i < n; i++) {
      const h = (pk[i] / mx) * 240, t = ((i + 0.5) / n) * dur;
      g.fillStyle = us && t >= us.start && t <= us.end ? '#ffa94d' : '#7d8bff';
      g.fillRect((i / n) * CW, 130 - h / 2, bw > 3 ? bw - 1 : bw, Math.max(2, h));
    }
  }, [sample.id, sample.used, sample.sel && sample.sel.start, sample.sel && sample.sel.end, zoom, hp]);
  useEffect(() => () => { Prev.pause(); try { if (srcRef.current) srcRef.current.stop(); if (ctxRef.current) ctxRef.current.close(); } catch (e) { /* already stopped */ } }, []);
  // back to the sound piece that was chosen when the sample was added (the first usable one)
  const release = () => {
    const sg = sample.segments.find((q) => q.root != null && q.end - q.start >= 0.12 && q.end - q.start <= 1.5) || sample.segments[0];
    if (!sg) return;
    setSel({ start: sg.start, end: sg.end });
    onRelease(sg);
  };
  const tAt = (e) => {
    const r = box.current.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / r.width) * dur, 0, dur);
  };
  const down = (e) => {
    const t = tAt(e);
    if (e.shiftKey) {
      if (!sel || t <= sel.start || t >= sel.end) return;
      const tol = (6 / box.current.getBoundingClientRect().width) * dur;
      setMarks((m) => (m.some((x) => Math.abs(x - t) < tol) ? m.filter((x) => Math.abs(x - t) >= tol) : [...m, t].sort((a, b) => a - b)));
      return;
    }
    setMarks([]);
    drag.current = { a: t, moved: false, x0: e.clientX };
    const move = (ev) => {
      const w = wrap.current;
      if (w) { const r = w.getBoundingClientRect(); if (ev.clientX > r.right - 30) w.scrollLeft += 24; else if (ev.clientX < r.left + 30) w.scrollLeft -= 24; }
      const t2 = tAt(ev);
      if (drag.current.moved || Math.abs(ev.clientX - drag.current.x0) > 3) {
        drag.current.moved = true;
        setSel({ start: Math.min(drag.current.a, t2), end: Math.max(drag.current.a, t2) });
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!drag.current.moved) {
        const s = sample.segments.find((sg) => drag.current.a >= sg.start && drag.current.a <= sg.end);
        if (s) setSel({ start: s.start, end: s.end });
      }
      drag.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const preview = async () => {
    if (!sel) return;
    Prev.pause();
    if (bufRef.current) {   // sample-accurate: the audio element only reports its position a few times a second, so it ran past the end of a short range
      try {
        if (srcRef.current) { srcRef.current.onended = null; srcRef.current.stop(); srcRef.current = null; }
        if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        if (ctxRef.current.state === 'suspended') await ctxRef.current.resume();
        const src = ctxRef.current.createBufferSource();
        src.buffer = bufRef.current;
        src.connect(ctxRef.current.destination);
        src.start(0, sel.start, Math.max(0.005, sel.end - sel.start));
        srcRef.current = src;
        return;
      } catch (e) { /* fall back to the audio element below */ }
    }
    Prev.src = '/api/samples/' + encodeURIComponent(sample.file) + '/audio';
    const go = () => { Prev.currentTime = sel.start; Prev.play(); };
    Prev.onloadedmetadata = go;
    Prev.ontimeupdate = () => { if (Prev.currentTime >= sel.end) { Prev.pause(); } };
    if (Prev.readyState >= 1) go();
  };
  return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" role="dialog" aria-label="샘플 자르기">
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b style=${{ fontSize: '15px' }}>${`샘플 자르기 · ${sample.file}`}</b>
        <span class="hint">${`${dur.toFixed(2)}초`}</span>
      </div>
      <div class="hint">소리 덩어리를 눌러 고르거나, 끌어서 원하는 구간을 직접 정하세요. 한 번에 소리 하나(한 번 울린 소리)만 고르면 피치가 가장 잘 맞아요.</div>
      <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span class="hint">확대</span>
        <button class="tbtn" aria-label="축소" onClick=${() => zoomTo(zoom / 1.5)} disabled=${zoom <= 1}>－</button>
        <input type="range" min="1" max="60" step="0.5" value=${zoom} aria-label="파장 확대 배율" style=${{ width: '160px' }} onInput=${(e) => zoomTo(Number(e.target.value))} />
        <button class="tbtn" aria-label="확대" onClick=${() => zoomTo(zoom * 1.5)} disabled=${zoom >= 60}>＋</button>
        <span class="hint">${`×${zoom % 1 ? zoom.toFixed(1) : zoom}`}</span>
        <button class="tbtn" onClick=${() => zoomTo(1)} disabled=${zoom <= 1}>전체 보기</button>
        <span class="hint">Ctrl + 마우스 휠로 확대·축소, 마우스 휠로 좌우 이동</span>
      </div>
      <div ref=${wrap} style=${{ overflowX: zoom > 1 ? 'auto' : 'hidden', overflowY: 'hidden' }} onWheel=${(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomTo(zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX); } else if (zoom > 1 && wrap.current) { e.preventDefault(); wrap.current.scrollLeft += e.deltaY + e.deltaX; } }}>
      <div class="wave" ref=${box} onMouseDown=${down} style=${{ width: zoom * 100 + '%' }}>
        <canvas ref=${cv}></canvas>
        ${(() => { const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]; const st = steps.find((x) => (x / dur) * 760 * zoom >= 70) || 300; const out = []; for (let t = 0; t <= dur + 1e-6; t += st) out.push(t); return out.map((t) => html`<div key=${'k' + t} style=${{ position: 'absolute', bottom: 0, left: (t / dur) * 100 + '%', height: '8px', borderLeft: '1px solid #4a5566', pointerEvents: 'none' }}><span style=${{ position: 'absolute', bottom: '8px', left: '2px', fontSize: '10px', color: '#8b95a7', whiteSpace: 'nowrap' }}>${(Math.round(t * 100) / 100) + '초'}</span></div>`); })()}
        ${sample.segments.map((sg, i) => html`<div class="segb" key=${i} style=${{ left: (sg.start / dur) * 100 + '%', width: ((sg.end - sg.start) / dur) * 100 + '%' }}></div>`)}
        ${sel && html`<div class="picked" style=${{ left: (sel.start / dur) * 100 + '%', width: ((sel.end - sel.start) / dur) * 100 + '%', minWidth: '3px', boxSizing: 'border-box' }}></div>`}
        ${marks.map((m) => html`<div key=${m} style=${{ position: 'absolute', top: 0, bottom: 0, width: '2px', background: '#ff5c8a', left: (m / dur) * 100 + '%', pointerEvents: 'none' }}></div>`)}
      </div>
      </div>
      <div class="hint">"잘라서 노드로 만들기"는 소리의 음높이가 바뀌는 곳마다 자동으로 나눠 음을 하나씩 만들어요. 직접 나누려면 구간 안을 Shift+클릭해 나눔 표시를 넣으세요 (다시 Shift+클릭하면 지워져요).</div>
      <div class="hint">${sel ? `선택: ${sel.start.toFixed(3)} ~ ${sel.end.toFixed(3)}초 (${(sel.end - sel.start).toFixed(3)}초)` : '구간을 골라 주세요'}</div>
      ${sample.used && sample.sel && html`<div class="hint" style=${{ color: '#ffa94d' }}>${`주황색 = 지금 쓰는 구간: ${sample.sel.start.toFixed(2)} ~ ${sample.sel.end.toFixed(2)}초`}</div>`}
      <div style=${{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button class="btn" onClick=${preview} disabled=${!sel}>미리 듣기</button>
        <button class="btn ghost" onClick=${onClose}>취소</button>
        ${sample.used && html`<button class="btn" onClick=${release}>사용 구간 해제</button>`}
        <button class="btn" disabled=${!sel || sel.end - sel.start < 0.012} onClick=${() => onApply(sel)}>이 구간 사용</button>
        <button class="btn primary" disabled=${!sel || sel.end - sel.start < 0.012} onClick=${() => onMakeNode(sel, marks)}>잘라서 노드로 만들기</button>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ export for other programs
function ExportModal({ busy, onClose, onMake }) {
  const [o, setO] = useState({ midi: true, csv: true, lines: true, mix: true });
  const row = (k, title, hint) => html`<label style=${{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' }}>
    <input type="checkbox" checked=${o[k]} onChange=${(e) => setO({ ...o, [k]: e.target.checked })} style=${{ marginTop: '3px' }} />
    <span><b>${title}</b><br /><span class="hint">${hint}</span></span></label>`;
  return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div class="modal" role="dialog" aria-label="다른 프로그램용 내보내기" style=${{ width: 'min(560px, 96vw)' }}>
      <b style=${{ fontSize: '15px' }}>다른 프로그램용 내보내기</b>
      <div class="hint">영상 편집기나 음악 프로그램에서 이어서 작업할 수 있게, 아래 파일을 zip 하나로 묶어 내보내요. 모든 파일의 0초는 곡의 시작(1박째)이에요.</div>
      ${row('midi', 'MIDI 파일 (song.mid)', '라인마다 트랙 하나, 트랙 이름은 라인 이름이에요. 곡 BPM이 템포로 들어가고, 노드의 소리 크기는 벨로시티가 돼요. 자른 구간은 반영돼요.')}
      ${row('csv', '음 목록 (notes.csv)', '모든 음의 시작과 길이(박, 초), 음높이, 쓰는 소리, 남긴 구간이에요. MIDI에 담기지 않는 정보(어떤 소리를 쓰는지)를 여기서 봐요.')}
      ${row('lines', '라인별 소리 (lines 폴더의 WAV)', '라인 하나씩의 소리예요. 그 라인의 볼륨, 팬, 효과가 적용돼요.')}
      ${row('mix', '곡 전체 소리 (mix.wav)', '"WAV 내보내기"와 같은 소리예요.')}
      <div class="hint">라인과 곡이 길면 소리를 만드는 데 시간이 걸려요(라인마다 몇 초).</div>
      <div style=${{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button class="btn ghost" disabled=${busy} onClick=${onClose}>닫기</button>
        <button class="btn primary" disabled=${busy || !(o.midi || o.csv || o.lines || o.mix)} onClick=${() => onMake(o)}>${busy ? '만드는 중…' : '내보내기'}</button>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ cut a part out of the sound of ONE note
// What is drawn is the sound that comes OUT of the node (pitch, length and all rendered); the part that is kept is chosen on it.
// It is stored on the note as "ts" .. "te" (beats from the start of the note); the rest is cut away. A mark inside splits the note in two.
function NoteCutModal({ note, bpm, getAudio, onClose, onApply, onSplit }) {
  const box = useRef(null), drag = useRef(null), bufRef = useRef(null), srcRef = useRef(null), ctxRef = useRef(null), cv = useRef(null);
  const spb = 60 / bpm;
  const [info, setInfo] = useState(null);     // { pk, end } the picture of the sound and where it stops (beats)
  const [err, setErr] = useState('');
  const [a, setA] = useState(note.ts != null ? note.ts : 0);
  const [b, setB] = useState(note.te != null ? note.te : null);
  const [mark, setMark] = useState(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const ab = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await getAudio());
        bufRef.current = ab;
        const ch = ab.getChannelData(0), n = ch.length;
        let mx = 0; for (let i = 0; i < n; i += 4) { const v = Math.abs(ch[i]); if (v > mx) mx = v; }
        let last = n - 1; while (last > 0 && Math.abs(ch[last]) < mx * 0.01) last--;
        const endB = Math.max(0.05, Math.min(n, last + Math.round(0.02 * ab.sampleRate)) / ab.sampleRate / spb);
        const nb = 900, per = Math.max(1, Math.round(endB * spb * ab.sampleRate) / nb), pk = new Array(nb).fill(0);
        for (let i = 0; i < nb; i++) { let m = 0; for (let j = Math.floor(i * per), e = Math.min(n, Math.floor((i + 1) * per)); j < e; j++) { const v = Math.abs(ch[j]); if (v > m) m = v; } pk[i] = m; }
        if (!dead) { setInfo({ pk, end: endB }); setB((x) => (x == null ? endB : Math.min(x, endB))); }
      } catch (e) { if (!dead) setErr(e.message || '소리를 만들지 못했어요'); }
    })();
    return () => { dead = true; try { if (srcRef.current) srcRef.current.stop(); if (ctxRef.current) ctxRef.current.close(); } catch (e) { /* stopped */ } };
  }, []);
  const full = info ? info.end : 1;
  const bb = b == null ? full : b;
  useEffect(() => {
    const c = cv.current;
    if (!c || !info) return;
    c.width = 900; c.height = 160;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 900, 160);
    const mx = Math.max(0.001, ...info.pk);
    info.pk.forEach((v, i) => { const t = ((i + 0.5) / info.pk.length) * full, h = (v / mx) * 150; g.fillStyle = t >= a && t <= bb ? '#2dd4bf' : '#4a5566'; g.fillRect(i, 80 - h / 2, 1, Math.max(1, h)); });
  }, [info, a, bb]);
  const tAt = (e) => { const r = box.current.getBoundingClientRect(); return clamp(((e.clientX - r.left) / r.width) * full, 0, full); };
  const MIN = 0.02;
  const down = (e) => {
    if (!info) return;
    const t = tAt(e), r = box.current.getBoundingClientRect(), tol = (8 / r.width) * full;
    if (e.shiftKey) { if (t > a + MIN && t < bb - MIN) setMark(mark != null && Math.abs(mark - t) < tol ? null : t); return; }
    drag.current = Math.abs(t - a) <= tol ? 'a' : Math.abs(t - bb) <= tol ? 'b' : (t < (a + bb) / 2 ? 'a' : 'b');
    const mv = (ev) => { const t2 = tAt(ev); if (drag.current === 'a') setA(Math.min(t2, (b == null ? full : b) - MIN)); else setB(Math.max(t2, a + MIN)); };
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); drag.current = null; };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    mv(e);
  };
  const play = async () => {
    if (!bufRef.current) return;
    try {
      if (srcRef.current) { srcRef.current.onended = null; srcRef.current.stop(); srcRef.current = null; }
      if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      if (ctxRef.current.state === 'suspended') await ctxRef.current.resume();
      const src = ctxRef.current.createBufferSource();
      src.buffer = bufRef.current; src.connect(ctxRef.current.destination);
      src.start(0, a * spb, Math.max(0.005, (bb - a) * spb));
      srcRef.current = src;
    } catch (e) { /* no sound */ }
  };
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const num = (set, lo, hi) => (e) => { const x = Number(e.target.value); if (Number.isFinite(x)) set(clamp(r3(x), lo, hi)); };
  const pc = (t) => (t / full) * 100 + '%';
  return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" role="dialog" aria-label="노드의 소리 구간 자르기" style=${{ width: 'min(720px, 96vw)' }}>
      <b style=${{ fontSize: '15px' }}>노드의 소리 구간 자르기</b>
      <div class="hint">이 노드에서 실제로 나오는 소리(음높이와 길이가 적용된 소리)예요. 청록색 부분만 남기고 나머지는 잘라요. 양쪽 끝을 끌어서 줄이고, Shift+클릭으로 나눔 표시를 넣으면 그 자리에서 노드를 둘로 나눠요.</div>
      ${err && html`<div class="hint" style=${{ color: '#ff8a8a' }}>${err}</div>`}
      ${!info && !err && html`<div class="hint">노드의 소리를 만드는 중…</div>`}
      <div class="wave" ref=${box} onMouseDown=${down} style=${{ position: 'relative', height: '160px', cursor: 'ew-resize', visibility: info ? 'visible' : 'hidden' }}>
        <canvas ref=${cv} style=${{ width: '100%', height: '160px', display: 'block' }}></canvas>
        <div style=${{ position: 'absolute', top: 0, bottom: 0, left: pc(a), width: '2px', background: '#2dd4bf', pointerEvents: 'none' }}></div>
        <div style=${{ position: 'absolute', top: 0, bottom: 0, left: pc(bb), width: '2px', background: '#2dd4bf', pointerEvents: 'none' }}></div>
        ${mark != null && html`<div style=${{ position: 'absolute', top: 0, bottom: 0, left: pc(mark), width: '2px', background: '#ff5c8a', pointerEvents: 'none' }}></div>`}
      </div>
      <div style=${{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label class="hint">시작(박) <input class="in" type="number" step="0.01" min="0" style=${{ width: '90px', padding: '4px 6px' }} aria-label="남길 소리 시작" value=${a.toFixed(3)} onChange=${num((x) => setA(Math.min(x, bb - MIN)), 0, full)} /></label>
        <label class="hint">끝(박) <input class="in" type="number" step="0.01" min="0" style=${{ width: '90px', padding: '4px 6px' }} aria-label="남길 소리 끝" value=${bb.toFixed(3)} onChange=${num((x) => setB(Math.max(x, a + MIN)), 0, full)} /></label>
        <span class="hint">${`남기는 길이 ${(bb - a).toFixed(3)}박 / 전체 ${full.toFixed(3)}박`}</span>
      </div>
      <div style=${{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span class="hint">앞에서 버리기</span>
        ${[0.05, 0.1, 0.25].map((d) => html`<button key=${'f' + d} class="tbtn" disabled=${!info} onClick=${() => setA(Math.min(a + d, bb - MIN))}>${'+' + d}</button>`)}
        <button class="tbtn" disabled=${!info || a <= 0} onClick=${() => setA(0)}>되돌리기</button>
        <span class="hint" style=${{ marginLeft: '10px' }}>뒤에서 버리기</span>
        ${[0.05, 0.1, 0.25].map((d) => html`<button key=${'b' + d} class="tbtn" disabled=${!info} onClick=${() => setB(Math.max(bb - d, a + MIN))}>${'+' + d}</button>`)}
        <button class="tbtn" disabled=${!info || bb >= full} onClick=${() => setB(full)}>되돌리기</button>
        <span class="hint">(박 단위로 그만큼씩 더 버려요)</span>
      </div>
      <div style=${{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
        <span class="hint" style=${{ flex: 1, minWidth: '180px' }}>나눌 곳은 파형에서 <b>Shift + 클릭</b>으로 표시해요 (다시 Shift + 클릭하면 지워져요)</span>
        <button class="btn" onClick=${play} disabled=${!info}>미리 듣기</button>
        <button class="btn ghost" onClick=${onClose}>취소</button>
        <button class="btn" disabled=${!info} onClick=${() => { setA(0); setB(full); setMark(null); }}>전체 구간으로</button>
        <button class="btn" disabled=${mark == null} onClick=${() => onSplit({ a, b: bb, m: mark, full })}>표시한 곳에서 둘로 나누기</button>
        <button class="btn primary" disabled=${!info} onClick=${() => onApply({ a, b: bb, full })}>적용</button>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ pitch curve editor
// The whole cut is drawn as its pitch curve. Grab the curve and pull: that makes a point that remembers how far it was pulled
// (a bump of that height around it). A point can be grabbed again, moved or removed; a point pulled back onto the original
// line disappears, so the original is always one drag away. The curve is the original plus the sum of the bumps.
function PitchModal({ sample, bpm, onClose, onApply }) {
  const W = 640, H = 300, L = 46, RG = 16, T = 20, B = 64, PH = H - T - B;
  const [C, setC] = useState(null);
  const [err, setErr] = useState('');
  const [anchors, setAnchors] = useState(() => (sample.bend || []).map((a) => ({ t: a.t, a: a.a, s: a.s, w: a.w || 10 })));
  const [sel, setSel] = useState(-1);
  const [defW, setDefW] = useState(10);
  const [hx, setHx] = useState(false);
  const [rng, setRng] = useState(0);   // 0 = scale follows the curve; 12 / 24 = fixed scale (up to two octaves)
  const [busy, setBusy] = useState('');
  const [lr, setLr] = useState(null);   // the range to listen to (seconds from the start of the cut), chosen by dragging along the bottom strip
  const [ph, setPh] = useState(null);   // playing position while listening
  const drag = useRef(null), hist = useRef([]), box = useRef(null), aud = useRef(null), tm = useRef(null);
  const spec = { file: sample.file, start: sample.sel.start, end: sample.sel.end };
  useEffect(() => {
    let dead = false;
    api('/api/sample-contour', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) })
      .then((r) => r.json()).then((c) => { if (!dead) { setC(c); if (!(sample.bend && sample.bend.length)) setDefW(Math.max(10, Math.min(100, Math.round((0.06 * 2.2 * 100) / c.dur)))); } }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; if (tm.current) { clearTimeout(tm.current.t); clearInterval(tm.current.i); } if (aud.current) aud.current.pause(); };
  }, []);
  const stopAud = () => { if (tm.current) { clearTimeout(tm.current.t); clearInterval(tm.current.i); tm.current = null; } if (aud.current) { aud.current.pause(); aud.current = null; } setBusy(''); setPh(null); };
  if (err) return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}><div class="modal" role="dialog"><b>음높이 곡선</b><div class="hint">${err}</div><div style=${{ display: 'flex', justifyContent: 'flex-end' }}><button class="btn" onClick=${onClose}>닫기</button></div></div></div>`;
  if (!C) return html`<div class="modal-bg"><div class="modal" role="dialog"><b>음높이 곡선</b><div class="hint">음높이를 분석하는 중이에요…</div></div></div>`;
  const M = C.midi.length, step = C.dur / (M - 1), root = C.root;
  const rel = C.midi.map((m) => (m == null ? null : m - root));
  const RN = rng || Math.max(6, Math.min(12, Math.ceil(Math.max(...rel.filter((x) => x != null).map((x) => Math.abs(x)), 0)) + 3));
  const gx = (i) => L + (i / (M - 1)) * (W - L - RG), gy = (s) => T + ((RN - s) / (2 * RN)) * PH, inv = (py) => RN - ((py - T) / PH) * 2 * RN;
  const sigOf = (w) => ((w / 100) * C.dur) / 2.2;
  const bump = (a, t) => a.a * Math.exp(-0.5 * Math.pow((t - a.t) / a.s, 2));
  const offAt = (as, i, skip) => as.reduce((sum, a, k) => (k === skip ? sum : sum + bump(a, i * step)), 0);
  const res = rel.map((r, i) => (r == null ? null : r + offAt(anchors, i, -1)));
  const nearV = (i) => { if (rel[i] != null) return i; for (let d = 1; d < M; d++) { if (i - d >= 0 && rel[i - d] != null) return i - d; if (i + d < M && rel[i + d] != null) return i + d; } return i; };
  const pos = (e) => { const r = box.current.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  const tAt = (px) => Math.max(0, Math.min(C.dur, ((px - L) / (W - L - RG)) * C.dur));
  const idxAt = (px) => Math.max(0, Math.min(M - 1, Math.round(((px - L) / (W - L - RG)) * (M - 1))));
  const pushHist = () => { hist.current.push(JSON.stringify(anchors)); if (hist.current.length > 40) hist.current.shift(); };
  const down = (e) => {
    const tg = e.target, p = pos(e);
    if (p.y >= H - B + 2 && !(tg.dataset && (tg.dataset.a !== undefined || tg.dataset.hit))) {   // bottom strip: choose what to listen to
      const t0 = tAt(p.x);
      drag.current = { range: true, t0 };
      setLr({ a: t0, b: t0 });
    } else if (tg.dataset && tg.dataset.a !== undefined) {
      const k = Number(tg.dataset.a);
      pushHist(); setSel(k); setDefW(anchors[k].w);
      drag.current = { k, x0: p.x, i0: Math.round(anchors[k].t / step), hx: e.shiftKey || hx };
    } else if (tg.dataset && tg.dataset.hit) {
      const i = nearV(idxAt(p.x));
      pushHist();
      setAnchors((as) => [...as, { t: i * step, a: 0, s: sigOf(defW), w: defW }]);
      setSel(anchors.length);
      drag.current = { k: anchors.length, x0: p.x, i0: i, hx: false };
    } else { setSel(-1); return; }
    box.current.setPointerCapture(e.pointerId); e.preventDefault();
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const p = pos(e);
    if (d.range) { const t1 = tAt(p.x); setLr({ a: Math.min(d.t0, t1), b: Math.max(d.t0, t1) }); return; }
    setAnchors((as) => as.map((a, k) => {
      if (k !== d.k) return a;
      const ni = d.hx ? nearV(idxAt(gx(d.i0) + (p.x - d.x0))) : Math.round(a.t / step);
      let target = Math.max(-24, Math.min(24, inv(p.y) - rel[ni]));
      if (Math.abs(target) < 0.3) target = 0;
      return { ...a, t: ni * step, a: target - offAt(as, ni, k) };
    }));
  };
  const up = () => {
    if (!drag.current) return;
    if (drag.current.range) { drag.current = null; setLr((r) => (r && r.b - r.a >= 0.03 ? r : null)); return; }
    drag.current = null;
    setAnchors((as) => as.filter((a) => Math.abs(a.a) >= 0.05));
    setSel((k) => (k >= 0 && anchors[k] && Math.abs(anchors[k].a) < 0.05 ? -1 : k));
  };
  const setW = (v) => {
    setDefW(v);
    if (sel >= 0 && anchors[sel]) setAnchors((as) => as.map((a, k) => (k === sel ? { ...a, w: v, s: sigOf(v) } : a)));
  };
  const wheel = (e) => { e.preventDefault(); setW(Math.max(2, Math.min(100, (sel >= 0 && anchors[sel] ? anchors[sel].w : defW) + (e.deltaY < 0 ? 2 : -2)))); };
  const clean = (as) => as.map((a) => ({ t: Number(a.t.toFixed(4)), a: Number(a.a.toFixed(3)), s: Number(a.s.toFixed(4)), w: a.w }));
  const delSel = () => { if (sel >= 0) { pushHist(); setAnchors((as) => as.filter((_, k) => k !== sel)); setSel(-1); } };
  const resetAll = () => { if (anchors.length) pushHist(); setAnchors([]); setSel(-1); };
  const undo = () => { if (hist.current.length) { setAnchors(JSON.parse(hist.current.pop())); setSel(-1); } };
  const listen = async (edited) => {
    stopAud();
    const beats = r6((C.dur * bpm) / 60);
    const sp = { ...spec, ...(edited && anchors.length ? { bend: clean(anchors).map((a) => ({ t: a.t, a: a.a, s: a.s })) } : {}) };
    const payload = { bpm, target: 'all', master: {}, lines: [{ id: 'L1', sample: sp, fit: 'stretch', nodes: [{ s: 0, l: beats, notes: [{ s: 0, l: beats, p: Math.round(sample.sel.root != null ? sample.sel.root : C.root) }], fit: null, sample: null }] }] };
    setBusy(edited ? 'edit' : 'orig');
    try {
      const blob = await (await api('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).blob();
      const a = new Audio(URL.createObjectURL(blob));
      a.onended = () => stopAud();
      aud.current = a;
      await new Promise((res) => { if (a.readyState >= 1) res(); else a.addEventListener('loadedmetadata', res, { once: true }); });
      if (lr) a.currentTime = lr.a;
      await a.play();
      tm.current = { i: setInterval(() => { if (aud.current === a) setPh(a.currentTime); }, 40), t: lr ? setTimeout(stopAud, (lr.b - lr.a) * 1000 + 30) : null };
    } catch (ex) { setBusy(''); }
  };
  const path = (vals) => { let d = '', on = false; vals.forEach((v, i) => { if (v == null) { on = false; return; } d += (on ? 'L' : 'M') + gx(i).toFixed(1) + ',' + gy(v).toFixed(1) + ' '; on = true; }); return d; };
  const dPath = path(res);
  const grid = []; for (let s = -RN; s <= RN; s += 3) grid.push(s);
  const mx = anchors.length ? anchors.reduce((a, b) => (Math.abs(b.a) > Math.abs(a) ? b.a : a), 0) : 0;
  const cur = sel >= 0 ? anchors[sel] : null;
  const curI = cur ? Math.round(cur.t / step) : -1;
  return html`<div class="modal-bg" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" role="dialog" aria-label="음높이 곡선 편집" style=${{ width: 'min(720px, 96vw)' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b style=${{ fontSize: '15px' }}>${`음높이 곡선 · ${sample.label || sample.file}`}</b>
        <span class="hint">${`${C.dur.toFixed(2)}초`}</span>
      </div>
      <div class="hint">파란 곡선을 잡고 위아래로 끌면 그 자리에 점이 생기고 곡선이 따라와요. 점을 다시 잡으면 그 점만 움직여요. 점을 주황 점선(원본)까지 끌어 놓으면 사라져요. 점을 더블클릭해도 지워져요.</div>
      <div style=${{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span class="hint">${cur ? '선택한 점의 범위' : '새 점의 범위'}</span>
        <input type="range" min="2" max="100" step="1" value=${cur ? cur.w : defW} style=${{ width: '180px' }} aria-label="잡아당기는 범위" onInput=${(e) => setW(Number(e.target.value))} />
        <span class="hint">${`${cur ? cur.w : defW}% (±${((((cur ? cur.w : defW) / 100) * C.dur) / 2.2).toFixed(2)}초)`}</span>
        <label class="hint" style=${{ display: 'flex', alignItems: 'center', gap: '4px' }}><input type="checkbox" checked=${hx} onChange=${(e) => setHx(e.target.checked)} /> 좌우로도 옮기기</label>
        <label class="hint" style=${{ display: 'flex', alignItems: 'center', gap: '4px' }}>눈금
          <select class="in" style=${{ width: '120px', padding: '2px 4px', fontSize: '12px' }} aria-label="세로 눈금 범위" value=${String(rng)} onChange=${(e) => setRng(Number(e.target.value))}>
            <option value="0">자동</option><option value="12">±12반음 (1옥타브)</option><option value="24">±24반음 (2옥타브)</option>
          </select></label>
      </div>
      <svg ref=${box} viewBox=${`0 0 ${W} ${H}`} style=${{ width: '100%', display: 'block', touchAction: 'none', background: 'var(--panel2, rgba(128,128,128,.08))', borderRadius: '10px', userSelect: 'none' }}
        onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onWheel=${wheel}>
        ${grid.map((s) => html`<g key=${s}><line x1=${L} x2=${W - RG} y1=${gy(s)} y2=${gy(s)} stroke="currentColor" stroke-opacity=${s === 0 ? 0.35 : 0.12} stroke-width=${s === 0 ? 1 : 0.5} /><text x=${L - 8} y=${gy(s) + 4} text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.55">${(s > 0 ? '+' : '') + s}</text></g>`)}
        ${C.env.map((v, i) => (i % 2 === 0 && rel[i] != null ? html`<rect key=${i} x=${gx(i)} y=${H - B + 34 - v * 17} width="2.2" height=${Math.max(1, v * 34)} rx="1" fill="currentColor" fill-opacity="0.4" />` : null))}
        <rect x=${L} y=${H - B + 4} width=${W - L - RG} height=${B - 22} fill="transparent" style=${{ cursor: 'col-resize' }} />
        ${lr && html`<g><rect x=${gx((lr.a / C.dur) * (M - 1))} y=${T} width=${Math.max(1, gx((lr.b / C.dur) * (M - 1)) - gx((lr.a / C.dur) * (M - 1)))} height=${H - B + 38 - T} fill="#378ADD" fill-opacity="0.14" /><text x=${(gx((lr.a / C.dur) * (M - 1)) + gx((lr.b / C.dur) * (M - 1))) / 2} y=${H - B + 52} text-anchor="middle" font-size="11" fill="#378ADD">${`듣는 구간 ${lr.a.toFixed(2)}~${lr.b.toFixed(2)}초`}</text></g>`}
        ${ph != null && html`<line x1=${gx((ph / C.dur) * (M - 1))} x2=${gx((ph / C.dur) * (M - 1))} y1=${T} y2=${H - B + 38} stroke="#378ADD" stroke-width="1.5" />`}
        <text x=${L} y=${H - 6} font-size="11" fill="currentColor" fill-opacity="0.55">0초</text>
        <text x=${W - RG} y=${H - 6} text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.55">${`${C.dur.toFixed(2)}초`}</text>
        <path d=${path(rel)} fill="none" stroke="#D85A30" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.8" />
        ${cur && html`<polyline fill="none" stroke="#378ADD" stroke-width="1" opacity="0.45" points=${Array.from({ length: M }, (_, i) => `${gx(i).toFixed(1)},${gy(-RN + 0.5 + 1.6 * Math.exp(-0.5 * Math.pow((i * step - cur.t) / cur.s, 2))).toFixed(1)}`).join(' ')} />`}
        <path d=${dPath} fill="none" stroke="#378ADD" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        <path d=${dPath} fill="none" stroke="transparent" stroke-width="30" data-hit="1" style=${{ cursor: 'grab' }} />
        ${anchors.map((a, k) => { const i = Math.round(a.t / step); const y = res[i] == null ? gy(0) : gy(res[i]); return html`<g key=${k}><line x1=${gx(i)} x2=${gx(i)} y1=${rel[i] == null ? y : gy(rel[i])} y2=${y} stroke="#378ADD" stroke-dasharray="2 3" opacity="0.6" /><circle cx=${gx(i)} cy=${y} r=${k === sel ? 9 : 7} data-a=${k} fill=${k === sel ? '#378ADD' : 'var(--panel, #fff)'} stroke="#378ADD" stroke-width="2.5" style=${{ cursor: 'grab' }} onDblClick=${() => { pushHist(); setAnchors((as) => as.filter((_, q) => q !== k)); setSel(-1); }} /></g>`; })}
        <text x=${L + 4} y=${T - 6} font-size="11" fill="#D85A30">점선: 원본 음높이</text>
        <text x=${L + 112} y=${T - 6} font-size="11" fill="#378ADD">파란 곡선: 지금 설정 · 동그라미: 고친 점</text>
      </svg>
      <div style=${{ display: 'flex', alignItems: 'baseline', gap: '14px', flexWrap: 'wrap' }}>
        <b style=${{ fontSize: '16px' }}>${anchors.length ? `고친 점 ${anchors.length}개` : '수정 없음'}</b>
        <span class="hint">${anchors.length ? `최대 ${mx > 0 ? '+' : ''}${(Math.round(mx * 10) / 10).toFixed(1)} 반음 · 점 바깥은 원본 소리 그대로 재생돼요` : '원본 그대로 재생돼요 (보정 없음)'}</span>
      </div>
      <div class="hint">아래 소리 모양 줄을 좌우로 끌면 듣는 구간을 정해요. 구간을 정하면 듣기 버튼이 그 부분만 들려 줘요 (한 번 누르면 해제).</div>
      <div class="hint" style=${{ minHeight: '18px' }}>${cur && res[curI] != null ? `선택한 점: ${(cur.t).toFixed(2)}초 · ${(res[curI] - rel[curI] > 0 ? '+' : '') + (Math.round((res[curI] - rel[curI]) * 10) / 10).toFixed(1)} 반음 · 범위 ${cur.w}%` : ''}</div>
      <div style=${{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style=${{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button class="btn" disabled=${sel < 0} onClick=${delSel}>선택한 점 지우기</button>
          <button class="btn" onClick=${undo}>한 단계 취소</button>
          <button class="btn" onClick=${resetAll}>전부 원본으로</button>
          <button class="btn" disabled=${!lr} onClick=${() => { stopAud(); setLr(null); }}>듣는 구간 해제</button>
          <button class="btn" onClick=${() => (busy === 'orig' ? stopAud() : listen(false))}>${busy === 'orig' ? '■ 멈추기' : (lr ? '▶ 구간 원본 듣기' : '▶ 원본 듣기')}</button>
          <button class="btn" onClick=${() => (busy === 'edit' ? stopAud() : listen(true))}>${busy === 'edit' ? '■ 멈추기' : (lr ? '▶ 구간 수정 듣기' : '▶ 수정 듣기')}</button>
        </div>
        <div style=${{ display: 'flex', gap: '6px' }}>
          <button class="btn ghost" onClick=${() => { stopAud(); onClose(); }}>취소</button>
          <button class="btn primary" onClick=${() => { stopAud(); onApply(clean(anchors)); }}>적용</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ piano-roll helpers
// Rows of a piano roll, top = highest pitch. Compact: only the pitches in use plus one free row above and below,
// so no vertical space is wasted on unused semitones. Full: every semitone of a remembered range.
function rowsFor(pitches, compact, lo, hi) {
  if (compact) {
    const u = [...new Set(pitches)].sort((a, b) => b - a);
    if (!u.length) return [67, 66, 65, 64, 63, 62, 61, 60];
    return [u[0] + 1, ...u, u[u.length - 1] - 1];
  }
  const rows = [];
  for (let p = hi; p >= lo; p--) rows.push(p);
  return rows;
}
// Left-hand pitch ruler (stays at the lane's left edge while scrolling sideways).
function Keys({ rows, rh, top }) {
  return html`<div class="keys" style=${{ marginTop: top + 'px', height: rows.length * rh + 'px' }}>
    ${rows.map((p) => html`<div key=${p} class=${'key' + (black(p) ? ' blk' : '')} style=${{ height: rh + 'px', lineHeight: rh + 'px' }}>${rh >= 13 ? noteName(p) : ''}</div>`)}
  </div>`;
}
const DRUM_ROWS = ['하이햇', '스네어', '킥'];

// Consecutive notes of the same pitch that touch (or nearly touch) form a "run". A run looks like one long line
// when drawn naively, so every note of a run gets its own block, an onset mark and an alternating shade.
function runsOf(notes) {
  const order = notes.map((n, i) => i).sort((a, b) => notes[a].t - notes[b].t);
  const info = new Array(notes.length);
  const last = new Map();
  const runs = [];
  order.forEach((i) => {
    const n = notes[i];
    const prev = last.get(n.p);
    if (prev !== undefined && n.t - (notes[prev].t + notes[prev].l) <= 0.15) {
      const r = info[prev].run;
      info[i] = { run: r, shade: 1 - info[prev].shade, pos: runs[r].length };
      runs[r].push(i);
    } else {
      info[i] = { run: runs.length, shade: 0, pos: 0 };
      runs.push([i]);
    }
    last.set(n.p, i);
  });
  info.forEach((x) => { x.len = runs[x.run].length; });
  return { info, runs };
}

// ------------------------------------------------------------------ reference lane
function RefLane({ def, ctx }) {
  const { T, lanes, U, ui, drag, grid, P, rh } = ctx;
  const cv = useRef(null);
  const lane = useRef(null);
  const rects = useRef([]);
  const notes = lanes && lanes[def.key] ? lanes[def.key] : [];
  const large = ((P.ref && P.ref.sizes) || {})[def.key] === 'large';
  const runs = useMemo(() => (def.kind === 'pitch' ? runsOf(notes) : null), [notes]);
  const selNote = U.refNote && U.refNote.key === def.key ? U.refNote.i : null;
  // geometry of the large (piano-roll) view: one row per pitch that actually occurs
  let rowList = [], rowH = 0, h = REFH;
  if (large && def.kind === 'pitch' && notes.length) {
    const freq = new Map();
    notes.forEach((n) => freq.set(n.p, (freq.get(n.p) || 0) + 1));
    let ps = [...freq.keys()];
    if (ps.length > 36) ps = ps.sort((a, b) => freq.get(b) - freq.get(a)).slice(0, 36);   // keep the 36 most used pitches
    rowList = ps.sort((a, b) => b - a);
    rowH = Math.max(10, Math.round(rh * 0.7));          // reference rows follow the slider (a bit smaller than my own rows)
    h = Math.max(MIN_REF_H, rowList.length * rowH + 4);
  } else if (large && def.kind === 'drum') {
    rowH = Math.max(18, Math.round(rh * 0.8));
    h = Math.max(MIN_REF_H, 3 * rowH + 4);
  }
  const isRoll = large && rowH > 0;
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const w = T * PX;
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const R = [];
    const mark = (i, x, y, ww, hh, onsetAlpha, color) => {
      g.fillStyle = color; g.fillRect(x, y, ww, hh);
      g.fillStyle = 'rgba(255,255,255,' + onsetAlpha + ')'; g.fillRect(x, y, Math.min(3, ww), hh);   // onset
      R.push({ i, x, y, w: ww, h: hh });
    };
    if (def.kind === 'pitch') {
      if (!notes.length) { rects.current = R; return; }
      let rowOf = null, nh = 4;
      if (isRoll) {
        const rowIdx = new Map(rowList.map((p, k) => [p, k]));
        rowOf = (p) => (rowIdx.has(p) ? rowIdx.get(p) : rowList.reduce((b, q, k) => (Math.abs(q - p) < Math.abs(rowList[b] - p) ? k : b), 0));
        rowList.forEach((p, k) => {
          const y = k * rowH + 2;
          if (black(p)) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, y, w, rowH); }
          g.fillStyle = 'rgba(90,100,116,0.18)'; g.fillRect(0, y + rowH - 1, w, 1);
        });
        nh = Math.max(3, rowH - 3);
      }
      const mn = Math.min(...notes.map((n) => n.p)), mx = Math.max(...notes.map((n) => n.p)), range = mx - mn;
      notes.forEach((n, i) => {
        const inf = runs.info[i];
        const x = n.t * PX + 1, ww = Math.max(3, n.l * PX - 2);
        const y = isRoll ? rowOf(n.p) * rowH + 3 : 12 + (range ? ((mx - n.p) / range) * (h - 28) : (h - 28) / 2);
        const tone = n.m ? (inf.shade ? '#9aa5b8' : '#c3cad6') : (inf.shade ? '#7a8599' : '#657084');
        mark(i, x, y, ww, nh, n.m ? 0.95 : 0.5, tone);
        if (isRoll && inf.pos === 0 && inf.len >= 2 && ww >= 26) {
          g.fillStyle = '#0b0f14'; g.font = 'bold ' + Math.max(8, Math.min(11, nh - 2)) + 'px sans-serif';
          g.fillText('×' + inf.len, x + 5, y + nh - Math.max(2, (nh - 8) / 2));
        }
      });
      // only the clicked note is outlined (its neighbours in a same-pitch run stay unselected)
      if (selNote != null && R[selNote]) {
        const r = R[selNote];
        g.lineWidth = 2; g.strokeStyle = '#ffffff';
        g.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      }
    } else {
      notes.forEach((x, i) => {
        const row = x.k === 'hat' ? 0 : x.k === 'snare' ? 1 : 2;
        const y = isRoll ? row * rowH + 4 : Math.round(h * (0.16 + 0.27 * row));
        const hh = isRoll ? rowH - 4 : Math.round(h * 0.2);
        g.fillStyle = x.k === 'kick' ? '#e7eaf0' : x.k === 'snare' ? '#c3cad6' : '#7d8798';
        g.fillRect(x.t * PX, y, 3, hh);
        R.push({ i, x: x.t * PX - 2, y, w: 7, h: hh });
        if (i === selNote) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x.t * PX - 2, y - 1, 7, hh + 2); }
      });
    }
    rects.current = R;
  }, [notes, T, large, rowList.join(','), rowH, h, PX, selNote]);
  const beatAt = (e) => clamp(r6(Math.floor((e.clientX - lane.current.getBoundingClientRect().left) / PX / grid) * grid), 0, T - grid);
  const hitNote = (e) => {
    const r = lane.current.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null;
    rects.current.forEach((q) => {
      const tol = q.h < 10 ? 6 : 1;
      if (x >= q.x - 2 && x <= q.x + q.w + 2 && y >= q.y - tol && y <= q.y + q.h + tol && (!best || q.w < best.w)) best = q;
    });
    return best;
  };
  const sel = U.refSel && U.refSel.key === def.key ? U.refSel : null;
  const down = (e) => {
    const b = beatAt(e);
    if (U.armed && sel && b >= sel.a && b < sel.b) { ctx.createFromSel(U.armed); return; }
    const hit = hitNote(e);
    drag.current = { key: def.key, anchor: b, hit: hit ? hit.i : null, sx: e.clientX, sy: e.clientY, moved: false };
    if (!hit) ui({ refSel: { key: def.key, a: b, b: r6(b + grid) }, refNote: null, notice: '' });
  };
  useEffect(() => {   // the button may be let go anywhere: the drag ends then
    const end = () => { drag.current = null; };
    window.addEventListener('mouseup', end); window.addEventListener('blur', end);
    return () => { window.removeEventListener('mouseup', end); window.removeEventListener('blur', end); };
  }, []);
  const move = (e) => {
    const d = drag.current;
    if (!d || d.key !== def.key) return;
    if (e.buttons === 0) { drag.current = null; return; }   // no button is held: nothing is being dragged
    if (!d.moved) {
      if (Math.abs(e.clientX - d.sx) < 4 && Math.abs(e.clientY - d.sy) < 4) return;
      d.moved = true;
    }
    const b = beatAt(e);
    ui({ refSel: { key: def.key, a: Math.min(d.anchor, b), b: r6(Math.max(d.anchor, b) + grid) }, refNote: null });
  };
  const up = () => {
    const d = drag.current;
    if (d && d.key === def.key && d.hit != null && !d.moved) ctx.selectRefNote(def.key, d.hit);   // a click on a note picks that single note
    drag.current = null;
  };
  const drop = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || U.armed;
    if (id && id.startsWith('lib:')) { ui({ notice: '노드 모음의 뭉치는 아래 "내 라인"에 놓아 주세요. 끈 채로 화면 아래쪽 가장자리로 가져가면 스크롤돼요' }); return; }
    const b = beatAt(e);
    if (sel && b >= sel.a && b < sel.b && id) ctx.createFromSel(id);
    else ui({ notice: '먼저 이 레인에서 구간을 고르고, 선택한 구간 위에 놓아 주세요' });
  };
  const count = notes.length ? notes.length + (def.kind === 'drum' ? '번 타격' : '개 음') + (def.poly ? ' · 한 줄 정리' : '') : '없음';
  return html`<div class="row" key=${def.key}>
    <div class="hd ref" style=${{ height: h + 'px' }} title=${count}>
      <input class="lname" style=${{ fontSize: '12.5px', color: '#c3cad6' }} aria-label="참조 소리 이름" value=${tx(def.name)} onInput=${(e) => ctx.renameLane(def.key, e.target.value)} />
      <div class="seg-toggle" style=${{ gap: '3px' }}>
        <button class=${'tbtn' + (!large ? ' on' : '')} style=${{ flex: 1, padding: 0 }} aria-label=${def.name + ' 작게 보기'} onClick=${() => ctx.setRefSize(def.key, 'small')}>작게</button>
        <button class=${'tbtn' + (large ? ' on' : '')} style=${{ flex: 1, padding: 0 }} aria-label=${def.name + ' 크게 보기'} onClick=${() => ctx.setRefSize(def.key, 'large')}>크게</button>
        <button class="tbtn" style=${{ padding: '0 5px' }} aria-label=${def.name + ' 듣기'} onClick=${() => ctx.listenStem(def.key)}>${U.listen === def.key ? '■' : '듣기'}</button>
        <button class="tbtn" style=${{ padding: '0 5px' }} aria-label=${def.name + ' 숨기기'} onClick=${() => ui({ refOn: { ...U.refOn, [def.key]: false } })}>숨김</button>
        <button class="tbtn" style=${{ padding: '0 4px' }} title="이 레인 전체를 내 라인의 새 라인으로 복사" aria-label=${def.name + ' 레인을 새 라인으로 복사'} onClick=${() => ctx.copyLaneToLine(def.key)}>⧉</button>
      </div>
    </div>
    <div class="lane ref" ref=${lane} style=${{ width: T * PX + 'px', height: h + 'px' }}
      onMouseDown=${down} onMouseMove=${move} onMouseUp=${up} onDragOver=${(e) => e.preventDefault()} onDrop=${drop}>
      ${isRoll && def.kind === 'pitch' && html`<${Keys} rows=${rowList} rh=${rowH} top=${2} />`}
      ${isRoll && def.kind === 'drum' && html`<div class="keys" style=${{ marginTop: '2px', height: 3 * rowH + 'px' }}>${DRUM_ROWS.map((n) => html`<div key=${n} class="key" style=${{ height: rowH + 'px', lineHeight: rowH + 'px', fontSize: '9px' }}>${n}</div>`)}</div>`}
      <canvas ref=${cv} style=${{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}></canvas>
      ${sel && html`<div class="selbox" style=${{ left: sel.a * PX + 'px', width: (sel.b - sel.a) * PX + 'px' }}>${`${fmt(sel.b - sel.a)}박`}</div>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ my line
function LineRow({ L, ctx }) {
  const { P, U, ui, upd, T } = ctx;
  const RH = ctx.rh;                       // height of one pitch row (user setting: 세로)
  const large = L.size === 'large';
  const compact = L.compact !== false;     // show only the pitches in use (default)
  const onLine = U.selLine === L.id;
  const pitches = L.nodes.flatMap((n) => n.notes.map((k) => k.p));
  const fz = U.rollFrozen && U.rollFrozen.lineId === L.id ? U.rollFrozen : null;   // rows stay put while a note is being dragged
  // "full" mode: every semitone of a range that is remembered per line (L.view) and only ever grows
  const fit = pitches.length ? { lo: Math.min(...pitches) - 1, hi: Math.max(...pitches) + 1 } : { lo: 55, hi: 70 };
  const base = L.view || fit;
  const lo = Math.min(base.lo, pitches.length ? Math.min(...pitches) - 1 : base.lo);
  const hi = Math.max(base.hi, pitches.length ? Math.max(...pitches) + 1 : base.hi);
  useEffect(() => {
    if (large && !compact && !fz && (!L.view || L.view.lo !== lo || L.view.hi !== hi)) ctx.setView(L.id, lo, hi);
  }, [large, compact, lo, hi, !!L.view, !!fz]);
  const rows = fz ? fz.rows : rowsFor(pitches, compact, lo, hi);
  const rowIdx = new Map(rows.map((p, k) => [p, k]));
  const idxOf = (p) => (rowIdx.has(p) ? rowIdx.get(p) : rows.reduce((b, q, k) => (Math.abs(q - p) < Math.abs(rows[b] - p) ? k : b), 0));
  const h = large ? Math.max(MIN_LINE_H, TAB + rows.length * RH + 8) : SMALLH;
  const playing = U.playing === L.id || U.playing === 'all';
  const isThis = U.playing === L.id;
  const bg = large
    ? { backgroundImage: GRID_BG + ',repeating-linear-gradient(to bottom,transparent 0 ' + (RH - 1) + 'px,#20252d ' + (RH - 1) + 'px ' + RH + 'px)', backgroundPosition: '0 0,0 0,0 0,0 ' + TAB + 'px' }
    : {};
  const blackRows = large ? rows.filter(black) : [];
  const tips = [];
  const nodeTip = (n, isSel) => tips.push(html`<div class=${'tip' + (isSel ? ' sel' : '')} key=${'tip' + n.id} style=${{ left: n.s * PX + 'px', top: '-17px' }}>${isSel ? '수정 중 · ' : ''}${n.name || '(이름 없음)'}</div>`);
  const selN = L.nodes.find((n) => n.id === U.selNode);
  if (selN) nodeTip(selN, true);
  const hovN = L.nodes.find((n) => n.id === U.hoverNode);
  if (hovN && hovN !== selN) nodeTip(hovN, false);
  const rootOf = (n) => ctx.rootOf(n.sampleId || L.sampleId);
  const dg = U.drag;
  const dp = U.dropPrev && U.dropPrev.line === L.id ? U.dropPrev : null;

  return html`<div class="row" key=${L.id}>
    <div class="hd" style=${{ height: h + 'px', borderColor: onLine ? L.color : '' }} onDragOver=${(e) => { if (dragLib) e.preventDefault(); }} onDrop=${(e) => ctx.libDropHeader(L, e)}>
      <div style=${{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style=${{ flex: 'none', width: '8px', height: '8px', borderRadius: '50%', background: L.color }}></span>
        <input class="lname" aria-label="라인 이름" value=${tx(L.name)} onFocus=${() => ui({ selLine: L.id })}
          onInput=${(e) => upd((p) => { p.lines.find((x) => x.id === L.id).name = e.target.value; })} />
        <button class="tbtn" style=${{ flex: 'none', width: '22px', padding: 0, opacity: P.lines.length < 2 ? 0.4 : 1 }} title=${P.lines.length < 2 ? '라인은 최소 1개가 있어야 해요' : '이 라인 지우기'} aria-label=${L.name + ' 라인 지우기'} onClick=${() => ctx.deleteLine(L.id)}>✕</button>
      </div>
      <div class="seg-toggle">
        <button class=${'tbtn' + (playing ? ' on' : '')} style=${{ width: '26px', padding: 0, background: isThis ? '#2dd4bf' : '', color: isThis ? '#06231f' : '' }}
          aria-label=${L.name + (isThis ? ' 라인 정지' : ' 라인 재생')} onClick=${() => ctx.play(L.id)}>${U.rendering === L.id ? '…' : isThis ? '■' : '▶'}</button>
        <button class=${'tbtn' + (!large ? ' on' : '')} style=${{ flex: 1 }} onClick=${() => { upd((p) => { p.lines.find((x) => x.id === L.id).size = 'small'; }); ui({ selLine: L.id, selNote: null }); }}>작게</button>
        <button class=${'tbtn' + (large ? ' on' : '')} style=${{ flex: 1 }} onClick=${() => { upd((p) => { p.lines.find((x) => x.id === L.id).size = 'large'; }); ui({ selLine: L.id }); }}>크게</button>
      </div>
      <div class="seg-toggle">
        <button class=${'tbtn' + (L.mute ? ' on' : '')} style=${{ flex: 1, padding: 0, background: L.mute ? '#f2c94c' : '', color: L.mute ? '#2a2108' : '', borderColor: L.mute ? '#f2c94c' : '' }} title="뮤트: 이 라인 소리 끄기" aria-label=${L.name + ' 뮤트'} aria-pressed=${!!L.mute} onClick=${() => upd((p) => { const x = p.lines.find((q) => q.id === L.id); x.mute = !x.mute; })}>M 뮤트</button>
        <button class=${'tbtn' + (L.solo ? ' on' : '')} style=${{ flex: 1, padding: 0, background: L.solo ? '#7ee8d9' : '', color: L.solo ? '#06231f' : '', borderColor: L.solo ? '#7ee8d9' : '' }} title="솔로: 이 라인만 듣기" aria-label=${L.name + ' 솔로'} aria-pressed=${!!L.solo} onClick=${() => upd((p) => { const x = p.lines.find((q) => q.id === L.id); x.solo = !x.solo; })}>S 솔로</button>
        <button class=${'tbtn' + (L.auto ? ' on' : '')} style=${{ flex: 1, padding: 0, background: L.auto ? '#c4a6ff' : '', color: L.auto ? '#1d1233' : '', borderColor: L.auto ? '#c4a6ff' : '' }} title="자동 음량: 이 라인의 소리 크기를 다른 라인들과 비슷하게 맞춰요 (작은 샘플 소리가 참조곡에 묻힐 때)" aria-label=${L.name + ' 자동 음량'} aria-pressed=${!!L.auto} onClick=${() => upd((p) => { const x = p.lines.find((q) => q.id === L.id); x.auto = !x.auto; })}>A 자동</button>
      </div>
      ${large && html`<div class="seg-toggle">
        <button class=${'tbtn' + (compact ? ' on' : '')} style=${{ flex: 1, padding: 0 }} aria-label="쓰는 음만 보기 (안 쓰는 높낮이 줄 숨기기)" onClick=${() => upd((p) => { p.lines.find((x) => x.id === L.id).compact = !compact; })}>쓰는 음만</button>
        ${!compact && html`<button class="tbtn" style=${{ padding: '0 6px' }} aria-label="보이는 음 범위를 지금 음들에 다시 맞추기" onClick=${() => ctx.setView(L.id, fit.lo, fit.hi)}>맞춤</button>`}
      </div>`}
    </div>
    <div class="lane" data-line=${L.id} style=${{ width: T * PX + 'px', height: h + 'px', borderColor: onLine ? L.color : '', ...bg }}
      onDragOver=${(e) => ctx.libOver(L, e)} onDragLeave=${(e) => ctx.libLeave(L, e)} onDrop=${(e) => ctx.libDrop(L, e)}>
      ${large && html`<${Keys} rows=${rows} rh=${RH} top=${TAB} />`}
      ${blackRows.map((p) => html`<div key=${'bk' + p} style=${{ position: 'absolute', left: 0, width: T * PX + 'px', top: TAB + idxOf(p) * RH + 'px', height: RH + 'px', background: 'rgba(0,0,0,0.2)', pointerEvents: 'none' }}></div>`)}
      ${L.nodes.length === 0 && html`<div style=${{ position: 'absolute', left: '44px', top: Math.min(h / 2 - 8, 20) + 'px', fontSize: '12px', color: '#7d8798' }}>왼쪽 노드 모음에서 노드를 끌어다 놓거나, 참조곡 구간으로 노드를 추가하세요</div>`}
      ${L.nodes.map((n) => {
        const on = U.selNode === n.id;
        const pick = () => { if (ctx.suppress.current) return; ui({ selLine: L.id, selNode: n.id, selNote: null }); };
        const enter = () => ui({ hoverNode: n.id });
        const leave = () => ui({ hoverNode: null });
        const down = (e) => ctx.startNodeDrag(e, L, n);
        const dim = dg && dg.id === n.id ? 0.35 : 1;
        const glow = on ? '0 0 0 3px ' + L.color + '88' : 'none';
        if (large) {
          const root = rootOf(n);
          const runInfo = runsOf(n.notes.map((k) => ({ t: k.s, l: k.l, p: k.p }))).info;   // same-pitch runs inside the node
          return html`<div key=${n.id} style=${{ opacity: dim }}>
            <button class="box" aria-label=${n.name + ' 노드, ' + fmt(n.l) + '박 (끌어서 옮길 수 있어요, 빈 곳을 두 번 누르면 음이 추가돼요)'} onClick=${pick} onMouseDown=${down} onDblClick=${(e) => ctx.addNote(L, n, e, rows)} onMouseEnter=${enter} onMouseLeave=${leave}
              style=${{ left: n.s * PX + 'px', top: '4px', width: n.l * PX - 2 + 'px', height: h - 8 + 'px', background: L.color + '14', boxShadow: glow, border: on ? '2px solid #fff' : '1px dashed ' + L.color }}></button>
            ${n.notes.map((k, i) => html`<button class=${'note' + (on && (U.selNote === i || (U.selMore && U.selMore.node === n.id && U.selMore.primary === U.selNote && U.selMore.list.includes(i))) ? ' sel' : '')} key=${i}
              aria-label=${noteName(k.p) + ', ' + fmt(k.l) + '박 (위아래로 끌면 높낮이, 옆으로 끌면 위치가 바뀌어요. Shift나 Ctrl을 누르고 누르면 여러 개를 고를 수 있어요)'}
              onClick=${(e) => ctx.pickNote(e, L, n, i)} onMouseDown=${(e) => ctx.startNoteDrag(e, L, n, i, rows)} onMouseEnter=${enter} onMouseLeave=${leave}
              style=${{ left: (n.s + k.s + (k.ts || 0)) * PX + 1 + 'px', top: TAB + idxOf(k.p) * RH + 2 + 'px', height: RH - 4 + 'px', fontSize: RH >= 22 ? '11px' : '10px', width: Math.max(3, ((k.te != null ? Math.min(k.te, k.l) : k.l) - (k.ts || 0)) * PX - 2) + 'px', background: L.color, filter: runInfo[i].shade ? 'brightness(0.82)' : 'none' }}>${sgn(k.p - root)}</button>`)}
          </div>`;
        }
        const mn = Math.min(...n.notes.map((k) => k.p)), mx = Math.max(...n.notes.map((k) => k.p)), range = mx - mn;
        const wpx = n.l * PX - 2;
        return html`<div key=${n.id} style=${{ opacity: dim }}>
          <button class="pill" aria-label=${n.name + ' 노드, ' + n.l + '박 (끌어서 옮길 수 있어요)'} onClick=${pick} onMouseDown=${down} onMouseEnter=${enter} onMouseLeave=${leave}
            style=${{ left: n.s * PX + 'px', top: PILLTOP + 'px', height: PILLH + 'px', width: wpx + 'px', background: L.color + '33', boxShadow: glow, border: on ? '2px solid #fff' : '1px solid ' + L.color }}></button>
          ${n.notes.map((k, i) => html`<div class="bar" key=${i} style=${{ background: L.color, left: n.s * PX + 4 + (k.s / n.l) * (wpx - 8) + 'px', width: Math.max(2, (k.l / n.l) * (wpx - 8) - 1) + 'px', top: PILLTOP + 10 + (range ? ((mx - k.p) / range) * (PILLH - 24) : (PILLH - 24) / 2) + 'px', height: '4px' }}></div>`)}
        </div>`;
      })}
      ${dg && dg.line === L.id && html`<div class="dragghost" style=${{ left: dg.s * PX + 'px', top: (large ? 4 : PILLTOP) + 'px', width: dg.l * PX - 2 + 'px', height: (large ? h - 8 : PILLH) + 'px', borderColor: dg.ok ? '#fff' : '#ef4444' }}></div>`}
      ${dp && html`<div class="dragghost" style=${{ left: dp.s * PX + 'px', top: (large ? 4 : PILLTOP) + 'px', width: dp.l * PX - 2 + 'px', height: (large ? h - 8 : PILLH) + 'px', borderColor: dp.ok ? '#2dd4bf' : '#ef4444' }}></div>`}
      ${tips}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ app
function App() {
  const [P, setP] = useState(defaultProject());
  PX = clamp(P.zoom || 96, 24, 320);
  const [U, setU] = useState({ selLine: 'L1', selNode: null, selNote: null, hoverNode: null, armed: null, refSel: null, notice: '', playing: null, rendering: null, listen: null, refOn: {}, melodyOnly: true, cutting: null, drag: null, rangePlaying: null, refModel: 'htdemucs_6s', analyzing: null, refNote: null, dropPrev: null, keepTiming: true, rollFrozen: null, guide: null, gPitch: 60, libSel: null, planOpen: false, helpOpen: false, mixOpen: true, selMore: null, entryEdit: null, dropChoice: null });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { const ping = () => fetch('/api/alive').catch(() => {}); ping(); const id = setInterval(ping, 4000); return () => clearInterval(id); }, []);   // lets the launcher notice when the window is closed
  const [plan, setPlan] = useState(FREE_DEFAULT);
  useEffect(() => { api('/api/plan').then((r) => r.json()).then(setPlan).catch(() => {}); }, []);
  const maxLines = plan.limits ? plan.limits.max_lines : null;
  const lineFull = maxLines != null && P.lines.length >= maxLines;
  const [refJob, setRefJob] = useState(null);
  const scrollRef = useRef(null);
  const drag = useRef(null);
  const suppress = useRef(false); // swallow the click that follows a node drag
  const fileSmp = useRef(null);
  const fileRef = useRef(null);
  // a note taken from the reference remembers the pitch it had ("o") the first time its pitch is changed, so that the original sound can follow
  const markMoved = (a, b) => {
    const old = new Map();
    (a.lines || []).forEach((L) => (L.nodes || []).forEach((n) => old.set(n.id, n.notes)));
    (b.lines || []).forEach((L) => (L.nodes || []).forEach((n) => {
      const o = old.get(n.id);
      if (!o || o.length !== n.notes.length) return;
      n.notes.forEach((k, i) => { if (k.o == null && o[i] && o[i].p !== k.p) k.o = o[i].p; });
    }));
  };
  // every change of the project is remembered (the state before it, shared, never changed afterwards); a burst of changes that follow
  // each other within 0.4 s (a drag, typing a number) is one step
  const hist = useRef({ undo: [], redo: [], t: 0 });
  const upd = (fn) => setP((p) => {
    const q = clone(p); fn(q); markMoved(p, q);
    const h = hist.current, now = Date.now();
    if (now - h.t > 400) { h.undo.push(p); if (h.undo.length > 60) h.undo.shift(); h.redo = []; }
    h.t = now;
    return fixSounds(q);
  });
  const undo = () => {
    const h = hist.current, prev = h.undo.pop();
    if (!prev) { ui({ notice: '되돌릴 변경이 없어요' }); return; }
    setP((cur) => { h.redo.push(cur); return prev; });
    h.t = 0;
    ui({ notice: '한 단계 되돌렸어요 (다시 하기: Ctrl+Y)' });
  };
  const redo = () => {
    const h = hist.current, nxt = h.redo.pop();
    if (!nxt) { ui({ notice: '다시 할 변경이 없어요' }); return; }
    setP((cur) => { h.undo.push(cur); return nxt; });
    h.t = 0;
    ui({ notice: '다시 적용했어요' });
  };
  const actRef = useRef({});
  actRef.current = { undo, redo };
  useEffect(() => {
    const k = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = String(e.key).toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select')) return;      // typing in a field keeps the browser's own undo
      if (document.querySelector('.modal-bg')) return;                            // an open window has its own buttons
      e.preventDefault();
      if (key === 'y' || e.shiftKey) actRef.current.redo(); else actRef.current.undo();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const ui = (patch) => setU((u) => ({ ...u, ...patch }));

  // ---- load / save
  useEffect(() => {
    (async () => {
      try {
        const r = await api('/api/project');
        const saved = await r.json();
        if (saved && saved.lines) {
          const base = defaultProject();
          const p = { ...base, ...saved };
          p.lines = (p.lines || []).map((L) => { const { gaps, ...rest } = L; return rest; });   // the old yellow 'empty slot' boxes no longer exist
          if (p.ref && p.ref.id) {
            try {
              const a = await (await api('/api/reference/' + p.ref.id)).json();
              p.ref = { ...p.ref, lanes: a.lanes, duration: a.duration, meta: a.meta, order: a.order, model: a.model, available: a.available };
            } catch (e) { p.ref = null; }
          }
          setP(fixSounds(pruneSamples(p)));
          ui({ selLine: p.lines[0] ? p.lines[0].id : null });
        }
      } catch (e) { /* first run */ }
      setLoaded(true);
    })();
    const f = () => { drag.current = null; };
    window.addEventListener('mouseup', f);
    return () => window.removeEventListener('mouseup', f);
  }, []);
  useEffect(() => {
    if (!loaded) return undefined;
    const t = setTimeout(() => {
      const out = clone(P);
      if (out.ref) delete out.ref.lanes;
      fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) }).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [P, loaded]);
  useEffect(() => {
    Ctl.el.onended = () => ui({ playing: null });
    Ctl.el.onpause = () => { if (Ctl.el.ended || Ctl.el.currentTime === 0) ui({ playing: null }); };
  }, []);

  // ---- derived
  const sampleOf = (id) => P.samples.find((s) => s.id === id) || null;
  const rootOf = (id) => {
    const s = sampleOf(id);
    return s && s.sel && s.sel.root != null ? Math.round(s.sel.root) : 57;
  };
  const lanes = useMemo(() => (P.ref && P.ref.lanes ? toBeats(P.ref) : null), [P.ref && P.ref.id, P.ref && P.ref.bpm, P.ref && P.ref.offset, P.ref && P.ref.lanes]);
  const defs = useMemo(() => refDefs(P.ref), [P.ref]);
  const grid = P.grid || 0.25;   // finest step (in beats) for choosing ranges and moving / resizing nodes
  const rh = clamp(P.rowH || 32, 18, 64);   // height of one pitch row in the piano rolls (세로 크기, slider)
  SMALLH = Math.max(100, Math.round(rh * 2.6));   // "작게" line
  REFH = Math.max(MIN_REF_H + 4, Math.round(rh * 2));   // "작게" reference lane
  PILLH = SMALLH - 32;                          // node block inside a small line
  // lanes arrive loudest-first; only the first few are shown until the user ticks more of them
  const isOn = (d) => (U.refOn[d.key] !== undefined ? U.refOn[d.key] : defs.findIndex((x) => x.key === d.key) < 8 && d.count >= 8);
  const more = P.ref && P.ref.available ? P.ref.available.filter((a) => !(P.ref.lanes && P.ref.lanes[a.key])) : [];
  const renameLane = (key, name) => upd((p) => { p.ref.names = { ...(p.ref.names || {}), [key]: name }; });
  const T = P.ref && P.ref.duration ? clamp(Math.ceil(((P.ref.duration - P.ref.offset) * P.ref.bpm / 60) / 4) * 4, 16, 640) : 32;
  const line = P.lines.find((l) => l.id === U.selLine) || null;
  const node = line ? line.nodes.find((n) => n.id === U.selNode) || null : null;
  const note = node && U.selNote != null ? node.notes[U.selNote] || null : null;
  // all selected notes of the selected node (click = one, Shift / Ctrl + click = several)
  const selIdx = node && U.selNote != null
    ? [U.selNote, ...((U.selMore && U.selMore.node === node.id && U.selMore.primary === U.selNote ? U.selMore.list : []).filter((i) => i !== U.selNote))].filter((i) => node.notes[i])
    : [];
  const guide = U.guide != null ? U.guide : null;   // the vertical guide line (in beats), null = not placed

  // ---- reference job polling
  useEffect(() => {
    if (!refJob) return undefined;
    const t = setInterval(async () => {
      try {
        const s = await (await api('/api/reference/' + refJob.id + '/status')).json();
        if (s.status === 'done') {
          const a = await (await api('/api/reference/' + refJob.id)).json();
          upd((p) => { p.ref = { id: a.id, name: a.name, bpm: a.bpm, offset: a.offset, duration: a.duration, lanes: a.lanes, meta: a.meta, order: a.order, model: a.model, available: a.available }; });
          ui({ refOn: {}, refSel: null });
          setRefJob(null);
          ui({ notice: '참조곡 분석이 끝났어요. 레인에서 구간을 골라 보세요.' });
        } else if (s.status === 'error') {
          setRefJob(null);
          ui({ notice: s.phase });
        } else setRefJob((j) => (j ? { ...j, phase: s.phase, elapsed: s.elapsed } : j));
      } catch (e) { /* keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [refJob && refJob.id]);

  // ---- helpers
  const place = (ln, preferred, l) => {
    const free = (t) => !ln.nodes.some((n) => t < n.s + n.l - EPS && n.s < t + l - EPS);
    if (preferred >= 0 && preferred + l <= T + EPS && free(preferred)) return preferred;
    for (let t = 0; t + l <= T + EPS; t = r6(t + grid)) if (free(t)) return t;
    return -1;
  };
  const refNotes = (key, a, b, root, only) => {
    if (!lanes || !lanes[key]) return [];
    // keepTiming: take every note exactly where it is in the song (so a beat can hold 2, 3, 4 ... notes);
    // otherwise snap starts and lengths to the grid
    const keep = U.keepTiming !== false;
    const qs = (v) => (keep ? r6(v) : r6(Math.round(v / grid) * grid));
    const ql = (v) => Math.max(keep ? 0.0625 : grid, qs(v));
    if (only != null) {   // a single clicked note: never anything else that happens to start inside the same span
      const n = lanes[key][only];
      if (!n) return [];
      if ((defs.find((d) => d.key === key) || {}).kind === 'drum' || key === 'drums') return [{ s: 0, l: 0.25, p: root, o: root }];
      return [{ s: 0, l: Math.max(0.0625, r6(n.l)), p: n.p, o: n.p }];
    }
    if ((defs.find((d) => d.key === key) || {}).kind === 'drum' || key === 'drums') {
      return lanes[key].filter((h) => h.t >= a && h.t < b).map((h) => ({ s: Math.max(0, qs(h.t - a)), l: keep ? 0.25 : Math.max(grid, 0.25), p: root, o: root }));
    }
    // a lane of mixed notes (piano, keys ...): only the melody candidates (one line) when that is chosen, otherwise every note
    const poly = (defs.find((d) => d.key === key) || {}).poly && U.melodyOnly !== false;
    return lanes[key].filter((n) => n.t >= a && n.t < b && (!poly || n.m))
      .map((n) => ({ s: Math.max(0, qs(n.t - a)), l: ql(Math.min(n.l, b - n.t)), p: n.p, o: n.p }));
  };
  const onlyName = (sel) => {
    const n = lanes[sel.key][sel.only];
    const d = defs.find((x) => x.key === sel.key) || {};
    return (d.name || sel.key) + ' ' + (d.kind === 'drum' ? n.k || '타격' : noteName(n.p));
  };
  const srcName = (src) => ((defs.find((d) => d.key === src.key) || {}).name || src.key) + ' ' + rangeText(src.a, src.b);

  // copy a whole reference lane (e.g. the bass of a precise analysis) to a NEW line of mine: one node bundle holding every note of the lane
  const copyLaneToLine = (key) => {
    if (!lanes || !lanes[key]) return;
    const d = defs.find((x) => x.key === key) || { name: key, kind: 'pitch' };
    const sid = (line && line.sampleId) || (P.samples[0] ? P.samples[0].id : null);
    if (!sid) { ui({ notice: '먼저 샘플을 추가해 주세요. 새 라인의 소리로 쓸 샘플이 필요해요' }); return; }
    if (lineFull) { ui({ planOpen: true, notice: '무료 플랜은 내 라인을 ' + maxLines + '개까지 만들 수 있어요' }); return; }
    const ns = refNotes(key, 0, T, rootOf(sid), null);
    if (!ns.length) { ui({ notice: d.name + '에는 가져올 음이 없어요' }); return; }
    const id = uid('L'), nid = uid('n');
    upd((p) => {
      p.lines.push({ id, name: d.name, color: COLORS[p.lines.length % COLORS.length], size: 'small', sampleId: sid,
        nodes: [{ id: nid, name: d.name + ' 전체', s: 0, l: T, notes: ns, refAt: 0, src: { key, a: 0, b: T }, sampleId: 'ref', refFill: true }] });
    });
    ui({ selLine: id, selNode: nid, selNote: null, notice: "'" + d.name + "' 레인을 새 라인으로 복사했어요 (노드 " + ns.length + '개' + (d.poly && U.melodyOnly !== false ? ', 멜로디 후보만' : '') + ')' + (P.ref && Math.abs(P.bpm - P.ref.bpm) > 0.05 ? "\n내 곡 박자(" + P.bpm + ")가 참조곡(" + (Math.round(P.ref.bpm * 10) / 10) + ")과 달라 소리가 빠르거나 느려져요. 위의 '참조곡 박자에 맞추기'를 누르면 원래 소리 그대로 들려요" : '') });
  };

  // reference range + sample: ask where it should go (one of my lines, or only the node library), then make the node bundle there
  const prepFromSel = (sampleId) => {
    const sel = U.refSel;
    if (!sel || !lanes) { ui({ notice: '먼저 참조곡에서 구간을 골라 주세요' }); return null; }
    const ln = line || P.lines[0];
    const sid = sampleId || (ln ? ln.sampleId : null) || (P.samples[0] ? P.samples[0].id : null);
    if (!sid) { ui({ notice: '먼저 샘플을 추가하고, 샘플을 끌어다 놓아 주세요' }); return null; }
    const ns = refNotes(sel.key, sel.a, sel.b, rootOf(sid), sel.only);
    if (!ns.length) { ui({ notice: ((defs.find((d) => d.key === sel.key) || {}).name || '') + '에는 이 구간에 가져올 음이 없어요' }); return null; }
    const l = Math.max(0.0625, r6(sel.b - sel.a));
    const name = sel.only != null ? onlyName(sel) : srcName({ key: sel.key, a: sel.a, b: sel.b });
    return { sel, sid, ns, l, name };
  };
  const createFromSel = (sampleId) => {
    const pr = prepFromSel(sampleId);
    if (!pr) return;
    ui({ dropChoice: { rhythm: !!U.rhythmPref, pitch: U.rhythmPitch !== false, sampleId: sampleId || null, name: pr.name, file: (sampleOf(pr.sid) || {}).file || '', count: pr.ns.length, l: pr.l, err: '' } });
  };
  const commitFromSel = async (target) => {
    const c = U.dropChoice;
    if (!c) return;
    const pr = prepFromSel(c.sampleId);
    if (!pr) { ui({ dropChoice: null }); return; }
    const { sel, sid, l, name } = pr;
    let ns = pr.ns, useSample = c.sampleId || null, pieces = null, pieceSample = null;
    // a cut with several sounds (ya / im / ma): the pieces go to the melody notes one by one, in order (and start over when the melody has more notes)
    const ss = sampleOf(sid);
    let rhythmDone = false;
    if (c.rhythm && P.ref && sel.only == null && ss && ss.sel) {
      // the rhythm of the speech: one note where every syllable of the reference starts (as long as the syllable), and the syllables of the
      // sample (found the same way) are handed to them one by one, starting over when the sample has fewer; the pitch stays the sample's own
      try {
        const f = 60 / P.ref.bpm;
        const t0 = P.ref.offset + sel.a * f, t1 = P.ref.offset + sel.b * f;
        const rs = await (await api('/api/reference/' + P.ref.id + '/syllables/' + sel.key + '?t0=' + t0.toFixed(4) + '&t1=' + t1.toFixed(4))).json();
        const sp = await (await api('/api/sample-split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: ss.file, start: ss.sel.start, end: ss.sel.end, mode: 'syllable' }) })).json();
        const root = rootOf(sid);
        if (rs.segs && rs.segs.length && sp.parts && sp.parts.length) {
          pieces = sp.parts.map((q) => ({ cs: r6(q.a - ss.sel.start), ce: r6(q.b - ss.sel.start) }));
          // the pitch of every syllable follows the voice of the reference (a syllable without a pitch keeps the one before it)
          let cur = rs.segs.find((g) => g.pitch != null);
          cur = cur ? Math.round(cur.pitch) : root;
          ns = rs.segs.map((g, j) => {
            if (c.pitch !== false && g.pitch != null) cur = Math.round(g.pitch);
            return { s: Math.max(0, r6((g.a - P.ref.offset) / f - sel.a)), l: Math.max(0.0625, r6((g.b - g.a) / f)), p: c.pitch !== false ? clamp(cur, 24, 96) : root, cs: pieces[j % pieces.length].cs, ce: pieces[j % pieces.length].ce };
          });
          const same = P.samples.find((x) => x.piece && x.file === ss.file && x.sel && Math.abs(x.sel.start - ss.sel.start) < 1e-6 && Math.abs(x.sel.end - ss.sel.end) < 1e-6 && !(x.bend && x.bend.length));
          const pid = same ? same.id : uid('s');
          pieceSample = same ? null : { id: pid, piece: true, label: ss.file.replace(/\.[^.]+$/, '') + ' ' + fmt(ss.sel.start) + '~' + fmt(ss.sel.end) + '초', file: ss.file, duration: ss.duration, segments: ss.segments, peaks: ss.peaks, sel: { ...ss.sel } };
          useSample = pid;
          rhythmDone = true;
        }
      } catch (e) { ui({ notice: '말 박자를 찾지 못했어요. 음 단위로 놓을게요. (' + e.message + ')' }); }
    }
    if (!rhythmDone && ss && ss.sel && ns.length > 1) {
      try {
        const r = await (await api('/api/sample-split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: ss.file, start: ss.sel.start, end: ss.sel.end }) })).json();
        if (r.parts && r.parts.length > 1) {
          pieces = r.parts.map((q) => ({ cs: r6(q.a - ss.sel.start), ce: r6(q.b - ss.sel.start) }));
          ns = assignPieces(ns, pieces);
          const same = P.samples.find((x) => x.piece && x.file === ss.file && x.sel && Math.abs(x.sel.start - ss.sel.start) < 1e-6 && Math.abs(x.sel.end - ss.sel.end) < 1e-6 && !(x.bend && x.bend.length));
          const pid = same ? same.id : uid('s');
          // the node keeps its own cut, so a later change of the sample's range cannot change what it plays
          pieceSample = same ? null : { id: pid, piece: true, label: ss.file.replace(/\.[^.]+$/, '') + ' ' + fmt(ss.sel.start) + '~' + fmt(ss.sel.end) + '초', file: ss.file, duration: ss.duration, segments: ss.segments, peaks: ss.peaks, sel: { ...ss.sel } };
          useSample = pid;
        }
      } catch (e) { pieces = null; }
    }
    const libId = uid('d');
    const entry = { id: libId, name, l, notes: clone(ns), at: sel.a, fit: null, sampleId: useSample };
    if (target === 'lib') {
      upd((p) => { if (pieceSample) p.samples.push(pieceSample); p.lib.push(entry); });
      ui({ dropChoice: null, libSel: libId, armed: null, notice: "'" + name + "' 노드 뭉치를 노드 모음에 넣었어요. 끌어서 라인에 놓거나, '노드 편집'으로 노드를 하나씩 고쳐 보세요" });
      return;
    }
    const ln = P.lines.find((x) => x.id === target);
    if (!ln) { ui({ dropChoice: null }); return; }
    const s = place(ln, sel.a, l);
    if (s < 0) { ui({ dropChoice: { ...c, err: "'" + ln.name + "' 라인에 빈 자리가 없어요. 다른 라인이나 노드 모음을 골라 주세요" } }); return; }
    const id = uid('n');
    upd((p) => {
      const L = p.lines.find((x) => x.id === ln.id);
      // a node made from one single note has no reference range to rebuild from (trimming would pull in neighbours)
      L.nodes.push({ id, name, s, l, notes: ns, refAt: sel.a, ...(sel.only != null ? {} : { src: { key: sel.key, a: sel.a, b: sel.b } }), ...(pieces ? { pieces } : {}), sampleId: useSample });
      if (!L.sampleId) L.sampleId = sid;
      if (pieceSample) p.samples.push(pieceSample);
      p.lib.push(entry);
    });
    ui({ dropChoice: null, selLine: ln.id, selNode: id, selNote: null, libSel: libId, armed: null, notice: "'" + (sampleOf(sid) || {}).file + "' 으로 '" + name + "' 노드 뭉치를 '" + ln.name + "' 라인 " + fmt(s + 1) + '박째에 놓았어요 (노드 모음에도 저장했어요)' });
  };
  const saveRefToLib = () => {
    const sel = U.refSel;
    if (!sel || !lanes) return;
    const ln = line || P.lines[0];
    const ns = refNotes(sel.key, sel.a, sel.b, rootOf(ln ? ln.sampleId : null), sel.only);
    if (!ns.length) { ui({ notice: '이 구간에는 저장할 음이 없어요' }); return; }
    const name = sel.only != null ? onlyName(sel) : srcName({ key: sel.key, a: sel.a, b: sel.b });
    upd((p) => { p.lib.push({ id: uid('d'), name, l: Math.max(0.0625, r6(sel.b - sel.a)), notes: ns, at: sel.a }); });
    ui({ notice: "'" + name + "' 을(를) 노드 모음에 저장했어요 (왼쪽 노드 모음에서 확인)" });
  };
  const addFromLib = (d, target) => {
    const ln = target || line || P.lines[0];
    if (!ln) return;
    const s = place(ln, -1, d.l);
    if (s < 0) { ui({ notice: "'" + ln.name + "' 라인에 빈 자리가 없어요" }); return; }
    const id = uid('n');
    upd((p) => { p.lines.find((x) => x.id === ln.id).nodes.push({ id, name: d.name, s, l: d.l, notes: clone(d.notes), refAt: d.at != null ? d.at : null, ...(d.fit ? { fit: d.fit } : {}), sampleId: sampleOf(d.sampleId) ? d.sampleId : null }); });
    ui({ selLine: ln.id, selNode: id, selNote: null, notice: "'" + d.name + "' 을(를) '" + ln.name + "' 라인에 놓았어요" });
  };
  // how many notes a bundle keeps when it is made shorter (a bundle with no note left would be empty and silent)
  const keepsNotes = (nd, newL) => {
    const rt = rootOf(nd.sampleId || line.sampleId);
    if (nd.src && !nd.edited) return refNotes(nd.src.key, nd.src.a, r6(nd.src.a + newL), rt).length;
    return nd.notes.filter((k) => k.s < newL - EPS).length;
  };
  const trim = (delta) => {
    if (!line || !node) return;
    const newL = r6(node.l + delta);
    if (newL < grid - EPS || node.s + newL > T + EPS) return;
    if (delta < 0 && keepsNotes(node, newL) === 0) { ui({ notice: '더 줄이면 뭉치 안에 노드가 하나도 남지 않아요. 뭉치를 지우려면 "라인에서 빼기"를 누르세요' }); return; }
    const end = r6(node.s + node.l);
    if (delta > 0 && line.nodes.some((q) => q.id !== node.id && end < q.s + q.l - EPS && q.s < end + delta - EPS)) return;
    const rt = rootOf(node.sampleId || line.sampleId);
    upd((p) => {
      const L = p.lines.find((x) => x.id === line.id);
      const nd = L.nodes.find((x) => x.id === node.id);
      if (delta < 0) {
        if (nd.src && !nd.edited) {
          nd.src.b = r6(nd.src.a + newL);
          nd.notes = applyPieces(nd, shifted(refNotes(nd.src.key, nd.src.a, nd.src.b, rt), nd.shift));
        } else nd.notes = nd.notes.filter((k) => k.s < newL).map((k) => ({ ...k, l: Math.min(k.l, newL - k.s) }));
        nd.l = newL;
      } else {
        if (nd.src && !nd.edited) { nd.src.b = r6(nd.src.b + delta); nd.notes = applyPieces(nd, shifted(refNotes(nd.src.key, nd.src.a, nd.src.b, rt), nd.shift)); }
        nd.l = newL;
      }
    });
  };
  const editNode = (fn) => upd((p) => { fn(p.lines.find((x) => x.id === line.id).nodes.find((x) => x.id === node.id)); });
  const editNote = (fn) => editNode((nd) => fn(nd.notes[U.selNote], nd));

  // ---- moving nodes by dragging
  const findFree = (ln, s, l, ignoreId) => {
    const free = (t) => t >= -EPS && t + l <= T + EPS && !ln.nodes.some((q) => q.id !== ignoreId && t < q.s + q.l - EPS && q.s < t + l - EPS);
    for (let d = 0; d <= T; d = r6(d + grid)) {
      if (free(r6(s + d))) return r6(s + d);
      if (d && free(r6(s - d))) return r6(s - d);
    }
    return -1;
  };
  const startNodeDrag = (e, L, n) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    const sc = scrollRef.current;
    const sl0 = sc ? sc.scrollLeft : 0;
    let moved = false, cur = null;
    const lineAt = (x, y) => {
      for (const el of document.elementsFromPoint(x, y)) {
        const lid = el.getAttribute && el.getAttribute('data-line');
        if (lid) return lid;
      }
      return null;
    };
    const move = (ev) => {
      if (ev.buttons === 0) { up(); return; } // the button was released somewhere we did not see
      if (!moved && Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
      moved = true;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (ev.clientX > r.right - 50) sc.scrollLeft += 18;
        else if (ev.clientX < r.left + HEADW + 30) sc.scrollLeft -= 18;
      }
      const dx = ev.clientX - sx + (sc ? sc.scrollLeft - sl0 : 0);
      let want = clamp(r6(n.s + Math.round(dx / PX / grid) * grid), 0, T - n.l);
      if (guide != null) {   // magnet: the node's start or end sticks to the guide line when it comes close
        const thr = 8 / PX;
        if (Math.abs(want - guide) < thr) want = clamp(guide, 0, T - n.l);
        else if (Math.abs(want + n.l - guide) < thr) want = clamp(r6(guide - n.l), 0, T - n.l);
      }
      const lid = lineAt(ev.clientX, ev.clientY) || (cur ? cur.line : L.id);
      const target = P.lines.find((x) => x.id === lid);
      const s = target ? findFree(target, want, n.l, n.id) : -1;
      cur = { id: n.id, from: L.id, line: lid, s: s < 0 ? n.s : s, l: n.l, ok: s >= 0 };
      ui({ drag: cur });
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key);
    };
    const cancel = () => { cleanup(); ui({ drag: null }); };
    const key = (ev) => { if (ev.key === 'Escape') cancel(); };
    const up = () => {
      cleanup();
      if (!moved) return;
      suppress.current = true;
      setTimeout(() => { suppress.current = false; }, 0);
      if (cur && cur.ok && (cur.s !== n.s || cur.line !== L.id)) {
        const d = cur;
        upd((p) => {
          const src = p.lines.find((x) => x.id === d.from), dst = p.lines.find((x) => x.id === d.line);
          const nd = src && src.nodes.find((x) => x.id === d.id);
          if (!nd || !dst) return;
          src.nodes = src.nodes.filter((x) => x.id !== d.id);
          if (d.line !== d.from && !nd.sampleId) nd.sampleId = src.sampleId; // keep its own sound when changing line
          nd.s = d.s;
          dst.nodes.push(nd);
        });
        ui({ drag: null, selLine: d.line, selNode: d.id, selNote: null, notice: d.line !== d.from ? "다른 라인으로 옮겼어요 (소리는 그대로예요)" : '' });
      } else ui({ drag: null });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key);
  };

  // ---- click on empty space (or Esc) clears the selection
  const clearSelection = () => ui({ refSel: null, refNote: null, selNode: null, selNote: null, hoverNode: null, armed: null, dropChoice: null });
  const deselect = (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('button, input, select, label, a, .lane.ref, .modal, .tip, .ruler')) return;
    if (t.classList.contains('tl-scroll') && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight)) return; // scrollbar
    clearSelection();
  };
  useEffect(() => {
    const k = (e) => {
      if (e.key !== 'Escape' || (e.target && e.target.closest && e.target.closest('input, select'))) return;
      clearSelection();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // ---- previews: reference range / single node
  // reference range preview through WebAudio: the part is cut sample-accurately (no 250 ms overshoot) and only one source can ever sound
  const killRange = () => {
    Rng.token++;
    if (Rng.src) { try { Rng.src.onended = null; Rng.src.stop(); } catch (e) {} Rng.src = null; }
    Rng.on = false;
  };
  const stopRange = () => { killRange(); ui({ rangePlaying: null }); };
  const rangeBuffer = async (url) => {
    if (!Rng.ctx) Rng.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (Rng.ctx.state === 'suspended') await Rng.ctx.resume();
    if (!Rng.bufs.has(url)) {
      const raw = await (await fetch(url)).arrayBuffer();
      Rng.bufs.set(url, await Rng.ctx.decodeAudioData(raw));
    }
    return Rng.bufs.get(url);
  };
  const playRange = async (mode, raw) => {
    const sel = U.refSel;
    if (!sel || !P.ref) return;
    // a single note of a pitched lane: play only that note (other notes of the lane that overlap it are turned down)
    if (mode === 'stem' && !raw && sel.only != null && lanes && lanes[sel.key] && lanes[sel.key][sel.only] && lanes[sel.key][sel.only].p != null) { playIso(sel.key, lanes[sel.key][sel.only]); return; }
    if (U.rangePlaying === mode) { stopRange(); return; }
    Ctl.el.pause();
    Prev.pause();
    killRange();
    const tok = Rng.token;
    const f = 60 / P.ref.bpm;
    const t0 = Math.max(0, P.ref.offset + sel.a * f), t1 = P.ref.offset + sel.b * f;
    ui({ rangePlaying: mode, listen: null, playing: null, notice: '소리 불러오는 중…' });
    try {
      const buf = await rangeBuffer(mode === 'orig' ? '/api/reference/' + P.ref.id + '/audio' : '/api/reference/' + P.ref.id + '/stem/' + sel.key);
      if (tok !== Rng.token) return;   // another preview started meanwhile
      const dur = Math.max(0.03, Math.min(t1, buf.duration) - t0);
      const src = Rng.ctx.createBufferSource(), gain = Rng.ctx.createGain();
      src.buffer = buf; src.connect(gain); gain.connect(Rng.ctx.destination);
      const now = Rng.ctx.currentTime;
      gain.gain.setValueAtTime(1, now);
      gain.gain.setValueAtTime(1, now + Math.max(0, dur - 0.03));
      gain.gain.linearRampToValueAtTime(0, now + dur);
      src.onended = () => { if (tok === Rng.token) stopRange(); };
      Rng.offset = P.ref.offset; Rng.bpm = P.ref.bpm; Rng.t0 = t0; Rng.startCtx = now; Rng.src = src; Rng.on = true;
      src.start(now, t0, dur);
      ui({ notice: '' });
    } catch (e) { killRange(); ui({ rangePlaying: null, notice: '미리듣기 실패: ' + e.message }); }
  };
  // one note cut out of the recording: other notes that sound at the same moment are turned down (server side, harmonic mask)
  const playIso = async (key, n) => {
    if (!P.ref) return;
    if (U.rangePlaying === 'iso') { stopRange(); return; }
    Ctl.el.pause(); Prev.pause(); killRange();
    const tok = Rng.token, f = 60 / P.ref.bpm;
    const ts = P.ref.offset + n.t * f;
    ui({ rangePlaying: 'iso', listen: null, playing: null, notice: '이 음만 따로 떼는 중… (처음 한 번은 몇 초 걸려요)' });
    try {
      const buf = await rangeBuffer('/api/reference/' + P.ref.id + '/note/' + key + '?t=' + ts.toFixed(4) + '&l=' + ((n.l || 0.25) * f).toFixed(4) + '&p=' + n.p);
      if (tok !== Rng.token) return;
      const src = Rng.ctx.createBufferSource();
      src.buffer = buf; src.connect(Rng.ctx.destination);
      src.onended = () => { if (tok === Rng.token) stopRange(); };
      Rng.offset = P.ref.offset; Rng.bpm = P.ref.bpm; Rng.t0 = ts; Rng.startCtx = Rng.ctx.currentTime; Rng.src = src; Rng.on = true;
      src.start();
      ui({ notice: '' });
    } catch (e) { killRange(); ui({ rangePlaying: null, notice: '이 음만 떼지 못했어요. 서버를 껐다 켠 뒤 다시 해 보세요. (' + e.message + ')' }); }
  };
  // just the pitch of the selected reference note as a plain tone (the recorded stem may hold other notes at the same moment)
  const playTone = async (midi, beats) => {
    if (!Rng.ctx) Rng.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (Rng.ctx.state === 'suspended') await Rng.ctx.resume();
    Ctl.el.pause(); Prev.pause(); killRange();
    const f = 440 * Math.pow(2, (midi - 69) / 12), dur = Math.max(0.15, Math.min(4, (beats || 0.5) * 60 / (P.ref ? P.ref.bpm : P.bpm)));
    const o = Rng.ctx.createOscillator(), g = Rng.ctx.createGain(), now = Rng.ctx.currentTime;
    o.type = 'triangle'; o.frequency.value = f; o.connect(g); g.connect(Rng.ctx.destination);
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(0.3, now + 0.01); g.gain.setValueAtTime(0.3, now + Math.max(0.011, dur - 0.04)); g.gain.linearRampToValueAtTime(0, now + dur);
    o.start(now); o.stop(now + dur + 0.02);
  };
  const playNode = async () => {
    if (!line || !node) return;
    if (U.playing === 'node') { Ctl.el.pause(); Ctl.el.currentTime = 0; ui({ playing: null }); return; }
    const sp = node.sampleId === 'ref' ? refSpec(node) : specOf(node.sampleId || line.sampleId);
    if (!sp) { ui({ notice: '이 노드에 쓸 샘플이 없어요' }); return; }
    Ctl.el.pause();
    if (U.rangePlaying) stopRange();
    ui({ rendering: 'node', notice: '소리 만드는 중…' });
    try {
      const url = await renderUrl({ bpm: P.bpm, target: 'all', lines: [{ id: 'n', sample: sp, fit: line.fit || 'stretch', ...mixOf(line), mute: false, solo: false, nodes: [{ s: 0, l: node.l, notes: noteSpecs(node), sample: null, fit: node.fit || null, fill: node.sampleId === 'ref' && !!node.refFill }] }] });
      Ctl.bpm = P.bpm;
      Ctl.startBeat = node.s;
      Ctl.el.src = url;
      Ctl.el.currentTime = 0;
      await Ctl.el.play();
      ui({ playing: 'node', rendering: null, notice: '' });
    } catch (err) { ui({ rendering: null, notice: err.message }); }
  };

  // the selected node(s) of a bundle on their own, each with its own sound (or the bundle's)
  const playNote = async () => {
    if (!line || !node || !selIdx.length) return;
    if (U.playing === 'node') { Ctl.el.pause(); Ctl.el.currentTime = 0; ui({ playing: null }); return; }
    const ks = selIdx.map((i) => node.notes[i]);
    const t0 = Math.min(...ks.map((k) => k.s));
    const sp = (id) => { if (id !== 'ref') return specOf(id); const r = refSpec(node); return r ? { ...r, at: r.at + t0 } : null; };
    const base = sp(node.sampleId || line.sampleId);
    const notes = ks.map((k) => ({ ...k, s: r6(k.s - t0), ...(k.sampleId ? { sample: sp(k.sampleId) } : {}) }));
    if (!base && !notes.some((k) => k.sample)) { ui({ notice: '이 노드에 쓸 샘플이 없어요' }); return; }
    Ctl.el.pause();
    if (U.rangePlaying) stopRange();
    ui({ rendering: 'node', notice: '소리 만드는 중…' });
    try {
      const url = await renderUrl({ bpm: P.bpm, target: 'all', lines: [{ id: 'n', sample: base, fit: line.fit || 'stretch', ...mixOf(line), mute: false, solo: false, nodes: [{ s: 0, l: Math.max(...ks.map((k) => k.s + k.l)) - t0, notes, sample: null, fit: node.fit || null, tight: true }] }] });
      Ctl.bpm = P.bpm;
      Ctl.startBeat = node.s + t0;
      Ctl.el.src = url;
      Ctl.el.currentTime = 0;
      await Ctl.el.play();
      ui({ playing: 'node', rendering: null, notice: '' });
    } catch (err) { ui({ rendering: null, notice: err.message }); }
  };

  // ---- samples / reference upload
  const addSamples = async (files) => {
    for (const f of files) {
      ui({ notice: "'" + f.name + "' 분석 중…" });
      try {
        const fd = new FormData(); fd.append('file', f);
        const a = await (await api('/api/samples', { method: 'POST', body: fd })).json();
        const seg = a.segments[a.default];
        const id = uid('s');
        upd((p) => {
          p.samples = p.samples.filter((s) => s.piece || s.file !== a.file);
          p.samples.push({ id, file: a.file, duration: a.duration, segments: a.segments, peaks: a.peaks, sel: { start: seg.start, end: seg.end, root: seg.root } });
          p.lines.forEach((L) => { if (!L.sampleId) L.sampleId = id; });
        });
        ui({ notice: a.duration > 1.5 ? "'" + a.file + "' 은 길어서 첫 소리 조각을 골라 뒀어요. '자르기'로 바꿀 수 있어요." : '' });
      } catch (e) { ui({ notice: e.message }); }
    }
  };
  // remove a sample from the list; nodes that used it fall back to their line's sound (the audio file itself stays, trimmed pieces may still need it)
  const deleteSample = (s) => {
    const used = P.lines.reduce((a, L) => a + L.nodes.filter((n) => n.sampleId === s.id).length, 0) + P.lib.filter((d) => d.sampleId === s.id).length;
    const rest = P.samples.filter((x) => !x.piece && x.id !== s.id).length;
    const more = used ? '\n이 소리를 쓰던 노드 ' + used + '개는 다른 소리로 바뀌어요.' + (rest ? '' : '\n(남은 샘플이 없어 소리가 없어져요)') : '';
    if (!window.confirm("'" + s.file + "' 샘플을 목록에서 지울까요?" + more)) return;
    upd((p) => {
      p.samples = p.samples.filter((x) => x.id !== s.id);
      p.lines.forEach((L) => {
        if (L.sampleId === s.id) L.sampleId = null;
        L.nodes.forEach((n) => { if (n.sampleId === s.id) n.sampleId = null; });
      });
      p.lib.forEach((d) => { if (d.sampleId === s.id) d.sampleId = null; });
    });
    ui({ armed: U.armed === s.id ? null : U.armed, cutting: U.cutting === s.id ? null : U.cutting, notice: "'" + s.file + "' 을(를) 샘플 목록에서 지웠어요" });
  };
  // A sample piece turned into a node goes to the node library: one note at the sample's own pitch (so it plays
  // unchanged), as long as the piece itself (rounded up to the grid). Drag it from the library onto a line afterwards.
  const makeSampleLibNode = (s, sel, root, parts) => {
    const beats = Math.max(grid, r6(Math.ceil((((sel.end - sel.start) * P.bpm) / 60) / grid - EPS) * grid));
    const base = s.file.replace(/\.[^.]+$/, '');
    // positions and lengths are the recorded ones (not rounded to the grid), so the sound keeps its own timing and plays as recorded
    const bt = (sec) => r6((sec * P.bpm) / 60);
    let notes = [{ s: 0, l: Math.max(0.0625, bt(sel.end - sel.start)), p: root != null ? Math.round(root) : 57 }], total = beats;
    if (parts && parts.length > 1) {
      // several pieces: one note each, every note playing its own part of the cut at its own place
      notes = parts.map((q) => ({ s: bt(q.a - sel.start), l: Math.max(0.0625, bt(q.b - q.a)), p: q.root != null ? Math.round(q.root) : 57, cs: r6(q.a - sel.start), ce: r6(q.b - sel.start) }));
      total = Math.max(grid, r6(Math.ceil(bt(sel.end - sel.start) / grid - EPS) * grid));
    }
    // the node gets a piece of its own (same file, its own cut), so cutting or "use this range" on the sample later cannot change how it sounds
    const same = P.samples.find((x) => x.piece && x.file === s.file && x.sel && Math.abs(x.sel.start - sel.start) < 1e-6 && Math.abs(x.sel.end - sel.end) < 1e-6 && !(x.bend && x.bend.length));
    const pid = same ? same.id : uid('s'), label = base + ' ' + fmt(sel.start) + '~' + fmt(sel.end) + '초';
    upd((p) => {
      if (!same) p.samples.push({ id: pid, piece: true, label, file: s.file, duration: s.duration, segments: s.segments, peaks: s.peaks, sel: { start: sel.start, end: sel.end, root } });
      p.lib.push({ id: uid('d'), name: label, l: total, notes, sampleId: pid });
    });
    ui({ notice: "'" + base + "' 조각을 노드로 만들어 노드 모음에 넣었어요 (" + fmt(beats) + '박). 왼쪽 노드 모음에서 라인으로 끌어다 놓으세요' });
  };
  // Before the range of a sample is changed, every node (and library entry) that plays it keeps the range it has now: it gets a piece of its own,
  // so choosing another part of the same sample for the next line cannot change the lines made before.
  const freezeUsers = (p, s) => {
    const x = p.samples.find((q) => q.id === s.id);
    if (!x || !x.sel) return;
    const users = [];
    p.lines.forEach((L) => L.nodes.forEach((n) => { if (n.sampleId === x.id) users.push(n); (n.notes || []).forEach((k) => { if (k.sampleId === x.id) users.push(k); }); }));
    p.lib.forEach((d) => { if (d.sampleId === x.id) users.push(d); });
    if (!users.length) return;
    const bj = JSON.stringify(x.bend || []);
    const same = p.samples.find((q) => q.piece && q.file === x.file && q.sel && Math.abs(q.sel.start - x.sel.start) < 1e-6 && Math.abs(q.sel.end - x.sel.end) < 1e-6 && JSON.stringify(q.bend || []) === bj);
    const pid = same ? same.id : uid('s');
    if (!same) p.samples.push({ id: pid, piece: true, label: x.file.replace(/\.[^.]+$/, '') + ' ' + fmt(x.sel.start) + '~' + fmt(x.sel.end) + '초', file: x.file, duration: x.duration, segments: x.segments, peaks: x.peaks, sel: { ...x.sel }, ...(x.bend && x.bend.length ? { bend: clone(x.bend) } : {}) });
    users.forEach((u) => { u.sampleId = pid; });
  };
  const releaseUse = (s, sg) => {
    upd((p) => { freezeUsers(p, s); const x = p.samples.find((q) => q.id === s.id); x.sel = { start: sg.start, end: sg.end, root: sg.root }; x.used = false; delete x.bend; });
    ui({ notice: '쓰는 구간을 풀고 처음 상태(첫 소리 조각)로 되돌렸어요' });
  };
  const applyCut = async (s, sel, makeNode, marks) => {
    try {
      const infoOf = async (a, b) => (await api('/api/sample-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: s.file, start: a, end: b }) })).json();
      const info = await infoOf(sel.start, sel.end);
      let parts = null;
      const cuts = makeNode ? (marks || []).filter((m) => m > sel.start + 0.03 && m < sel.end - 0.03).sort((a, b) => a - b) : [];
      if (cuts.length) {
        const bounds = [sel.start, ...cuts, sel.end];
        parts = [];
        for (let i = 0; i < bounds.length - 1; i++) { const q = await infoOf(bounds[i], bounds[i + 1]); parts.push({ a: bounds[i], b: bounds[i + 1], root: q.root }); }
      } else if (makeNode) {
        // no marks given: follow the sound's own pitch, one note wherever the pitch moves
        const r = await (await api('/api/sample-split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: s.file, start: sel.start, end: sel.end }) })).json();
        if (r.parts && r.parts.length > 1) {
          parts = [];
          // the pitch of every piece is measured the way the player measures it, so an unchanged note plays as recorded
          for (const q of r.parts) { const m = await infoOf(q.a, q.b); parts.push({ a: q.a, b: q.b, root: m.root }); }
        }
      }
      const unp = info.pitched ? '' : '이 조각은 음높이를 찾지 못했어요. 라(A3)를 기준으로 소리를 빠르게 또는 느리게 해서 음을 맞춰요 (높은 음은 짧고 높게, 낮은 음은 길고 낮게 들려요)';
      if (makeNode) {
        // the node keeps its own cut, so the sample's range in use is left as it is
        ui({ cutting: null, notice: unp });
        makeSampleLibNode(s, sel, info.root, parts);
      } else {
        upd((p) => { freezeUsers(p, s); const x = p.samples.find((q) => q.id === s.id); x.sel = { start: sel.start, end: sel.end, root: info.root }; x.used = true; delete x.bend; });   // a new range makes the old pitch curve meaningless
        ui({ notice: unp || '이 구간을 쓰는 구간으로 정했어요. 파형의 주황색 부분이에요' });   // the window stays open so the coloured range can be seen
      }
    } catch (e) { ui({ cutting: null, notice: e.message }); }
  };
  const addRef = async (file) => {
    ui({ notice: "'" + file.name + "' 올리는 중…" });
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('model', U.refModel);
      const { id } = await (await api('/api/reference', { method: 'POST', body: fd })).json();
      setRefJob({ id, name: file.name, phase: '대기 중', elapsed: 0 });
      ui({ notice: '' });
    } catch (e) { ui({ notice: e.message }); }
  };
  const listenStem = (key) => {
    if (U.listen === key) { Prev.pause(); ui({ listen: null }); return; }
    Prev.pause();
    killRange();
    Prev.onloadedmetadata = null; Prev.ontimeupdate = null;
    Prev.src = '/api/reference/' + P.ref.id + '/stem/' + key;
    Prev.onended = () => ui({ listen: null });
    Prev.play();
    ui({ listen: key });
  };

  // ---- analyse the already uploaded song again with the chosen separation model
  const reanalyze = async () => {
    try {
      await api('/api/reference/' + P.ref.id + '/reanalyze?model=' + U.refModel, { method: 'POST' });
      setRefJob({ id: P.ref.id, name: P.ref.name, phase: '대기 중', elapsed: 0 });
      ui({ notice: '' });
    } catch (e) { ui({ notice: e.message }); }
  };

  // ---- transcribe one more stem of the separated song on demand
  const analyzeStem = async (key) => {
    ui({ analyzing: key, notice: '음 뽑는 중… (20~60초)' });
    try {
      const a = await (await api('/api/reference/' + P.ref.id + '/analyze/' + key, { method: 'POST' })).json();
      upd((p) => { p.ref.lanes = a.lanes; p.ref.meta = a.meta; p.ref.order = a.order; p.ref.available = a.available; });
      ui({ analyzing: null, refOn: { ...U.refOn, [key]: true }, notice: '' });
    } catch (e) { ui({ analyzing: null, notice: e.message }); }
  };

  // ---- add notes where the transcription missed a sounding stretch (cut from the measured pitch line)
  const fillStem = async (key) => {
    ui({ analyzing: key + ':fill', notice: '빈 곳 채우는 중… (1분 곡 기준 20초쯤)' });
    try {
      const a = await (await api('/api/reference/' + P.ref.id + '/fill/' + key, { method: 'POST' })).json();
      upd((p) => { p.ref.lanes = a.lanes; p.ref.meta = a.meta; });
      ui({ analyzing: null, notice: (a.meta[key].filled || 0) + '개의 음을 더했어요. 더한 음은 소리가 없던 자리에만 들어가요' });
    } catch (e) { ui({ analyzing: null, notice: e.message }); }
  };

  // ---- playback
  const specOf = (sid) => {
    const s = sampleOf(sid);
    return s && s.sel ? { file: s.file, start: s.sel.start, end: s.sel.end, ...(s.bend && s.bend.length ? { bend: s.bend.map((a) => ({ t: a.t, a: a.a, s: a.s })) } : {}) } : null;
  };
  // the original sound of the reference lane a node was taken from (the stem of that lane, cut at the node's place in the song)
  const refSpec = (n) => (P.ref && n && n.src ? { ref: P.ref.id, stem: n.src.key, at: n.refAt || 0, bpm: P.ref.bpm, off: P.ref.offset } : null);
  // notes of a bundle, those with a sound of their own carry it along for the player
  const origOf = (n, k) => {
    if (k.o != null) return k.o;
    const ln = lanes && n.src && lanes[n.src.key];
    if (!ln) return null;
    const t = (n.refAt || 0) + k.s;
    // only when exactly one note of the lane starts there (in a chord it is unknown which of them this note was)
    const hit = ln.filter((q) => Math.abs(q.t - t) <= 0.1);
    return hit.length === 1 ? hit[0].p : null;
  };
  const noteSpecs = (n) => n.notes.map((k) => {
    const ref = (k.sampleId || n.sampleId) === 'ref';
    const o = ref ? origOf(n, k) : null;
    const base = o != null && k.o == null ? { ...k, o } : k;
    return k.sampleId ? { ...base, sample: k.sampleId === 'ref' ? refSpec(n) : specOf(k.sampleId) } : base;
  });
  const payload = (target) => ({
    bpm: P.bpm, target, master: P.master || {},
    lines: P.lines.map((L) => ({ id: L.id, sample: specOf(L.sampleId), fit: L.fit || 'stretch', ...mixOf(L), nodes: L.nodes.map((n) => ({ s: n.s, l: n.l, notes: noteSpecs(n), fit: n.fit || null, fill: n.sampleId === 'ref' && !!n.refFill, sample: n.sampleId ? (n.sampleId === 'ref' ? refSpec(n) : specOf(n.sampleId)) : null })) }))
  });
  // while a mix is playing, changing a mixer value re-renders it and carries on from the same spot (the old sound plays until the new one is ready)
  const mixSig = JSON.stringify([P.lines.map(mixOf), P.master]);
  const prevMixSig = useRef(mixSig);
  useEffect(() => {
    if (prevMixSig.current === mixSig) return;
    prevMixSig.current = mixSig;
    const tg = U.playing;
    if ((tg !== 'all' && !P.lines.some((L) => L.id === tg)) || Ctl.el.paused) return;
    const timer = setTimeout(async () => {
      try {
        const beat = Ctl.startBeat + (Ctl.el.currentTime * Ctl.bpm) / 60;
        const url = await renderUrl(payload(tg));
        if (Ctl.el.paused) return;                       // stopped meanwhile
        const keepBeat = Ctl.startBeat + (Ctl.el.currentTime * Ctl.bpm) / 60;
        Ctl.startBeat = 0;
        Ctl.el.src = url;
        await new Promise((res) => { const t = setTimeout(res, 1500); Ctl.el.onloadedmetadata = () => { clearTimeout(t); res(); }; });
        Ctl.el.currentTime = (Math.max(beat, keepBeat) * 60) / P.bpm;
        await Ctl.el.play();
        ui({ playing: tg });
      } catch (e) { ui({ notice: e.message }); }
    }, 350);
    return () => clearTimeout(timer);
  }, [mixSig]);
  const play = async (target, fromBeat) => {
    if (U.playing === target) { Ctl.el.pause(); Ctl.el.currentTime = 0; ui({ playing: null }); return; }
    Ctl.el.pause();
    Prev.pause();
    if (U.rangePlaying) stopRange();
    const has = P.lines.some((L) => (target === 'all' || L.id === target) && L.nodes.length);
    if (!has) { ui({ playing: null, notice: '재생할 노드가 없어요' }); return; }
    if (!P.samples.length) { ui({ notice: '먼저 샘플을 추가해 주세요' }); return; }
    ui({ rendering: target, notice: '소리 만드는 중…' });
    try {
      const url = await renderUrl(payload(target));
      Ctl.bpm = P.bpm;
      Ctl.startBeat = 0;
      Ctl.el.src = url;
      Ctl.el.currentTime = 0;
      if (fromBeat) {   // start at the guide line instead of the beginning
        await new Promise((res) => { const t = setTimeout(res, 1500); Ctl.el.onloadedmetadata = () => { clearTimeout(t); res(); }; });
        Ctl.el.currentTime = (fromBeat * 60) / P.bpm;
      }
      await Ctl.el.play();
      ui({ playing: target, rendering: null, notice: '' });
    } catch (e) { ui({ rendering: null, notice: e.message }); }
  };
  const exportWav = async () => {
    ui({ rendering: 'export', notice: 'WAV 만드는 중…' });
    try {
      const url = await renderUrl(payload('all'));
      const a = document.createElement('a');
      a.href = url; a.download = tx('내 곡.wav'); a.click();
      ui({ rendering: null, notice: 'WAV로 내보냈어요 (내 곡.wav)' });
    } catch (e) { ui({ rendering: null, notice: e.message }); }
  };

  // zip for other programs: the notes go to the server as plain data (beats from the start of the song), the WAV files are rendered there
  const exportPack = async (o) => {
    if (!P.lines.some((L) => L.nodes.length)) { ui({ notice: '내보낼 노드가 없어요' }); return; }
    ui({ rendering: 'export', notice: '내보낼 파일 만드는 중…' });
    try {
      const soundName = (L, n, k) => {
        const id = k.sampleId || n.sampleId || L.sampleId;
        if (id === 'ref') return '참조곡 원음' + (n.src ? ' (' + ((defs.find((d) => d.key === n.src.key) || {}).name || n.src.key) + ')' : '');
        const sm = sampleOf(id);
        return sm ? (sm.label || sm.file) : '';
      };
      const meta = {
        bpm: P.bpm,
        lines: P.lines.map((L) => ({ id: L.id, name: L.name, notes: L.nodes.flatMap((n) => n.notes.map((k) => ({
          t: r6(n.s + k.s), l: k.l, p: k.p, sound: soundName(L, n, k),
          ...(k.g != null ? { g: k.g } : {}), ...(k.ts != null ? { ts: k.ts } : {}), ...(k.te != null ? { te: k.te } : {}),
        }))).sort((a, b) => a.t - b.t) })),
      };
      const r = await api('/api/export-pack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ render: payload('all'), meta, ...o }) });
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'vomix-export.zip'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      ui({ rendering: null, exportOpen: false, notice: '내보냈어요 (vomix-export.zip). 안의 README.txt에 파일 설명이 있어요' });
    } catch (e) { ui({ rendering: null, notice: e.message }); }
  };

  // ---- finer editing: add a note inside a node, delete a note, split a node at a note, nudge by one grid step
  const addNote = (L, n, e, rows) => {
    const r = e.currentTarget.closest('.lane').getBoundingClientRect();
    const rel = clamp(r6(Math.floor((e.clientX - r.left) / PX / grid) * grid - n.s), 0, Math.max(0, r6(n.l - grid)));
    const p = rows[clamp(Math.floor((e.clientY - r.top - TAB) / rh), 0, rows.length - 1)];
    const idx = [...n.notes, { s: rel, l: grid, p }].sort((a, b) => a.s - b.s).findIndex((k) => k.s === rel && k.p === p);
    upd((pp) => {
      const nd = pp.lines.find((x) => x.id === L.id).nodes.find((x) => x.id === n.id);
      nd.notes.push({ s: rel, l: grid, p });
      nd.notes.sort((a, b) => a.s - b.s);
    });
    ui({ selLine: L.id, selNode: n.id, selNote: idx, notice: '' });
  };
  const pickNote = (e, L, n, i) => {
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!multi) { ui({ selLine: L.id, selNode: n.id, selNote: i, selMore: null }); return; }
    const cur = U.selNode === n.id && U.selNote != null
      ? [U.selNote, ...(U.selMore && U.selMore.node === n.id && U.selMore.primary === U.selNote ? U.selMore.list : [])] : [];
    const set = new Set(cur);
    if (set.has(i)) set.delete(i); else set.add(i);
    const list = [...set];
    if (!list.length) { ui({ selLine: L.id, selNode: n.id, selNote: null, selMore: null }); return; }
    const primary = set.has(i) ? i : list[list.length - 1];
    ui({ selLine: L.id, selNode: n.id, selNote: primary, selMore: { node: n.id, primary, list } });
  };
  // change every selected note of the node (each one is its own "node" of the bundle)
  const editNotes = (fn) => editNode((nd) => { selIdx.forEach((i) => { if (nd.notes[i]) fn(nd.notes[i], nd); }); nd.edited = true; });
  const notePitch = (d) => editNotes((k) => { k.p = clamp(k.p + d, 24, 96); });
  const noteMove = (d) => editNotes((k, nd) => { k.s = clamp(r6(k.s + d), 0, Math.max(0, r6(nd.l - k.l))); });
  const noteLen = (d) => editNotes((k, nd) => { k.l = clamp(r6(k.l + d), 0.0625, Math.max(0.0625, r6(nd.l - k.s))); });
  const noteSetStart = (beat) => { if (Number.isFinite(beat)) editNotes((k, nd) => { k.s = clamp(r6(beat - 1 - nd.s), 0, Math.max(0, r6(nd.l - k.l))); }); };
  const noteSetLen = (v) => { if (Number.isFinite(v)) editNotes((k, nd) => { k.l = clamp(r6(v), 0.0625, Math.max(0.0625, r6(nd.l - k.s))); }); };
  const noteToNext = () => editNotes((k, nd) => {
    const nxt = nd.notes.filter((q) => q.s > k.s + EPS && q !== k).map((q) => q.s);
    const end = nxt.length ? Math.min(...nxt) : nd.l;
    k.l = Math.max(0.0625, r6(end - k.s));
  });
  const deleteNote = () => {
    if (!selIdx.length) return;
    if (selIdx.length >= node.notes.length) { ui({ notice: '뭉치 안의 노드를 전부 지울 수는 없어요. 뭉치를 지우려면 "라인에서 빼기"를 누르세요' }); return; }
    editNode((nd) => { nd.notes = nd.notes.filter((_, i) => !selIdx.includes(i)); nd.edited = true; });
    ui({ selNote: null, selMore: null });
  };
  // the sound this note plays: its own sample, else the bundle's, else the line's (a reference sound has no cut to narrow)
  const noteSample = (k) => { const id = (k && k.sampleId) || (node && node.sampleId) || (line && line.sampleId); return id && id !== 'ref' ? sampleOf(id) : null; };
  // What was chosen on the sound that comes out of the node (a .. b beats from the start of the note, "full" = where that sound stops) is
  // turned into a part of the sample itself: the note gets its own "cs".."ce" (seconds inside the cut of the sample), starts where the kept part
  // started and is as long as the kept part. So it is an ordinary note again and can be made longer or shorter afterwards.
  const cutSource = (k) => {
    const sm = noteSample(k);
    const whole = sm && sm.sel ? sm.sel.end - sm.sel.start : 0;
    const c0 = k.cs != null ? k.cs : 0, c1 = k.ce != null ? k.ce : whole;
    return { c0, c1 };
  };
  const applyNoteCut = ({ a, b, full }) => {
    const isFull = a <= 0.002 && b >= full - 0.01;
    editNote((k, nd) => {
      delete k.ts; delete k.te;                       // (older builds kept the cut as a window on the output)
      if (!isFull) {
        const { c0, c1 } = cutSource(k);
        const f = (x) => c0 + (x / full) * (c1 - c0);
        k.cs = r6(f(a)); k.ce = r6(f(b));
        k.s = clamp(r6(k.s + a), 0, Math.max(0, r6(nd.l - 0.0625)));
        k.l = clamp(r6(b - a), 0.0625, Math.max(0.0625, r6(nd.l - k.s)));
      }
      nd.edited = true;
    });
    ui({ noteCut: false, notice: isFull ? '소리는 그대로예요' : '노드의 소리를 ' + a.toFixed(2) + ' ~ ' + b.toFixed(2) + '박 부분만 남겼어요. 길이는 다시 늘리거나 줄일 수 있어요' });
  };
  const splitNoteCut = ({ a, b, m, full }) => {
    editNote((k, nd) => {
      delete k.ts; delete k.te;
      const { c0, c1 } = cutSource(k);
      const f = (x) => c0 + (x / full) * (c1 - c0);
      const s0 = k.s;
      const second = { ...k, s: clamp(r6(s0 + m), 0, Math.max(0, r6(nd.l - 0.0625))), cs: r6(f(m)), ce: r6(f(b)) };
      second.l = clamp(r6(b - m), 0.0625, Math.max(0.0625, r6(nd.l - second.s)));
      k.s = clamp(r6(s0 + a), 0, Math.max(0, r6(nd.l - 0.0625)));
      k.cs = r6(f(a)); k.ce = r6(f(m));
      k.l = clamp(r6(m - a), 0.0625, Math.max(0.0625, r6(nd.l - k.s)));
      nd.notes.push(second);
      nd.notes.sort((x, y) => x.s - y.s);
      nd.edited = true;
    });
    ui({ noteCut: false, selMore: null, notice: '노드를 표시한 곳에서 둘로 나눴어요. 각각 길이를 늘리거나 줄일 수 있어요' });
  };
  // the sound that comes out of the selected note alone (nothing cut away), as WAV bytes for the cutting window
  const noteAudio = async () => {
    const k0 = node.notes[U.selNote];
    const sp = (id) => specOf(id);
    const base = sp(node.sampleId || line.sampleId);
    const k = { ...k0, s: 0 };
    delete k.ts; delete k.te;
    if (k0.sampleId) k.sample = sp(k0.sampleId);
    const url = await renderUrl({ bpm: P.bpm, target: 'all', lines: [{ id: 'n', sample: base, fit: line.fit || 'stretch', ...mixOf(line), vol: 1, pan: 0, eq: {}, rev: 0, comp: 0, auto: false, mute: false, solo: false, nodes: [{ s: 0, l: k0.l, notes: [k], sample: null, fit: node.fit || null, tight: true }] }] });
    return await (await fetch(url)).arrayBuffer();
  };
  const duplicateNote = () => {
    if (selIdx.length !== 1) return;
    const k = node.notes[selIdx[0]];
    const s = r6(k.s + k.l);
    if (s + k.l > node.l + EPS) { ui({ notice: '뭉치 끝을 넘어서 한 칸 뒤에 복제할 수 없어요. 뭉치 길이를 먼저 늘리세요' }); return; }
    editNode((nd) => { nd.notes.push({ s, l: k.l, p: k.p }); nd.edited = true; });
    ui({ selNote: node.notes.length, selMore: null, notice: '노드를 한 칸 뒤에 복제했어요' });
  };
  // nodes -> node library (the picked ones as one bundle, or every node on its own)
  const libEntryOf = (list, name) => {
    const ns = list.map((i) => node.notes[i]).filter(Boolean).sort((x, y) => x.s - y.s);
    const a0 = ns[0].s;
    const end = Math.max(...ns.map((k) => k.s + k.l));
    const l = Math.max(grid, r6(Math.ceil((end - a0) / grid - EPS) * grid));
    const base = node.refAt != null ? node.refAt : node.src ? node.src.a : null;
    return { id: uid('d'), name, l, notes: ns.map((k) => ({ s: r6(k.s - a0), l: k.l, p: k.p, ...(k.cs != null ? { cs: k.cs, ce: k.ce } : {}), ...(k.ts != null ? { ts: k.ts } : {}), ...(k.te != null ? { te: k.te } : {}) })), at: base != null ? r6(base + a0) : null, fit: node.fit || null, sampleId: node.sampleId || null };
  };
  const saveNotesToLib = () => {
    if (!selIdx.length) return;
    const ns = selIdx.map((i) => node.notes[i]);
    const name = (selIdx.length === 1 ? noteName(ns[0].p) + ' ' + node.name : node.name + ' · 노드 ' + selIdx.length + '개');
    upd((p) => { p.lib.push(libEntryOf(selIdx, name)); });
    ui({ notice: "'" + name + "' 을(를) 노드 모음에 저장했어요" });
  };
  const saveEachNoteToLib = () => {
    if (!node) return;
    const n = node.notes.length;
    if (n > 24 && !window.confirm('노드 ' + n + '개를 하나씩 따로 노드 모음에 저장할까요? 노드 모음에 항목이 ' + n + '개 생겨요.')) return;
    const entries = node.notes.map((k, i) => libEntryOf([i], noteName(k.p) + ' ' + node.name + ' ' + (i + 1)));
    upd((p) => { entries.forEach((e) => p.lib.push(e)); });
    ui({ notice: '노드 ' + n + '개를 하나씩 노드 모음에 저장했어요' });
  };
  const splitNode = () => {
    if (!line || !node || U.selNote == null) return;
    const cut = r6(node.notes[U.selNote].s);
    if (cut < grid - EPS || node.l - cut < grid - EPS || !node.notes.some((k) => k.s < cut - EPS)) {
      ui({ notice: '이 음 앞에 다른 음이 없어서 쪼갤 수 없어요. 앞에 음이 있는 음을 고르세요' });
      return;
    }
    const id = uid('n');
    upd((p) => {
      const L = p.lines.find((x) => x.id === line.id);
      const nd = L.nodes.find((x) => x.id === node.id);
      const left = nd.notes.filter((k) => k.s < cut - EPS).map((k) => ({ ...k, l: Math.min(k.l, r6(cut - k.s)) }));
      const right = nd.notes.filter((k) => k.s >= cut - EPS).map((k) => ({ ...k, s: r6(k.s - cut) }));
      const rn = { id, name: nd.name + ' ②', s: r6(nd.s + cut), l: r6(nd.l - cut), notes: right, sampleId: nd.sampleId || null };
      if (nd.src) { const a0 = nd.src.a; rn.src = { ...nd.src, a: r6(a0 + cut) }; nd.src = { ...nd.src, b: r6(a0 + cut) }; }
      nd.notes = left;
      nd.l = cut;
      L.nodes.push(rn);
    });
    ui({ selNote: null, notice: '노드를 둘로 쪼갰어요. 뒤쪽 노드 이름 끝에 ② 가 붙어요' });
  };
  const nudge = (dir) => {
    const s = r6(node.s + dir * grid);
    if (s >= -EPS && s + node.l <= T + EPS && !line.nodes.some((q) => q.id !== node.id && s < q.s + q.l - EPS && q.s < s + node.l - EPS)) editNode((nd) => { nd.s = s; });
  };

  // ---- drag a note: up/down changes its pitch, sideways moves it inside the node (rows are frozen while dragging)
  const startNoteDrag = (e, L, n, i, rows) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const k0 = { ...n.notes[i] };
    const sx = e.clientX, sy = e.clientY;
    const idx0 = Math.max(0, rows.indexOf(k0.p));
    let moved = false;
    ui({ selLine: L.id, selNode: n.id, selNote: i, selMore: null, rollFrozen: { lineId: L.id, rows } });
    const done = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', done);
      window.removeEventListener('blur', done);
      ui({ rollFrozen: null });
    };
    const move = (ev) => {
      if (ev.buttons === 0) { done(); return; }
      if (!moved && Math.abs(ev.clientX - sx) < 4 && Math.abs(ev.clientY - sy) < 4) return;
      moved = true;
      const p = rows[clamp(idx0 + Math.round((ev.clientY - sy) / rh), 0, rows.length - 1)];   // rows run from high to low
      const s = clamp(r6(k0.s + Math.round((ev.clientX - sx) / PX / grid) * grid), 0, Math.max(0, r6(n.l - k0.l)));
      upd((pp) => {
        const nd = pp.lines.find((x) => x.id === L.id).nodes.find((x) => x.id === n.id);
        nd.notes[i].p = p;
        nd.notes[i].s = s;
        nd.edited = true;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', done);
    window.addEventListener('blur', done);
  };
  // ---- move every note of the selected node up or down (octave = 12)
  const transposeNode = (d) => editNode((nd) => {
    nd.notes = nd.notes.map((k) => ({ ...k, p: clamp(k.p + d, 24, 96) }));
    nd.shift = (nd.shift || 0) + d;
  });
  const resetNodePitch = () => editNode((nd) => {
    const d = -(nd.shift || 0);
    nd.notes = nd.notes.map((k) => ({ ...k, p: clamp(k.p + d, 24, 96) }));
    nd.shift = 0;
  });
  const setRefSize = (key, size) => upd((p) => { p.ref.sizes = { ...(p.ref.sizes || {}), [key]: size }; });

  const mv = P.master && P.master.vol != null ? P.master.vol : 1;
  const setMaster = (patch) => upd((p) => { p.master = { vol: 1, fade_in: 0, fade_out: 0, ...(p.master || {}), ...patch }; });
  const resetMix = () => {
    if (!window.confirm('모든 라인의 믹서 값(음량, 좌우 위치, EQ, 리버브, 컴프레서)과 마스터를 처음대로 되돌릴까요?\n뮤트와 솔로도 풀려요.')) return;
    upd((p) => { p.lines.forEach((x) => { delete x.vol; delete x.pan; delete x.rev; delete x.comp; delete x.eq; delete x.mute; delete x.solo; delete x.auto; }); p.master = { vol: 1, fade_in: 0, fade_out: 0 }; });
  };
  const deleteLine = (id) => {
    const L = P.lines.find((x) => x.id === id);
    if (!L) return;
    if (P.lines.length < 2) { ui({ notice: '라인은 최소 1개가 있어야 해서 지울 수 없어요' }); return; }
    const warn = L.nodes.length ? ["", "노드 " + L.nodes.length + "개도 함께 지워지고 되돌릴 수 없어요.", "(노드 모음에 저장한 노드는 그대로 남아요)"].join(String.fromCharCode(10)) : "";
    if (!window.confirm("'" + L.name + "' 라인을 지울까요?" + warn)) return;
    const rest = P.lines.filter((x) => x.id !== id);
    upd((p) => { p.lines = p.lines.filter((x) => x.id !== id); });
    ui({ selLine: rest[0].id, selNode: null, selNote: null, hoverNode: null });
  };
  const setMix = (id, patch) => upd((p) => { Object.assign(p.lines.find((x) => x.id === id), patch); });
  const setView = (id, lo, hi) => upd((p) => { p.lines.find((x) => x.id === id).view = { lo, hi }; });

  // ---- exact start / length of the selected node (typed in, nudged in tiny steps, or matched to where it is in the song)
  const overlaps = (ln, s, l, ignoreId) => ln.nodes.some((q) => q.id !== ignoreId && s < q.s + q.l - EPS && q.s < s + l - EPS);
  const setNodeStart = (v) => {
    if (!line || !node || !Number.isFinite(v)) return;
    const s = clamp(r6(v), 0, Math.max(0, T - node.l));
    if (overlaps(line, s, node.l, node.id)) { ui({ notice: fmt(s + 1) + '박째에는 이 라인의 다른 노드와 겹쳐요. 다른 위치를 넣거나 다른 라인으로 옮기세요' }); return; }
    editNode((nd) => { nd.s = s; });
  };
  const setNodeLength = (v) => {
    if (!line || !node || !Number.isFinite(v)) return;
    const l = Math.max(0.0625, r6(v));
    if (node.s + l > T + EPS || overlaps(line, node.s, l, node.id)) { ui({ notice: '그 길이로는 뒤쪽 노드와 겹치거나 곡 끝을 넘어요' }); return; }
    if (l < node.l && keepsNotes(node, l) === 0) { ui({ notice: '그 길이로는 뭉치 안에 노드가 하나도 남지 않아요. 뭉치를 지우려면 "라인에서 빼기"를 누르세요' }); return; }
    const rt = rootOf(node.sampleId || line.sampleId);
    editNode((nd) => {
      if (nd.src && !nd.edited) { nd.src.b = r6(nd.src.a + l); nd.notes = applyPieces(nd, shifted(refNotes(nd.src.key, nd.src.a, nd.src.b, rt), nd.shift)); }
      else nd.notes = nd.notes.filter((k) => k.s < l - EPS).map((k) => ({ ...k, l: Math.min(k.l, r6(l - k.s)) }));
      nd.l = l;
    });
  };
  const nudgeFine = (d) => setNodeStart(node.s + d);
  const refPos = node ? (node.refAt != null ? node.refAt : node.src ? node.src.a : null) : null;   // where this node came from in the song
  // the whole selected node bundle -> node library (also the button at the bottom of the library window)
  const saveBundleToLib = () => {
    if (!node) return;
    upd((p) => { p.lib.push({ id: uid('d'), name: node.name, l: node.l, notes: clone(node.notes), at: refPos, fit: node.fit || null, sampleId: node.sampleId || null }); });
    ui({ notice: "'" + node.name + "' 노드 뭉치를 노드 모음에 저장했어요" });
  };

  // ---- the vertical guide line: click or drag along the beat ruler (Alt = no grid snapping)
  const guideAt = (e, el) => {
    const x = (e.clientX - el.getBoundingClientRect().left) / PX;
    return clamp(e.altKey ? r6(x) : r6(Math.round(x / grid) * grid), 0, T);
  };
  const startGuideDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();                       // no text selection / native drag while the line is moved
    const el = e.currentTarget;
    document.body.classList.add('guidedrag');
    ui({ guide: guideAt(e, el) });
    const move = (ev) => { if (ev.buttons === 0) { done(); return; } ev.preventDefault(); ui({ guide: guideAt(ev, el) }); };
    const done = () => {
      document.body.classList.remove('guidedrag');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', done);
      window.removeEventListener('blur', done);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', done);
    window.addEventListener('blur', done);
  };
  // put one note exactly at a beat on a line: inside the node that already covers that spot, otherwise as a new node
  const addNoteAt = (ln, start, len, pitch, name, refAt) => {
    const s = clamp(r6(start), 0, Math.max(0, T - len));
    const host = ln.nodes.find((q) => q.s <= s + EPS && s + len <= q.s + q.l + EPS);
    if (host) {
      upd((p) => {
        const nd = p.lines.find((x) => x.id === ln.id).nodes.find((x) => x.id === host.id);
        nd.notes.push({ s: r6(s - nd.s), l: len, p: pitch });
        nd.notes.sort((a, b) => a.s - b.s);
      });
      ui({ selLine: ln.id, selNode: host.id, selNote: null, notice: "'" + host.name + "' 노드의 " + fmt(s + 1) + '박째에 ' + noteName(pitch) + ' 음을 넣었어요' });
      return;
    }
    if (overlaps(ln, s, len, null)) { ui({ notice: "'" + ln.name + "' 라인의 " + fmt(s + 1) + '박째에는 이미 다른 노드가 걸쳐 있어요. 다른 라인을 고르거나 그 노드를 옮기세요' }); return; }
    const id = uid('n');
    upd((p) => { p.lines.find((x) => x.id === ln.id).nodes.push({ id, name, s, l: len, notes: [{ s: 0, l: len, p: pitch }], refAt: refAt != null ? refAt : null, sampleId: null }); });
    ui({ selLine: ln.id, selNode: id, selNote: null, notice: "'" + name + "' 을(를) '" + ln.name + "' 라인 " + fmt(s + 1) + '박째에 놓았어요' });
  };
  // a reference note, same pitch, same length, same place (or at `at`) on the selected line
  const putRefNote = (key, i, at) => {
    const ln = line || P.lines[0];
    const n = lanes && lanes[key] && lanes[key][i];
    if (!ln || !n) return;
    const isDrum = (defs.find((d) => d.key === key) || {}).kind === 'drum';
    const root = rootOf(ln.sampleId);
    const l = Math.max(0.0625, r6(n.l != null ? n.l : 0.25));
    const pitch = isDrum ? root : refNotes(key, 0, 0, root, i)[0].p;
    addNoteAt(ln, at != null ? at : n.t, l, pitch, onlyName({ key, only: i }), n.t);
  };
  const insertNoteAtGuide = (pitch) => {
    const ln = line || P.lines[0];
    if (!ln || guide == null) return;
    addNoteAt(ln, guide, Math.max(grid, 0.25), pitch, noteName(pitch) + ' 직접', null);
  };
  // place a library entry at an exact beat (its reference position, or the guide line) on the selected line
  const placeLibAt = (d, s0) => {
    const ln = line || P.lines[0];
    if (!ln) return;
    const s = clamp(r6(s0), 0, Math.max(0, T - d.l));
    if (overlaps(ln, s, d.l, null)) { ui({ notice: "'" + ln.name + "' 라인의 " + fmt(s + 1) + '박째에는 이미 다른 노드가 있어요. 다른 라인을 고르거나 그 노드를 옮기세요' }); return; }
    const id = uid('n');
    upd((p) => { p.lines.find((x) => x.id === ln.id).nodes.push({ id, name: d.name, s, l: d.l, notes: clone(d.notes), refAt: d.at != null ? d.at : null, ...(d.fit ? { fit: d.fit } : {}), sampleId: sampleOf(d.sampleId) ? d.sampleId : null }); });
    ui({ selLine: ln.id, selNode: id, selNote: null, notice: "'" + d.name + "' 을(를) '" + ln.name + "' 라인 " + fmt(s + 1) + '박째에 놓았어요' });
  };

  // ---- node library: drag an entry onto a line (the free spot nearest to the pointer is previewed)
  const libSpot = (L, e, l) => {
    const r = e.currentTarget.getBoundingClientRect();
    let want = clamp(r6(Math.floor((e.clientX - r.left) / PX / grid) * grid), 0, Math.max(0, T - l));
    if (guide != null) {
      const thr = 8 / PX;
      if (Math.abs(want - guide) < thr) want = clamp(guide, 0, Math.max(0, T - l));
      else if (Math.abs(want + l - guide) < thr) want = clamp(r6(guide - l), 0, Math.max(0, T - l));
    }
    const ln = P.lines.find((x) => x.id === L.id);
    return { s: ln ? findFree(ln, want, l, null) : -1, want };
  };
  const libOver = (L, e) => {
    if (!dragLib) return;
    e.preventDefault();
    const { s, want } = libSpot(L, e, dragLib.l);
    const sp = s < 0 ? want : s;
    const cur = U.dropPrev;
    if (!cur || cur.line !== L.id || cur.s !== sp || cur.ok !== (s >= 0)) ui({ dropPrev: { line: L.id, s: sp, l: dragLib.l, ok: s >= 0 } });
  };
  const libLeave = (L, e) => {
    if (e && e.currentTarget && e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;   // still inside the lane
    if (U.dropPrev && U.dropPrev.line === L.id) ui({ dropPrev: null });
  };
  const libDrop = (L, e) => {
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw || !raw.startsWith('lib:')) return;
    e.preventDefault();
    const d = P.lib.find((x) => x.id === raw.slice(4));
    dragLib = null;
    if (!d) { ui({ dropPrev: null }); return; }
    const { s } = libSpot(L, e, d.l);
    if (s < 0) { ui({ dropPrev: null, notice: "'" + L.name + "' 라인에 놓을 자리가 없어요" }); return; }
    const id = uid('n');
    upd((p) => { p.lines.find((x) => x.id === L.id).nodes.push({ id, name: d.name, s, l: d.l, notes: clone(d.notes), refAt: d.at != null ? d.at : null, ...(d.fit ? { fit: d.fit } : {}), sampleId: sampleOf(d.sampleId) ? d.sampleId : null }); });
    ui({ dropPrev: null, selLine: L.id, selNode: id, selNote: null, notice: "'" + d.name + "' 을(를) '" + L.name + "' 라인 " + fmt(s + 1) + '박째에 놓았어요' });
  };

  const libDropHeader = (L, e) => {
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw || !raw.startsWith('lib:')) return;
    e.preventDefault();
    const d = P.lib.find((x) => x.id === raw.slice(4));
    dragLib = null;
    ui({ dropPrev: null });
    if (d) addFromLib(d, L);
  };
  // while a library entry is dragged: scroll the timeline when the pointer is near its edge, so a line that is out of sight can be reached
  const dragScroll = (e) => {
    if (!dragLib) return;
    const el = e.currentTarget, r = el.getBoundingClientRect(), m = 70;
    const speed = (d) => Math.round(8 + ((m - d) / m) * 26);
    if (e.clientY < r.top + m) el.scrollTop -= speed(Math.max(0, e.clientY - r.top));
    else if (e.clientY > r.bottom - m) el.scrollTop += speed(Math.max(0, r.bottom - e.clientY));
    if (e.clientX < r.left + HEADW + 40) el.scrollLeft -= 20;
    else if (e.clientX > r.right - 50) el.scrollLeft += 20;
  };

  // ---- a single note of a reference lane: click it to see its details, save it (or its whole same-pitch run) as a node
  const selectRefNote = (key, i) => {
    const n = lanes && lanes[key] && lanes[key][i];
    if (!n) return;
    // exactly this note's own span (not widened to the grid), and `only` makes every import / save use this one note
    const len = n.l != null ? n.l : 0.25;
    const a = Math.max(0, Math.floor(n.t * 192) / 192);
    const b = Math.max(a + 1 / 192, Math.ceil((n.t + len) * 192) / 192);
    ui({ refNote: { key, i }, refSel: { key, a, b, only: i }, notice: '' });
  };
  const saveRefNotes = (key, idxList) => {
    const list = idxList.map((i) => lanes[key][i]).sort((x, y) => x.t - y.t);
    if (!list.length) return;
    const ln = line || P.lines[0];
    const root = rootOf(ln ? ln.sampleId : null);
    const def = defs.find((d) => d.key === key) || {};
    const isDrum = def.kind === 'drum';
    const a0 = list[0].t;
    const end = Math.max(...list.map((n) => n.t + (n.l != null ? n.l : 0.25)));
    const notes = list.map((n) => ({ s: r6(n.t - a0), l: Math.max(0.0625, r6(n.l != null ? n.l : 0.25)), p: isDrum ? root : n.p }));
    const l = Math.max(grid, r6(Math.ceil((end - a0) / grid - EPS) * grid));
    const name = (def.name || key) + ' ' + (isDrum ? list[0].k || '타격' : noteName(list[0].p)) + (list.length > 1 ? ' ×' + list.length : '');
    upd((p) => { p.lib.push({ id: uid('d'), name, l, notes, at: a0 }); });
    ui({ notice: "'" + name + "' 을(를) 노드 모음에 저장했어요" });
  };
  const refNoteData = U.refNote && lanes && lanes[U.refNote.key] ? lanes[U.refNote.key][U.refNote.i] || null : null;
  // other notes of the same lane that sound at the same time as the selected one (they are all in the same recording)
  const refNoteWith = refNoteData && lanes && lanes[U.refNote.key]
    ? lanes[U.refNote.key].map((n, j) => ({ n, j })).filter(({ n, j }) => j !== U.refNote.i && n.t < refNoteData.t + (refNoteData.l || 0.25) - EPS && refNoteData.t < n.t + (n.l || 0.25) - EPS)
    : [];
  const refNoteDef = refNoteData ? defs.find((d) => d.key === U.refNote.key) || null : null;
  useEffect(() => {
    if (!U.refNote || !P.ref || !refNoteData) { if (U.hits) ui({ hits: null }); return; }
    let dead = false;
    const f = 60 / P.ref.bpm, k = U.refNote;
    const t0 = P.ref.offset + refNoteData.t * f, t1 = P.ref.offset + (refNoteData.t + (refNoteData.l || 0.25)) * f;
    rangeBuffer('/api/reference/' + P.ref.id + '/stem/' + k.key).then((buf) => {
      if (dead) return;
      ui({ hits: { key: k.key, i: k.i, beats: findOnsets(buf, t0, t1).map((t) => r6((t - P.ref.offset) / f)) } });
    }).catch(() => {});
    return () => { dead = true; };
  }, [U.refNote && U.refNote.key, U.refNote && U.refNote.i, P.ref && P.ref.id]);
  const refHits = U.hits && U.refNote && U.hits.key === U.refNote.key && U.hits.i === U.refNote.i ? U.hits.beats : [];
  const refNoteRun = refNoteData && refNoteDef && refNoteDef.kind === 'pitch'
    ? (() => { const r = runsOf(lanes[U.refNote.key]); return { list: r.runs[r.info[U.refNote.i].run], pos: r.info[U.refNote.i].pos }; })()
    : null;

  // ---- Ctrl + wheel = width, Alt + wheel = height of the timeline
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.altKey) return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      if (e.ctrlKey) {
        const r = sc.getBoundingClientRect();
        const beat = (e.clientX - r.left + sc.scrollLeft - HEADW) / PX;      // keep the beat under the pointer in place
        const nz = clamp(Math.round(PX * f), 24, 320);
        upd((p) => { p.zoom = nz; });
        setTimeout(() => { sc.scrollLeft = Math.max(0, beat * nz + HEADW - (e.clientX - r.left)); }, 40);
      } else {
        upd((p) => { p.rowH = clamp(Math.round((p.rowH || 32) * f), 18, 64); });
      }
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, []);

  const ctx = { P, U, ui, upd, T, grid, rh, addNote, startNoteDrag, setRefSize, setView, libOver, libLeave, libDrop, selectRefNote, lanes, drag, suppress, startNodeDrag, sampleOf, rootOf, createFromSel, copyLaneToLine, deleteLine, pickNote, libDropHeader, play, listenStem, renameLane };
  const selRef = U.refSel && lanes && defs.some((d) => d.key === U.refSel.key && isOn(d)) ? U.refSel : null;
  const visRef = defs.filter((d) => isOn(d));
  const playingAll = U.playing === 'all';
  const refDef = (k) => defs.find((d) => d.key === k) || { name: k };
  // what sounds at the guide line: reference notes and my own lines' nodes / notes
  const guideInfo = guide == null ? null : {
    refs: lanes ? visRef.flatMap((d) => ((lanes[d.key] || []).map((n, i) => ({ n, i, key: d.key, def: d }))
      .filter((x) => (d.kind === 'drum' ? Math.abs(x.n.t - guide) < 0.1 : x.n.t <= guide + EPS && guide < x.n.t + (x.n.l || 0) - EPS)))) : [],
    mine: P.lines.flatMap((ln) => ln.nodes.filter((q) => q.s <= guide + EPS && guide < q.s + q.l - EPS).map((q) => ({
      ln, q, notes: q.notes.filter((k) => q.s + k.s <= guide + EPS && guide < q.s + k.s + k.l - EPS),
    }))),
  };

  return html`<div class="app">
    <div class="top">
      <div class="brand" style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}><img src="assets/mark_56.png" alt="" width="28" height="28" style=${{ display: 'block' }} />Vomix Studio <span style=${{ fontWeight: 400, color: '#9aa4b5', fontSize: '12px' }}>${`빌드 ${BUILD}`}</span></div>
      <div style=${{ flex: 1 }}></div>
      <button class="btn sm iconbtn" aria-label="되돌리기 (Ctrl+Z)" title="마지막 변경을 되돌려요 (Ctrl+Z)" disabled=${!hist.current.undo.length} onClick=${undo}>↶</button>
      <button class="btn sm iconbtn" aria-label="다시 하기 (Ctrl+Y)" title="되돌린 변경을 다시 적용해요 (Ctrl+Y)" disabled=${!hist.current.redo.length} onClick=${redo}>↷</button>
      <label style=${{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#9aa4b5' }}>BPM
        <input class="chip-in" type="number" min="40" max="240" step="0.1" value=${P.bpm} onInput=${(e) => upd((p) => { p.bpm = clamp(Number(e.target.value) || 120, 40, 240); })} /></label>
      ${P.ref && Math.abs(P.bpm - P.ref.bpm) > 0.05 && P.ref.bpm >= 40 && P.ref.bpm <= 240 && html`<button class="tbtn" title="내 곡의 박자를 참조곡 박자로 바꿔요. 같게 맞추면 참조곡의 원래 소리를 늘이거나 줄이지 않고 그대로 들려줘요" onClick=${() => { upd((p) => { p.bpm = Math.round(p.ref.bpm * 10) / 10; }); ui({ notice: '박자를 참조곡에 맞춰 ' + (Math.round(P.ref.bpm * 10) / 10) + '으로 바꿨어요' }); }}>${`참조곡 박자에 맞추기 (${Math.round(P.ref.bpm * 10) / 10})`}</button>`}
      <label style=${{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#9aa4b5' }}>격자
        <select class="chip-in" style=${{ width: '128px' }} aria-label="격자 (구간 선택, 이동, 길이 조절의 최소 단위)" value=${String(GRID_OPTIONS.reduce((a, o) => (Math.abs(o[0] - grid) < Math.abs(a - grid) ? o[0] : a), GRID_OPTIONS[0][0]))} onChange=${(e) => upd((p) => { p.grid = Number(e.target.value); })}>
          ${GRID_OPTIONS.map((o) => html`<option value=${String(o[0])} key=${o[1]}>${o[1]}</option>`)}
        </select></label>
      <label style=${{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#9aa4b5' }} title="Ctrl + 마우스 휠로도 조절돼요">가로
        <input type="range" min="24" max="320" step="4" value=${PX} aria-label="타임라인 가로 크기 (Ctrl + 휠)" onInput=${(e) => upd((p) => { p.zoom = Number(e.target.value); })} /></label>
      <label style=${{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#9aa4b5' }} title="Alt + 마우스 휠로도 조절돼요">세로
        <input type="range" min="18" max="64" step="2" value=${rh} aria-label="모든 레인과 라인의 세로 크기 (Alt + 휠)" onInput=${(e) => upd((p) => { p.rowH = Number(e.target.value); })} /></label>
      <select class="chip-in" style=${{ width: '92px' }} aria-label="Language" title="Language / 언어" value=${window.VOMIX_LANG} onChange=${(e) => window.vomixSetLang(e.target.value)}><option value="ko">한국어</option><option value="en">English</option></select>
        <button class="btn sm" onClick=${() => ui({ helpOpen: true })}>사용법</button>
      <button class="btn sm" style=${{ borderColor: plan.plan === 'pro' ? '#2dd4bf' : '' }} title="무료와 프로의 차이, 라이선스 키 입력" onClick=${() => ui({ planOpen: true })}>${plan.plan === 'pro' ? '프로 플랜' : '무료 플랜'}</button>
      <button class="btn" title="MIDI, 음 목록, 라인별 소리를 다른 프로그램에서 쓰도록 내보내요" onClick=${() => ui({ exportOpen: true })}>다른 프로그램용</button>
      <button class="btn primary" disabled=${U.rendering === 'export'} onClick=${exportWav}>WAV 내보내기</button>
    </div>

    <div class="main">
      <div class="side">
        <div class="win" style=${{ height: '196px', flex: 'none' }}>
          <div class="win-h"><b>샘플 (내 소리)</b><span>끌어서 놓기 · 또는 눌러서 들기</span></div>
          <div class="win-b scroll">
            ${P.samples.length === 0 && html`<div class="hint" style=${{ padding: '4px' }}>아래 버튼으로 소리 파일을 추가하세요. 파일 이름이 그대로 표시돼요.</div>`}
            ${P.samples.filter((s) => !s.piece).map((s) => {
              const on = U.armed === s.id;
              return html`<div class=${'srow' + (on ? ' armed' : '')} key=${s.id}>
                <button class="main-btn" draggable="true" aria-label=${s.file + (on ? ' 내려놓기' : ' 들기')}
                  onDragStart=${(e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick=${() => ui({ armed: on ? null : s.id })}>
                  <span class="nm">${s.file}</span>
                  <span class="sub">${on ? '들고 있음 · 구간을 누르세요' : s.sel ? s.sel.start.toFixed(2) + '~' + s.sel.end.toFixed(2) + '초' + (s.sel.root != null ? ' · 기준음 ' + noteName(Math.round(s.sel.root)) : ' · 음높이 못 찾음 (라 기준)') : ''}</span>
                </button>
                <button class="tbtn" aria-label=${s.file + ' 자르기'} onClick=${() => ui({ cutting: s.id })}>자르기</button>
                <button class="tbtn" aria-label=${s.file + ' 삭제'} title="이 샘플을 목록에서 지워요" onClick=${() => deleteSample(s)}>삭제</button>
              </div>`;
            })}
          </div>
          <div class="win-f">
            <input ref=${fileSmp} type="file" multiple accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg" style=${{ display: 'none' }} onChange=${(e) => { addSamples([...e.target.files]); e.target.value = ''; }} />
            <button class="dashed" onClick=${() => fileSmp.current.click()}>+ 소리 파일 추가</button>
          </div>
        </div>

        <div class="win" style=${{ height: '320px', flex: 'none' }}>
          <div class="win-h"><b>참조곡 (힌트)</b><span>체크 = 가운데에 표시</span></div>
          <div class="win-b scroll">
            <select class="in" style=${{ flex: 'none', padding: '5px 8px', fontSize: '12px' }} aria-label="분리 정밀도" value=${U.refModel} onChange=${(e) => { if (e.target.value === 'mega53' && !(plan.limits && plan.limits.precise_hints)) { ui({ planOpen: true, notice: '정밀 참조곡 힌트는 프로 플랜에서 쓸 수 있어요' }); return; } ui({ refModel: e.target.value }); }}>
              <option value="htdemucs_6s">빠르게 · 소리 6개 (약 4분)</option>
              <option value="mega53">${`${plan.limits && plan.limits.precise_hints ? '' : '🔒 프로 · '}정밀하게 · 소리 최대 53개 (곡 길이의 약 11배)`}</option>
            </select>
            ${P.ref && !refJob && html`<div class="hint" style=${{ flex: 'none', padding: '0 2px' }}>${`지금 결과: ${modelLabel(P.ref.model)}`}</div>`}
            ${P.ref && !refJob && (P.ref.model || '') !== U.refModel && html`<button class="btn sm" style=${{ flex: 'none', whiteSpace: 'normal', textAlign: 'left' }} onClick=${reanalyze}>${`이 곡을 '${modelLabel(U.refModel)}'으로 다시 분석`}<br /><span style=${{ color: '#9aa4b5' }}>파일을 다시 고를 필요 없어요 · 끝날 때까지 지금 결과는 그대로예요</span></button>`}
            ${refJob && html`<div style=${{ flex: 'none', padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style=${{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${refJob.name}</div>
              <div class="prog"><i></i></div>
              <div class="hint">${`${refJob.phase} · ${refJob.elapsed || 0}초`}</div>
            </div>`}
            ${!refJob && !P.ref && html`<div class="hint" style=${{ padding: '4px' }}>참조곡을 추가하면 소리별(보컬, 드럼, 베이스, 기타, 피아노 등)로 나눠서 음을 뽑아 줘요. 몇 분 걸려요.</div>`}
            ${P.ref && html`<div style=${{ flex: 'none', fontWeight: 500, fontSize: '13px', padding: '0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${P.ref.name}</div>
              <div style=${{ flex: 'none', display: 'flex', gap: '10px', padding: '0 2px', alignItems: 'center' }}>
                <label style=${{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px', color: '#9aa4b5' }}>BPM <input class="chip-in" style=${{ flex: 1, minWidth: 0, width: '100%', padding: '4px 6px', fontSize: '13px' }} type="number" step="0.1" value=${P.ref.bpm} onInput=${(e) => upd((p) => { p.ref.bpm = clamp(Number(e.target.value) || 120, 40, 300); })} /></label>
                <label style=${{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px', color: '#9aa4b5' }}>시작 <input class="chip-in" style=${{ flex: 1, minWidth: 0, width: '100%', padding: '4px 6px', fontSize: '13px' }} type="number" step="0.01" value=${P.ref.offset} onInput=${(e) => upd((p) => { p.ref.offset = Number(e.target.value) || 0; })} /></label>
              </div>
              ${defs.map((d) => {
                const on = isOn(d);
                const cnt = d.count;
                const fl = P.ref.meta && P.ref.meta[d.key] && P.ref.meta[d.key].filled;
                return [html`<button class="lrow" key=${d.key} style=${{ width: '100%', textAlign: 'left' }} aria-label=${d.name + (on ? ' 숨기기' : ' 보기')} onClick=${() => ui({ refOn: { ...U.refOn, [d.key]: !on } })}>
                  <span style=${{ flex: 'none', width: '14px', height: '14px', borderRadius: '3px', border: '1px solid #6b7686', background: on ? '#2dd4bf' : 'transparent' }}></span>
                  <span class="nm" style=${{ flex: 1 }}>${d.name}</span><span class="sub">${cnt ? cnt + (d.kind === 'drum' ? '번' : '개') : '없음'}</span></button>`,
                  d.kind === 'pitch' && cnt > 0 && html`<div key=${d.key + '-fill'} style=${{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0 2px 2px 22px' }}>
                    <button class="tbtn" disabled=${!!U.analyzing} aria-label=${d.name + ' 빈 곳 채우기'} title="음을 못 찾은 자리에 소리가 나고 있으면, 소리의 음높이 선을 따라 음을 더 뽑아요" onClick=${() => fillStem(d.key)}>${U.analyzing === d.key + ':fill' ? '채우는 중…' : (fl != null ? '빈 곳 다시 채우기' : '빈 곳 채우기')}</button>
                    ${fl != null && html`<span class="hint">${fl}개 더함</span>`}</div>`];
              })}
              ${more.length > 0 && html`<div class="hint" style=${{ flex: 'none', padding: '4px 2px 0' }}>나뉘었지만 음을 아직 안 뽑은 소리 (누르면 뽑아요)</div>`}
              ${more.map((a) => html`<div class="lrow" key=${a.key}>
                <span class="nm" style=${{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${a.name}</span>
                <span class="sub">${`크기 ${a.rms}`}</span>
                <button class="tbtn" disabled=${!!U.analyzing} aria-label=${a.name + ' 음 뽑기'} onClick=${() => analyzeStem(a.key)}>${U.analyzing === a.key ? '뽑는 중…' : '음 뽑기'}</button>
              </div>`)}`}
          </div>
          <div class="win-f">
            <input ref=${fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg" style=${{ display: 'none' }} onChange=${(e) => { if (e.target.files[0]) addRef(e.target.files[0]); e.target.value = ''; }} />
            <button class="dashed" disabled=${!!refJob} onClick=${() => fileRef.current.click()}>${P.ref ? '+ 다른 참조곡으로 바꾸기' : '+ 참조곡 추가'}</button>
          </div>
        </div>

        <div class="win" style=${{ flex: 1 }}>
          <div class="win-h"><b>노드 모음</b><span>끌어서 라인에 놓기 · 눌러서 편집</span></div>
          <div class="win-b scroll">
            ${P.lib.length === 0 && html`<div class="hint" style=${{ padding: '4px' }}>자르기 창의 '잘라서 노드로 만들기', 참조곡의 '노드 모음에 저장', 아래의 '선택한 노드를 모음에 저장'으로 여기에 채워요.</div>`}
            ${P.lib.map((d) => html`<div class="lrow" key=${d.id} style=${{ flexWrap: 'wrap', borderColor: U.libSel === d.id ? '#2dd4bf' : '' }}>
              <button draggable="true" style=${{ flex: 1, minWidth: 0, background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'grab' }} aria-label=${d.name + ' 노드 (라인으로 끌어다 놓거나, 눌러서 놓는 방법 고르기)'}
                onDragStart=${(e) => { e.dataTransfer.setData('text/plain', 'lib:' + d.id); e.dataTransfer.effectAllowed = 'copy'; dragLib = { id: d.id, l: d.l }; }}
                onDragEnd=${() => { dragLib = null; ui({ dropPrev: null }); }}
                onClick=${() => ui({ libSel: U.libSel === d.id ? null : d.id })} onDblClick=${() => ui({ entryEdit: d.id })}>
                <div class="nm" style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style=${{ color: 'var(--dim)', marginRight: '6px', letterSpacing: '-2px' }} aria-hidden="true">⋮⋮</span>${d.name}</div><div class="sub">${`${fmt(d.l)}박 · 노드 ${d.notes.length}개${d.at != null ? ' · 원곡 ' + fmt(d.at + 1) + '박째' : ''}${d.sampleId && sampleOf(d.sampleId) ? ' · ' + sampleOf(d.sampleId).file : ''}`}</div></button>
              ${U.libSel === d.id && html`<div class="libact" style=${{ width: '100%' }}>
                <button class="chipbtn" onClick=${() => ui({ entryEdit: d.id })}>노드 편집</button>
                <button class="chipbtn" onClick=${() => addFromLib(d)}>선택 라인에 추가</button>
                ${d.at != null && html`<button class="chipbtn" onClick=${() => placeLibAt(d, d.at)}>${`참조 위치(${fmt(d.at + 1)}박)에 놓기`}</button>`}
                ${guide != null && html`<button class="chipbtn" onClick=${() => placeLibAt(d, guide)}>${`기준선(${fmt(guide + 1)}박)에 놓기`}</button>`}
                <button class="chipbtn" onClick=${() => { upd((p) => { p.lib = p.lib.filter((x) => x.id !== d.id); }); ui({ libSel: null }); }}>삭제</button>
              </div>`}
            </div>`)}
          </div>
          ${node && html`<div class="win-f"><button class="dashed" onClick=${saveBundleToLib}>+ 선택한 노드 뭉치를 모음에 저장</button></div>`}
        </div>
      </div>

      <div class="center" onMouseDown=${deselect}>
        <div class="center-h">
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
            <div class="t">참조곡에서 구간을 끌어 고르고, 샘플을 놓으세요 · 라인은 '작게'/'크게'로 볼 수 있어요</div>
            ${selRef && html`<div style=${{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style=${{ fontSize: '12px', color: '#7ee8d9' }}>${`${selRef.only != null ? onlyName(selRef) + ' 한 음' : refDef(selRef.key).name + ' ' + rangeText(selRef.a, selRef.b)} 선택됨 (${fmt(selRef.b - selRef.a)}박)`}</span>
              <button class="btn sm" onClick=${() => playRange('stem')}>${U.rangePlaying === 'stem' ? '■ 멈춤' : '▶ 구간 듣기 (' + refDef(selRef.key).name + ')'}</button>
              <button class="btn sm" onClick=${() => playRange('orig')}>${U.rangePlaying === 'orig' ? '■ 멈춤' : '▶ 원곡으로 듣기'}</button>
              <button class="btn sm" onClick=${() => createFromSel(null)}>라인 샘플로 넣기 (어디에 넣을지 묻기)</button>
              <button class="btn sm" onClick=${saveRefToLib}>노드 모음에 저장</button>
              <button class="btn sm ghost" onClick=${() => ui({ refSel: null })}>선택 해제</button>
              <label style=${{ fontSize: '12px', color: '#9aa4b5', display: 'flex', alignItems: 'center', gap: '4px' }}><input type="checkbox" checked=${U.keepTiming !== false} onChange=${(e) => ui({ keepTiming: e.target.checked })} />원래 박자 그대로 (한 박에 여러 음 유지)</label>
              <label style=${{ fontSize: '12px', color: '#9aa4b5', display: 'flex', alignItems: 'center', gap: '4px' }}><input type="checkbox" checked=${U.melodyOnly !== false} onChange=${(e) => ui({ melodyOnly: e.target.checked })} />섞인 레인은 멜로디 후보 한 줄만 (끄면 모든 음)</label>
            </div>`}
            ${U.armed && html`<div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style=${{ fontSize: '12px', color: '#7ee8d9' }}>${`들고 있는 샘플: ${(sampleOf(U.armed) || {}).file} · 선택한 구간을 누르세요`}</span>
              <button class="btn sm ghost" onClick=${() => ui({ armed: null })}>내려놓기</button></div>`}
            ${U.notice && html`<div class="notice">${U.notice}</div>`}
          </div>
          <div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', fontSize: '12px', color: '#9aa4b5', flex: 'none' }}>
            <span>음 위의 숫자 = 샘플을 옮긴 반음 수</span>
          </div>
        </div>

        <div class="tl-scroll" ref=${scrollRef} onDragOver=${dragScroll}>
          <div class="tl" style=${{ width: HEADW + T * PX + 'px', '--g': grid < 0.03 ? 1 : grid, '--px': PX + 'px' }}>
            <div class="ruler"><div class="hd-s">박</div>
              <div class="rl" title="눌러서 세로 기준선을 놓고, 끌어서 옮겨요 (Alt = 격자 무시)" style=${{ width: T * PX + 'px', cursor: 'pointer' }} onMouseDown=${startGuideDrag}>${Array.from({ length: Math.ceil(T / 4) }, (_, i) => html`<span key=${i} style=${{ left: i * 4 * PX + 4 + 'px' }}>${i + 1}</span>`)}
                ${guide != null && html`<div class="gflag" style=${{ left: guide * PX + 'px' }}>${fmt(guide + 1)}</div>`}</div></div>
            ${P.ref ? html`<div class="sect">${`참조곡 힌트 · 칸을 끌어 구간을 고른 뒤 샘플을 놓으세요 · 놓을 라인: '${line ? line.name : '(없음)'}'`}</div>` : null}
            ${visRef.map((d) => html`<${RefLane} def=${d} ctx=${ctx} key=${d.key} />`)}
            <div class="sect">내 라인
              <button class=${'tbtn' + (playingAll ? ' on' : '')} style=${{ height: '22px', padding: '0 10px', background: playingAll ? '#2dd4bf' : '', color: playingAll ? '#06231f' : '', fontWeight: 700 }} onClick=${() => play('all')}>${U.rendering === 'all' ? '만드는 중…' : playingAll ? '■ 전체 정지' : '▶ 전체 재생'}</button>
            </div>
            ${P.lines.map((L) => html`<${LineRow} L=${L} ctx=${ctx} key=${L.id} />`)}
            <button class="btn" style=${{ width: HEADW + 'px', position: 'sticky', left: 0, borderStyle: 'dashed' }}
              onClick=${() => { if (lineFull) { ui({ planOpen: true, notice: '무료 플랜은 내 라인을 ' + maxLines + '개까지 만들 수 있어요' }); return; } const id = uid('L'); upd((p) => { p.lines.push({ id, name: '새 라인 ' + (p.lines.length + 1), color: COLORS[p.lines.length % COLORS.length], size: 'small', sampleId: P.samples[0] ? P.samples[0].id : null, nodes: [] }); }); ui({ selLine: id, selNode: null, selNote: null }); }}>${lineFull ? `+ 라인 추가 (${P.lines.length}/${maxLines} · 프로)` : '+ 라인 추가'}</button>
            ${guide != null && html`<div class="guideline" style=${{ left: HEADW + guide * PX + 'px' }}></div>`}
            <${Playhead} scrollRef=${scrollRef} />
          </div>
        </div>
        <${MixDock} P=${P} setMix=${setMix} setMaster=${setMaster} ui=${ui} open=${U.mixOpen !== false} resetAll=${resetMix} />
        <div class="transport">
          <button class="btn primary" onClick=${() => play('all')}>${playingAll ? '정지' : '재생'}</button>
          <span class="hint">${`BPM ${P.bpm} · ${T}박`}</span>
        </div>
      </div>

      <div class="right scroll">
        ${guideInfo && html`<div class="h-label">${`세로 기준선 · ${fmt(guide + 1)}박째`}</div>
          <div class="card" style=${{ borderColor: '#f472b6' }}>
            <div class="gsec">이 박자에 나오는 참조 음</div>
            ${guideInfo.refs.length === 0 && html`<div class="hint">없음</div>`}
            <div class="grow">${guideInfo.refs.map((x) => html`<span key=${x.key + x.i} class="gdot">
              <button class="chipbtn" onClick=${() => selectRefNote(x.key, x.i)}>${x.def.name} ${x.def.kind === 'drum' ? (x.n.k === 'kick' ? '킥' : x.n.k === 'snare' ? '스네어' : '하이햇') : noteName(x.n.p)}</button>
              <button class="chipbtn" title="선택한 라인의 이 박자에 같은 음으로 넣기" onClick=${() => putRefNote(x.key, x.i, guide)}>＋</button></span>`)}</div>
            <div class="gsec">내 라인에 있는 것</div>
            ${guideInfo.mine.length === 0 && html`<div class="hint">없음</div>`}
            <div class="grow">${guideInfo.mine.map((x) => html`<button key=${x.q.id} class="chipbtn" onClick=${() => ui({ selLine: x.ln.id, selNode: x.q.id, selNote: null })}>${x.ln.name}: ${x.q.name}${x.notes.length ? ' (' + x.notes.map((k) => noteName(k.p)).join(', ') + ')' : ''}</button>`)}</div>
            <div class="gsec">${`'${line ? line.name : P.lines[0].name}' 라인에 이 박자로 음 넣기`}</div>
            <div class="grow"><select class="in" style=${{ width: '120px', padding: '4px 6px' }} aria-label="넣을 음" value=${String(U.gPitch)} onChange=${(e) => ui({ gPitch: Number(e.target.value) })}>
              ${Array.from({ length: 61 }, (_, i) => 96 - i).map((p) => html`<option key=${p} value=${String(p)}>${noteName(p)}</option>`)}</select>
              <button class="chipbtn" onClick=${() => insertNoteAtGuide(U.gPitch)}>기준선에 넣기</button></div>
            <button class="btn" onClick=${() => play('all', guide)}>▶ 기준선부터 재생</button>
            <button class="btn ghost" onClick=${() => ui({ guide: null })}>기준선 지우기</button>
          </div>`}
        ${refNoteData && refNoteDef && html`<div class="h-label">선택한 참조 음</div>
          <div class="card">
            <div class="kv"><span>소리</span><span>${refNoteDef.name}</span></div>
            ${refNoteDef.kind === 'pitch'
              ? html`<div class="kv"><span>음</span><span style=${{ fontSize: '20px', fontWeight: 700 }}>${noteName(refNoteData.p)} (${refNoteData.p})</span></div>`
              : html`<div class="kv"><span>종류</span><span>${refNoteData.k === 'kick' ? '킥' : refNoteData.k === 'snare' ? '스네어' : '하이햇'}</span></div>`}
            <div class="kv"><span>시작</span><span>${`${fmt(refNoteData.t + 1)}박째 · ${(P.ref.offset + (refNoteData.t * 60) / P.ref.bpm).toFixed(2)}초`}</span></div>
            ${refNoteData.l != null && html`<div class="kv"><span>길이</span><span>${`${fmt(refNoteData.l)}박`}</span></div>`}
            ${refNoteData.a != null && html`<div class="kv"><span>세기</span><span>${refNoteData.a}</span></div>`}
            ${refNoteDef.poly && html`<div class="kv"><span>구분</span><span>${refNoteData.m ? '멜로디 후보' : '반주 ("멜로디 후보 한 줄만"을 켜면 구간 가져올 때 빠져요)'}</span></div>`}
            ${refNoteRun && refNoteRun.list.length > 1 && html`<div class="hint" style=${{ background: '#1b1f26', borderRadius: '8px', padding: '8px 10px' }}>${`같은 음이 끊김 없이 ${refNoteRun.list.length}개 이어져 있어요 (지금 음은 ${refNoteRun.pos + 1}번째). 한 줄처럼 보여도 음은 따로따로예요.`}</div>`}
            ${refHits.length > 0 && html`<div class="hint" style=${{ background: '#2a2216', border: '1px solid #f2c94c', borderRadius: '8px', padding: '8px 10px' }}>${`⚠ 이 음은 한 덩어리로 분석됐지만, 녹음을 들여다보면 소리가 ${refHits.length + 1}번 이어서 나요. 처음 + ${refHits.map((b) => fmt(b + 1) + '박째').join(', ')}에서 새로 시작해요.`}
              <div class="grow" style=${{ marginTop: '6px' }}><button class="chipbtn" onClick=${() => ui({ guide: refHits[0] })}>첫 새 소리 위치에 기준선 놓기</button></div></div>`}
            ${refNoteWith.length > 0 && html`<div class="hint" style=${{ background: '#2a2216', border: '1px solid #f2c94c', borderRadius: '8px', padding: '8px 10px' }}>${`⚠ 같은 시간에 이 레인에서 ${refNoteWith.length}개 음이 더 울려요. '녹음 그대로' 들으면 같이 섞여 들려요. '이 음만 듣기'는 줄여 줘요.`}
              <div class="grow" style=${{ marginTop: '6px' }}>${refNoteWith.map(({ n, j }) => html`<button key=${j} class="chipbtn" title=${refNoteDef.kind === 'pitch' && [0, 5, 7].includes((((n.p - refNoteData.p) % 12) + 12) % 12) ? '옥타브·4도·5도 관계라 배음이 겹쳐서, 이 음과 완전히 떼어 낼 수 없어요' : ''} onClick=${() => selectRefNote(U.refNote.key, j)}>${refNoteDef.kind === 'pitch' ? noteName(n.p) + ([0, 5, 7].includes((((n.p - refNoteData.p) % 12) + 12) % 12) ? ' (분리 어려움)' : '') : (n.k === 'kick' ? '킥' : n.k === 'snare' ? '스네어' : '하이햇')}</button>`)}</div></div>`}
            ${refNoteDef.kind === 'pitch'
              ? html`<button class="btn primary" onClick=${() => playIso(U.refNote.key, refNoteData)}>${U.rangePlaying === 'iso' ? '■ 멈춤' : '▶ 이 음만 듣기 (겹친 음 줄임)'}</button>
                <button class="btn" onClick=${() => playRange('stem', true)}>${U.rangePlaying === 'stem' ? '■ 멈춤' : '▶ 녹음 그대로 듣기 (겹친 음 포함)'}</button>`
              : html`<button class="btn primary" onClick=${() => playRange('stem')}>${U.rangePlaying === 'stem' ? '■ 멈춤' : '▶ 이 음 듣기'}</button>`}
            ${refNoteDef.kind === 'pitch' && html`<button class="btn" onClick=${() => playTone(refNoteData.p, refNoteData.l)}>♪ 이 음높이만 듣기 (단순한 소리)</button>`}
            <button class="btn" onClick=${() => saveRefNotes(U.refNote.key, [U.refNote.i])}>이 음만 노드 모음에 저장</button>
            ${refNoteRun && refNoteRun.list.length > 1 && html`<button class="btn" onClick=${() => saveRefNotes(U.refNote.key, refNoteRun.list)}>${`연속된 같은 음 ${refNoteRun.list.length}개를 노드 모음에 저장`}</button>`}
            <button class="btn ghost" onClick=${() => ui({ refNote: null })}>이 음 선택 해제</button>
          </div>`}
        ${node && line && html`<div class="selmode" role="group" aria-label="무엇을 고쳐요">
          <button class=${'tbtn' + (!note ? ' on' : '')} aria-pressed=${!note} title="노드 뭉치 전체를 고쳐요" onClick=${() => ui({ selNote: null, selMore: null })}>노드 뭉치</button>
          <button class=${'tbtn' + (note ? ' on' : '')} aria-pressed=${!!note} title=${note ? '뭉치 안의 선택한 노드를 고쳐요' : "뭉치 안의 노드 하나를 골라 고쳐요 (라인이 '작게'면 '크게'로 바꿔요)"}
            onClick=${() => {
              if (note) return;
              // no node chosen yet: open the first one of the bundle for editing and show the line large, so the others can be clicked
              const first = node.notes.reduce((m, k, i) => (m < 0 || k.s < node.notes[m].s ? i : m), -1);
              if (first < 0) return;
              if (line.size !== 'large') upd((p) => { p.lines.find((x) => x.id === line.id).size = 'large'; });
              ui({ selLine: line.id, selNode: node.id, selNote: first, selMore: null, notice: "'크게' 보기로 바꿨어요. 라인에서 노드를 눌러 다른 노드를 고르세요" });
            }}>노드</button>
        </div>`}
        ${!note && html`<div class="h-label">선택한 노드 뭉치 <span style=${{ fontWeight: 400, color: 'var(--dim)' }}>(노드 여러 칸의 묶음)</span></div>`}
        ${!node && html`<div class="hint">라인에서 노드 뭉치를 눌러 선택하세요.</div>`}
        ${node && line && note && html`<div class="hint" style=${{ marginBottom: '4px' }}>${`뭉치: ${tx(node.name)}`}</div>`}
        ${node && line && !note && node.notes.length === 0 && html`<div class="notice" style=${{ marginBottom: '6px' }}>이 뭉치에는 노드(음)가 하나도 없어서 소리가 나지 않아요. 필요 없으면 아래 "라인에서 빼기"를 누르세요.</div>`}
        ${node && line && !note && html`<div class="card edit" style=${{ borderColor: line.color }}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}><span class="pill-tag" style=${{ background: line.color }}>수정 중</span><span class="hint">${`${line.name} 라인`}</span></div>
          <input class="in" style=${{ fontSize: '16px', fontWeight: 700 }} aria-label="노드 이름" value=${tx(node.name)} onInput=${(e) => editNode((nd) => { nd.name = e.target.value; })} />
          <div class="kv"><span>소리</span>
            <select class="in" style=${{ width: '150px', padding: '4px 6px', fontSize: '12px' }} aria-label="노드 소리" value=${node.sampleId || line.sampleId || ''} onChange=${(e) => { const v = e.target.value; upd((p) => { const L = p.lines.find((x) => x.id === line.id); const nd = L.nodes.find((x) => x.id === node.id); if (nd.sampleId !== v) nd.notes.forEach((k) => { delete k.sampleId; delete k.cs; delete k.ce; }); nd.sampleId = v; if (v !== 'ref') L.sampleId = v; }); }}>
              ${soundOptions(P, node.sampleId || line.sampleId, P.ref && node.src ? ((defs.find((d) => d.key === node.src.key) || {}).name || node.src.key) : null)}
            </select></div>
          ${node.src && P.ref && html`<label class="kv" style=${{ cursor: node.sampleId === 'ref' ? 'pointer' : 'default', opacity: node.sampleId === 'ref' ? 1 : 0.55, alignItems: 'flex-start', gap: '8px' }} title=${node.sampleId === 'ref' ? '켜면 노드가 없는 구간의 소리도 원곡 그대로 들려요. 끄면 노드가 있는 곳의 소리만 나와요' : "위의 '소리'를 '참조곡의 원래 소리'로 고르면 쓸 수 있어요"}>
            <span style=${{ flex: 1 }}>노드가 없는 구간도 원곡 그대로</span>
            <input type="checkbox" disabled=${node.sampleId !== 'ref'} checked=${node.sampleId === 'ref' && !!node.refFill} onChange=${(e) => { const on = e.target.checked; editNode((nd) => { if (on) nd.refFill = true; else delete nd.refFill; }); }} /></label>`}
          ${(() => {
            const bs = sampleOf(node.sampleId || line.sampleId);
            if (!bs || !bs.sel) return null;
            return html`<div class="kv"><span>음높이 곡선</span>
              <button class="tbtn" aria-label="음높이 곡선 편집" title="소리의 음높이 흐름을 마우스로 잡아당겨 고쳐요" onClick=${() => ui({ pitchEdit: bs.id })}>${bs.bend && bs.bend.length ? `고치는 중 · 점 ${bs.bend.length}개` : '곡선 편집'}</button></div>`;
          })()}
          <div class="kv"><span>길이 맞추기</span>
            <select class="in" style=${{ width: '150px', padding: '4px 6px', fontSize: '12px' }} aria-label="긴 음을 소리로 채우는 방법" title="늘리기: 샘플 하나를 음 길이만큼 늘려요 · 반복하기: 음이 샘플보다 훨씬 길면 샘플을 되풀이해요 · 원래 속도로: 소리를 늘이지 않고 원래 속도로 흘려보내며 음정만 노드의 음을 따라가요" value=${node.fit || ''} onChange=${(e) => editNode((nd) => { if (e.target.value) nd.fit = e.target.value; else delete nd.fit; })}>
              <option value="">${`라인 설정 따르기 (${line.fit === 'repeat' ? '반복하기' : line.fit === 'keep' ? '원래 속도로' : '늘리기'})`}</option>
              <option value="stretch">늘리기 (소리를 길게 늘임)</option>
              <option value="repeat">반복하기 (소리를 되풀이)</option>
              <option value="keep">원래 속도로 (음정만 멜로디에 맞춤)</option>
            </select></div>
          <button class="btn" style=${{ background: U.playing === 'node' ? '#2dd4bf' : '', color: U.playing === 'node' ? '#06231f' : '' }} onClick=${playNode}>${U.rendering === 'node' ? '만드는 중…' : U.playing === 'node' ? '■ 멈춤' : '▶ 이 노드 듣기'}</button>
          <div class="kv"><span>시작 (박째)</span><input class="in" type="number" step="0.01" style=${{ width: '110px', padding: '4px 6px' }} aria-label="노드 시작 위치 (박째)" key=${'s' + node.id + node.s + U.notice} defaultValue=${fmt(node.s + 1)} onChange=${(e) => setNodeStart(Number(e.target.value) - 1)} /></div>
          <div class="kv"><span>길이 (박)</span><input class="in" type="number" step="0.01" min="0.06" style=${{ width: '110px', padding: '4px 6px' }} aria-label="노드 길이 (박)" key=${'l' + node.id + node.l + U.notice} defaultValue=${fmt(node.l)} onChange=${(e) => setNodeLength(Number(e.target.value))} /></div>
          <div class="two"><button class="btn" onClick=${() => nudgeFine(-0.1)}>−0.1</button><button class="btn" onClick=${() => nudgeFine(-0.01)}>−0.01</button><button class="btn" onClick=${() => nudgeFine(0.01)}>+0.01</button><button class="btn" onClick=${() => nudgeFine(0.1)}>+0.1</button></div>
          ${refPos != null && html`<button class="btn" onClick=${() => setNodeStart(refPos)}>${`참조곡 위치(${fmt(refPos + 1)}박째)에 맞추기`}</button>`}
          ${guide != null && html`<button class="btn" onClick=${() => setNodeStart(guide)}>${`기준선(${fmt(guide + 1)}박째)으로 옮기기`}</button>`}
          <div class="kv"><span>노드 전체 음높이</span><span>${`${sgn(node.shift || 0)} 반음`}</span></div>
          <div class="two"><button class="btn" onClick=${() => transposeNode(-1)}>반음 내리기</button><button class="btn" onClick=${() => transposeNode(1)}>반음 올리기</button></div>
          <div class="two"><button class="btn" onClick=${() => transposeNode(-12)}>한 옥타브 내리기</button><button class="btn" onClick=${() => transposeNode(12)}>한 옥타브 올리기</button></div>
          ${(node.shift || 0) !== 0 && html`<button class="btn ghost" onClick=${resetNodePitch}>${`음높이를 처음대로 (${sgn(-(node.shift || 0))}반음)`}</button>`}
          ${node.src && html`<div class="kv"><span>참조 구간</span><span>${srcName(node.src)}</span></div>`}
          <div class="two"><button class="btn" onClick=${() => trim(-grid)}>${`끝 ${fmt(grid)}박 줄이기`}</button><button class="btn" onClick=${() => trim(grid)}>${`끝 ${fmt(grid)}박 늘리기`}</button></div>
          <div class="two"><button class="btn" onClick=${() => nudge(-1)}>${`${fmt(grid)}박 앞으로`}</button>
            <button class="btn" onClick=${() => nudge(1)}>${`${fmt(grid)}박 뒤로`}</button></div>
          <button class="btn primary" onClick=${saveBundleToLib}>이 뭉치를 노드 모음에 저장</button>
          <button class="btn" onClick=${saveEachNoteToLib}>${`이 뭉치의 노드를 하나씩 모음에 저장 (${node.notes.length}개)`}</button>
          <button class="btn danger" onClick=${() => { upd((p) => { const L = p.lines.find((x) => x.id === line.id); L.nodes = L.nodes.filter((x) => x.id !== node.id); }); ui({ selNode: null, selNote: null, hoverNode: null }); }}>라인에서 빼기</button>
        </div>`}
        ${note && html`<div class="h-label">${`선택한 노드${selIdx.length > 1 ? ' · ' + selIdx.length + '개' : ''}`} <span style=${{ fontWeight: 400, color: 'var(--dim)' }}>(뭉치 안의 한 칸)</span></div>
          <div class="card">
            ${selIdx.length === 1
              ? html`<div class="kv"><span>음</span><span style=${{ fontSize: '22px', fontWeight: 700 }}>${noteName(note.p)}</span></div>
                <div class="kv"><span>샘플 이동</span><span>${`${sgn((note.sampleId || node.sampleId) === 'ref' ? note.p - (origOf(node, note) != null ? origOf(node, note) : note.p) : note.p - rootOf(note.sampleId || node.sampleId || line.sampleId))} 반음`}</span></div>`
              : html`<div class="kv"><span>음</span><span style=${{ fontSize: '13px' }}>${selIdx.map((i) => noteName(node.notes[i].p)).join(', ')}</span></div>`}
            <div class="two"><button class="btn" onClick=${() => notePitch(-1)}>반음 ↓</button><button class="btn" onClick=${() => notePitch(1)}>반음 ↑</button>
              <button class="btn" onClick=${() => notePitch(-12)}>옥타브 ↓</button><button class="btn" onClick=${() => notePitch(12)}>옥타브 ↑</button></div>
            ${(() => {
              const own = selIdx.map((i) => node.notes[i].sampleId || '');
              const cur = own.every((x) => x === own[0]) ? own[0] : '';
              return html`<div class="kv"><span>소리</span>
                <select class="in" style=${{ width: '150px', padding: '4px 6px', fontSize: '12px' }} aria-label="선택한 노드의 소리" title="이 노드만 다른 소리로 바꿔요. 고르지 않으면 뭉치와 같은 소리예요" value=${cur} onChange=${(e) => { const v = e.target.value; editNode((nd) => { selIdx.forEach((i) => { const k = nd.notes[i]; if (v) { k.sampleId = v; delete k.cs; delete k.ce; } else delete k.sampleId; }); }); }}>
                  <option value="">뭉치와 같은 소리</option>
                  ${soundOptions(P, cur || node.sampleId, P.ref && node.src ? ((defs.find((d) => d.key === node.src.key) || {}).name || node.src.key) : null)}
                </select></div>`;
            })()}
            ${(() => {
              const gs = selIdx.map((i) => (node.notes[i].g != null ? node.notes[i].g : 1));
              const cur = Math.round((gs.every((x) => x === gs[0]) ? gs[0] : 1) * 100);
              return html`<div class="kv"><span>소리 크기</span>
                <span style=${{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input type="range" min="0" max="500" step="5" value=${cur} aria-label="선택한 노드의 소리 크기" title="이 노드만 크게 또는 작게 해요. 100%가 원래 크기예요" key=${'g' + node.id + selIdx.join(',') + cur}
                    onChange=${(e) => { const v = Number(e.target.value); editNode((nd) => { selIdx.forEach((i) => { if (v === 100) delete nd.notes[i].g; else nd.notes[i].g = v / 100; }); }); }} />
                  <span style=${{ width: '40px', textAlign: 'right' }}>${cur + '%'}</span></span></div>`;
            })()}
            <button class="btn" style=${{ background: U.playing === 'node' ? '#2dd4bf' : '', color: U.playing === 'node' ? '#06231f' : '' }} onClick=${playNote}>${U.rendering === 'node' ? '만드는 중…' : U.playing === 'node' ? '■ 멈춤' : '▶ 선택한 노드 듣기'}</button>
            ${selIdx.length === 1 && html`<div class="kv"><span>시작 (박째)</span><input class="in" type="number" step="0.01" style=${{ width: '110px', padding: '4px 6px' }} aria-label="노드 시작 위치 (박째)" key=${'ns' + node.id + selIdx[0] + note.s + U.notice} defaultValue=${fmt(node.s + note.s + 1)} onChange=${(e) => noteSetStart(Number(e.target.value))} /></div>
              <div class="kv"><span>길이 (박)</span><input class="in" type="number" step="0.01" min="0.06" style=${{ width: '110px', padding: '4px 6px' }} aria-label="노드 길이 (박)" key=${'nl' + node.id + selIdx[0] + note.l + U.notice} defaultValue=${fmt(note.l)} onChange=${(e) => noteSetLen(Number(e.target.value))} /></div>`}
            <div class="hint">위치 미세 이동 (박)</div>
            <div class="two"><button class="btn" onClick=${() => noteMove(-0.1)}>−0.1</button><button class="btn" onClick=${() => noteMove(-0.01)}>−0.01</button><button class="btn" onClick=${() => noteMove(0.01)}>+0.01</button><button class="btn" onClick=${() => noteMove(0.1)}>+0.1</button></div>
            <div class="hint">길이 조절 (박)</div>
            <div class="two"><button class="btn" onClick=${() => noteLen(-0.1)}>−0.1</button><button class="btn" onClick=${() => noteLen(-0.01)}>−0.01</button><button class="btn" onClick=${() => noteLen(0.01)}>+0.01</button><button class="btn" onClick=${() => noteLen(0.1)}>+0.1</button></div>
            <div class="two"><button class="btn" onClick=${() => noteLen(-grid)}>${`${fmt(grid)}박 짧게`}</button><button class="btn" onClick=${() => noteLen(grid)}>${`${fmt(grid)}박 길게`}</button></div>
            <button class="btn" onClick=${noteToNext}>다음 노드 앞까지 늘이기</button>
            ${selIdx.length === 1 && (() => { const sm = noteSample(note); return html`<button class="btn" disabled=${!sm || !sm.sel} title=${sm && sm.sel ? '이 노드가 내는 소리에서 원하는 부분만 쓰게 잘라요 (예: 끝 글자 빼기)' : '샘플 소리를 쓰는 노드에서만 쓸 수 있어요 (참조곡 원음은 안 돼요)'} onClick=${() => { Ctl.el.pause(); ui({ noteCut: true }); }}>${note.cs != null || note.ts != null || note.te != null ? '소리 구간 자르기 · 자른 상태' : '소리 구간 자르기'}</button>`; })()}
            <button class="btn primary" onClick=${saveNotesToLib}>${selIdx.length > 1 ? '고른 노드 ' + selIdx.length + '개를 노드 모음에 저장' : '이 노드를 노드 모음에 저장'}</button>
            <div class="two">${selIdx.length === 1 && html`<button class="btn" onClick=${duplicateNote}>한 칸 뒤에 복제</button>`}${selIdx.length === 1 && html`<button class="btn" onClick=${splitNode}>이 노드 앞에서 뭉치 쪼개기</button>`}</div>
            <button class="btn danger" onClick=${deleteNote}>${selIdx.length > 1 ? '고른 노드 지우기' : '이 노드 지우기'}</button>
            <div class="hint">Shift나 Ctrl을 누르고 노드를 누르면 여러 개를 함께 고를 수 있어요.</div>
          </div>`}
        ${node && !note && html`<div class="hint">뭉치 안의 노드를 하나씩 고치려면 이 라인을 '크게'로 바꾸고 노드를 누르세요. Shift나 Ctrl을 누르고 누르면 여러 개를 고를 수 있어요.</div>`}

        <div class="h-label">선택한 라인</div>
        ${!line && html`<div class="hint">라인 이름을 눌러 선택하세요.</div>`}
        ${line && html`<div class="card">
          <div class="kv"><span>길이 맞추기</span>
            <select class="in" style=${{ width: '150px', padding: '4px 6px', fontSize: '12px' }} aria-label="이 라인의 긴 음 채우는 방법" title="노드마다 따로 정하지 않으면 이 방법을 써요" value=${line.fit || 'stretch'} onChange=${(e) => upd((p) => { p.lines.find((x) => x.id === line.id).fit = e.target.value; })}>
              <option value="stretch">늘리기 (소리를 길게 늘임)</option>
              <option value="repeat">반복하기 (소리를 되풀이)</option>
              <option value="keep">원래 속도로 (음정만 멜로디에 맞춤)</option>
            </select></div>
          <button class="btn danger" disabled=${P.lines.length < 2} onClick=${() => deleteLine(line.id)}>이 라인 삭제</button>
        </div>`}
      </div>
    </div>
    ${U.dropChoice && html`<${DropChooser} P=${P} choice=${U.dropChoice} selLineId=${U.selLine} onPick=${commitFromSel} onRhythm=${(v) => ui({ rhythmPref: v, dropChoice: { ...U.dropChoice, rhythm: v } })} onRhythmPitch=${(v) => ui({ rhythmPitch: v, dropChoice: { ...U.dropChoice, pitch: v } })} onClose=${() => ui({ dropChoice: null })} />`}
    ${U.entryEdit && html`<${EntryEditor} P=${P} entryId=${U.entryEdit} grid=${grid} upd=${upd} ui=${ui} sampleOf=${sampleOf} specOf=${specOf} defaultSampleId=${(line && line.sampleId) || (P.samples[0] ? P.samples[0].id : null)} onClose=${() => { Ctl.el.pause(); ui({ entryEdit: null }); }} />`}
    ${U.helpOpen && html`<${HelpModal} onClose=${() => ui({ helpOpen: false })} />`}
    ${U.planOpen && html`<${PlanModal} plan=${plan} notice=${U.notice} onClose=${() => ui({ planOpen: false, notice: '' })} onChange=${setPlan} />`}
    ${U.exportOpen && html`<${ExportModal} busy=${U.rendering === 'export'} onClose=${() => ui({ exportOpen: false })} onMake=${exportPack} />`}
    ${U.noteCut && note && noteSample(note) && noteSample(note).sel && html`<${NoteCutModal} key=${node.id + ':' + U.selNote} note=${note} bpm=${P.bpm} getAudio=${noteAudio} onClose=${() => ui({ noteCut: false })} onApply=${applyNoteCut} onSplit=${splitNoteCut} />`}
    ${U.pitchEdit && sampleOf(U.pitchEdit) && html`<${PitchModal} sample=${sampleOf(U.pitchEdit)} bpm=${P.bpm} onClose=${() => ui({ pitchEdit: null })} onApply=${(as) => { const id = U.pitchEdit; upd((p) => { const s = p.samples.find((x) => x.id === id); if (as.length) s.bend = as; else delete s.bend; }); ui({ pitchEdit: null, notice: as.length ? '음높이 곡선을 적용했어요. 이 소리를 쓰는 모든 노드에 반영돼요' : '음높이 곡선을 원본으로 되돌렸어요' }); }} />`}
    ${U.cutting && sampleOf(U.cutting) && html`<${SampleModal} sample=${sampleOf(U.cutting)} onClose=${() => { Prev.pause(); ui({ cutting: null }); }} onApply=${(sel) => applyCut(sampleOf(U.cutting), sel)} onMakeNode=${(sel, marks) => applyCut(sampleOf(U.cutting), sel, true, marks)} onRelease=${(sg) => releaseUse(sampleOf(U.cutting), sg)} />`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
