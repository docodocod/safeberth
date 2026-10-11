import { useEffect, useMemo, useRef, useState } from 'react';
import { showDisclosure } from '../../../utils/disclosure';
import { FaPlay, FaPause, FaTimes, FaFastForward, FaUndo } from 'react-icons/fa';
import { fetchTwinOutlook, fetchAdjacentCargos, fetchAlternativeBerths } from '../../../api/backendAdapter';
import useOnsanApi from '../../../hooks/useOnsanApi';
import { loadGroupOutlooks, loadSimExtra, runSim, backtestDwell, simNorm } from '../../../utils/simInputs';
import { ONSAN_BERTHS_3D, ONSAN_WEATHER_GROUP } from '../../../utils/geoUtils';
import useSensorStore from '../../../stores/useSensorStore';
import useVesselThread from '../../../hooks/useVesselThread';
import HelpTip from '../../common/HelpTip';
import { stateAt, isAtBerth, isWaiting, PHASE_TEXT, SIM } from '../../../utils/berthSim';
import { simClock } from '../../../utils/simClock';

// ─────────────────────────────────────────────────────────────────────────────
// 앞으로 72시간 — 3D 관제 화면 안의 시뮬레이션
//
// [2026-09-27] 백엔드 /twin/outlook 이 지목한 선석의 "지금 판정"과 "앞으로 72시간"을 한 시각씩 판정해 준다
//   (기상청 단기예보 + 국립해양조사원 조석예보, 판정 규칙은 관제 화면과 같다). 예전엔 Omniverse 정보판이
//   그렸는데 장면이 달라 "같은 선석"으로 이어지지 않았고 GPU 발열로 시연 PC 가 꺼져, 이 화면 안으로 옮겼다.
// [2026-09-28] 입항 · 출항 예정(PORT-MIS 신고)을 시간축에 올렸다.
// [2026-09-30] 시뮬레이션으로 바꿨다(현우: "일정을 나란히 놓는 것이 아니라, 시간이 지남에 따라 배가 작업을 하고
//   떠나고 다른 배가 일정대로 들어와야 한다"). 계산은 utils/berthSim, 3D 의 배는 utils/simClock 시계를 읽는다.
//     자료   입항 · 출항 예정 시각과 사전배정 선석(PORT-MIS 신고), 지금 접안(항만공사 선박위치), 부두별 기상
//            예보 판정, 조석예보, 선석의 동시 접안 수, 부두별 재항 시간 실측(출항 예정이 없을 때)
//     모형   입출항 기동 시간 · 하역 준비와 마무리 시간(berthSim SIM) — 하역은 그 사이를 일정하게 진행한다고 본다.
//            입출항 경로는 만 안쪽 항로를 따라가는 정해진 경로다(실제 항적이 아니다).
//   선석 하나를 지목해 열면 그 선석의 판정(기상 · 흘수 여유 · 혼재)을 자세히 보고, 머리 단추로 열면 온산 전체를 본다.
//   어느 쪽이든 3D 에서는 항만 전체가 같이 움직인다.
//   [고도화] 입항 보류 선박의 대체 선석을 가정해 돌려 보기 · 조위 창 · 출항 추정 범위(재항 중앙값~90%) · 추정 검증
//   · 경고 벨의 '앞으로' 경고(같은 계산, utils/simInputs)에서 그 시각으로 바로 온다(focus.jumpAt)
//   두 보기는 같은 시뮬레이션의 두 배율이다 — 온산 전체에서 선석(일정 줄 이름 · 3D 선석 · 선석 현황 띠)을 누르면
//   그 시각 그대로 그 선석으로 내려가고, 선석에서 [온산 전체]를 누르면 그 시각 그대로 올라온다.
//   부적합 판정을 받은 배는 보류한다(berthSim) — 입항 예정 선박은 정박지에서 '입항 보류', 접안한 배는 '하역 보류'.
// ─────────────────────────────────────────────────────────────────────────────

// 판정 등급 색 — 어두운 3D 바탕용. 관제 화면 LEVEL_STYLE 과 뜻은 같고 밝기만 다르다.
export const LEVEL_COLOR = {
  적합: '#10b981', 주의: '#f59e0b', 부적합: '#ef4444', 확인요청: '#a78bfa', 판정불가: '#a78bfa',
};
const GATE_TEXT = {
  OPEN: '게이트 열림 가능', CAUTION: '게이트 주의 — 개시 전 확인', LOCKED: '게이트 닫힘 (하역 개시 거부)',
};
const H = 3600000;
const BASE_H_PER_S = 3;       // 1초에 3시간 — 72시간 약 24초
const SLOW_H_PER_S = 0.6;     // 배가 입출항 기동 중이면 천천히(기동 한 번이 2초쯤 보이게)
const FIRST_HOLD_MS = 900;    // "지금" 화면을 먼저 보여 주는 시간
const SPEEDS = [1, 2, 4];
const MOVING = new Set(['inbound', 'toAnchor', 'shifting', 'outbound']);
const ZONE_KR = { ANCHORAGE: '정박지 대기', UNDERWAY: '항해 중', STOPPED: '선석 밖 정지' };

const KST = 'Asia/Seoul';
function kstParts(iso) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t) => parts.find((x) => x.type === t)?.value ?? '';
  return { month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute'), weekday: g('weekday') };
}
const whenLabel = (iso) => { const k = kstParts(iso); return `${k.month}-${k.day}(${k.weekday}) ${k.hour}시`; };
const tickLabel = (iso) => { const k = kstParts(iso); return `${Number(k.day)}일 ${k.hour}시`; };
const hm = (iso) => { if (!iso) return '-'; const k = kstParts(iso); return `${k.month}-${k.day} ${k.hour}:${k.minute}`; };
const dayHm = (t) => { const k = kstParts(t); return `${Number(k.day)}일 ${k.hour}:${k.minute}`; };
const clockText = (t, t0) => { const k = kstParts(t); return `${k.month}-${k.day}(${k.weekday}) ${k.hour}:${k.minute} · +${((t - t0) / H).toFixed(1)}시간`; };
const signed = (v, digits = 2) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(digits)}`;
const num = (v, unit) => (v == null ? '-' : `${Number(v).toFixed(1)} ${unit}`);

const dim = { color: '#94a3b8', fontSize: 11, marginRight: 6 };

// 판정 순위 · 게이트 — 백엔드 twin.py 와 같은 표
const RANK = { 적합: 0, 주의: 1, 확인요청: 2, 판정불가: 2, 부적합: 3 };
const GATE_OF = { 적합: 'OPEN', 주의: 'CAUTION', 확인요청: 'CAUTION', 판정불가: 'CAUTION', 부적합: 'LOCKED' };
const worse = (a, b) => ((RANK[b] ?? -1) > (RANK[a] ?? -1) ? b : a);
// 필요 여유 — 판정 잡 · 대시보드와 같은 규칙(docs/28): max(1.0 m, 흘수×10%)
const ukcRequired = (dr) => Math.max(1.0, dr * 0.1);
const draughtLevel = (ukc, dr) => (ukc == null ? null : ukc <= 0 ? '부적합' : ukc < ukcRequired(dr) ? '주의' : '적합');
// PORT-MIS 표기(OTK1부두 · S-OIL2부두)를 3D 선석 키로 — 공백 · 대소문자만 무시한다
const norm = (s) => (s || '').replace(/\s+/g, '').toUpperCase();
const berthIdOf = (name) => Object.keys(ONSAN_BERTHS_3D).find((k) => norm(ONSAN_BERTHS_3D[k].name) === norm(name)) || null;
const shortBerthName = (id) => (ONSAN_BERTHS_3D[id]?.name || '').replace(/\s*부두$/, '').replace(/\s+/g, '');
const shortGroup = (g) => String(g || '').replace(/\(.*\)$/, '').replace(/부두$/, '');
const ms = (iso) => (iso ? new Date(iso).getTime() : null);
// 시간이 지나도 바뀌지 않는 사유 — 화물 혼재 · 선석 조건. 기상 · 조위는 시각마다 예보로 다시 본다.
const FIXED_CAUSE = /혼재|호환|격리|반응|취급 화물|선석 길이|DWT|최대 접안/;
// 사유 문장은 앞 구절만 — "이웃 화물과 혼재 충돌이 있어 지금 접안한 선석이 …" → "이웃 화물과 혼재 충돌"
const shortWhy = (t) => String(t || '').replace(/^.*?(으나|지만)\s*/, '').split(' — ')[0].split(/(?:이|가) 있어 /)[0]
  .replace(/(이|가) 있습니다$|입니다$|습니다$/, '').trim();
const fixedOf = (reasons) => { const why = (reasons || []).find((r) => FIXED_CAUSE.test(r)); return why ? shortWhy(why) : null; };
const causeWord = (why) => (/혼재|호환|격리|반응/.test(why || '') ? '혼재' : '선석 조건');
const iconBtn = {
  background: 'rgba(232,240,242,0.08)', color: '#e8f0f2', border: '1px solid rgba(232,240,242,0.25)',
  borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
  display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', fontFamily: 'inherit',
};
const EVENT_MARK = {
  arrive: { mark: '▼', word: '입항', color: '#60a5fa' },
  wait: { mark: '◆', word: '대기', color: '#fbbf24' },
  berth: { mark: '▼', word: '접안', color: '#60a5fa' },
  halt: { mark: '■', word: '하역 중단', color: '#f87171' },
  hold: { mark: '◆', word: '입항 보류', color: '#f87171' },
  tide: { mark: '◆', word: '조위 대기', color: '#38bdf8' },
  leave: { mark: '▲', word: '출항', color: '#c4b5fd' },
};

export default function OutlookTimeline({ focus, onClose, onBerth, onWide }) {
  const wide = Boolean(focus.wide) || !focus.berthId;
  const setOutlookPreview = useSensorStore((s) => s.setOutlookPreview);
  const setTwinViewShift = useSensorStore((s) => s.setTwinViewShift);
  // 선석을 지목했으면 그 선석에 지금 접안한 배(판정이 가장 나쁜 배)를 같이 본다 — 흘수 여유와 지금 판정이 붙는다.
  const { berths, loaded: threadLoaded } = useVesselThread();
  const occupant = useMemo(() => {
    if (wide || focus.call_sign) return null;
    const row = berths.find((b) => norm(b.wharf_name) === norm(focus.berth));
    const order = { 부적합: 0, 판정불가: 1, 주의: 2, 적합: 3 };
    return [...(row?.slots || [])].filter((x) => x.call_sign)
      .sort((x, y) => (order[x.status] ?? 5) - (order[y.status] ?? 5))[0] || null;
  }, [berths, focus.berth, focus.call_sign, wide]);
  const callSign = wide ? null : focus.call_sign || occupant?.call_sign || null;
  const vesselName = wide ? null : focus.vessel_name || occupant?.vessel_name || null;

  const t0 = useRef(Date.now()).current;         // 시뮬레이션의 "지금" — 패널을 연 때
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [extra, setExtra] = useState(null);      // { groups, arrivals, dwell } — 시뮬레이션 재료
  const [sim, setSim] = useState(null);          // { plans, events } — 한 번 세우면 보는 동안 바꾸지 않는다
  const [cursor, setCursor] = useState(-1);      // -1 = 지금(실측) · 0.. = 예보 시각
  const [sig, setSig] = useState('');            // 배들의 단계가 바뀔 때마다 달라지는 표식 — 3D 에 다시 알린다
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [everyLane, setEveryLane] = useState(false);   // 온산 전체를 볼 때 — 72시간 안에 바뀌지 않는 자리도 보이나
  const panelRef = useRef(null);
  const stripRef = useRef(null);
  const needleA = useRef(null);
  const needleB = useRef(null);
  const clockRef = useRef(null);
  const cursorRef = useRef(-1);
  const sigRef = useRef('');
  const speedRef = useRef(1);
  const autoPlayed = useRef(false);
  const keepT = useRef(null);   // 보기를 바꿀 때(온산 전체 ↔ 선석) 이어 갈 시각
  useEffect(() => { speedRef.current = speed; }, [speed]);

  // 지목 선석(또는 온산 전체)의 예보 판정
  useEffect(() => {
    if (!wide && !focus.call_sign && !threadLoaded) return undefined;   // 선석의 지금 배를 알고 나서 한 번 읽는다
    let alive = true;
    setData(null); setError(null); setPlaying(false);
    if (simClock.active) {
      keepT.current = simClock.t;   // 보던 시각을 그대로 — 새 판정을 읽은 뒤 그 시각에 다시 선다
    } else {
      keepT.current = null;
      simClock.t = t0;
      cursorRef.current = -1; setCursor(-1); autoPlayed.current = false;
    }
    // 경고 벨의 '앞으로' 경고에서 왔으면 그 시각에 선다
    if (focus.jumpAt && focus.jumpAt > t0 && focus.jumpAt < t0 + 72 * H) {
      keepT.current = focus.jumpAt; autoPlayed.current = true;
    }
    const req = wide
      ? loadGroupOutlooks().then((m) => { const d = [...m.values()][0]; if (!d) throw new Error('예보 없음'); return d; })
      : fetchTwinOutlook({ berth: focus.berth, call_sign: callSign });
    req.then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [focus.berth, callSign, threadLoaded, wide, focus.jumpAt]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 시뮬레이션 재료 — 판정 흐름과 따로 읽는다(실패해도 기상 흐름은 그대로 보인다). 경고 벨의 '앞으로' 경고와 같은 재료
  useEffect(() => {
    let alive = true;
    loadSimExtra().then((v) => { if (alive) setExtra(v); });
    return () => { alive = false; };
  }, []);
  // 추정 검증 — 출항 예정 신고가 없을 때 쓰는 재항 중앙값 추정이 최근 온산 입출항에서 얼마나 맞았나
  const bt = useMemo(() => (extra ? backtestDwell(extra) : null), [extra]);

  // 입항 예정 선박의 흘수 · 수심 — 접안한 시각의 조석예보로 흘수 여유를 다시 계산할 때 쓴다
  const arrInfo = useMemo(() => new Map((extra?.arrivals || []).map((r) => [norm(r.call_sign), {
    draught: Number(r.draught_m) > 0 ? Number(r.draught_m) : null,
    draught_basis: r.draught_basis || null,
    depth: Number(r.depth_m) > 0 ? Number(r.depth_m) : null,
  }])), [extra]);

  // 가정 — 입항 보류 선박을 대체 선석으로 돌려 보기. { 호출부호: { berthId, level, depth, wharf } }
  const [overrides, setOverrides] = useState({});
  const [alt, setAlt] = useState(null);          // { callsgn, name, state, rows }
  const { assessSafetyVerdict } = useOnsanApi();
  useEffect(() => {
    if (sim || !extra || !threadLoaded) return;
    setSim(runSim({ t0, berths, extra, overrides }));
  }, [sim, extra, threadLoaded, berths, t0, overrides]);

  const plans = useMemo(() => sim?.plans || [], [sim]);
  const focusPlan = useMemo(
    () => (callSign ? plans.find((p) => p.kind === 'now' && norm(p.callsgn) === norm(callSign)) || null : null),
    [plans, callSign],
  );

  const rawPts = useMemo(() => data?.forecast ?? [], [data]);
  const focusDraught = Number(data?.draught?.vessel_draught_m);
  // 지금 판정(판정 이력)에서 시간이 지나도 그대로인 사유 — 그 배가 이 선석에 있는 동안 모든 시각에 얹는다
  const a = wide ? null : data?.assessment || null;
  const fixed = useMemo(() => {
    if (!a?.level || a.level === '적합' || !callSign) return null;
    if (norm(a.call_sign) !== norm(callSign)) return null;         // 다른(떠난) 배의 판정은 얹지 않는다
    if (a.stage && a.stage !== '하역중') return null;               // 접안해 있는 배의 판정만
    const why = (a.reasons || []).find((r) => FIXED_CAUSE.test(r));
    if (!why) return null;
    return { level: a.level, why: shortWhy(why), action: a.action || null, recipient: a.recipient || null };
  }, [a, callSign]);

  // 시각마다의 판정
  //   선석 지목: 백엔드 기상 판정 + (지목 선박이 아직 있으면) 흘수 여유 · 혼재 + 그 시각 접안해 있는 입항 예정 선박
  //   온산 전체: 부두군 6곳의 기상 판정 가운데 가장 나쁜 것(배의 판정은 아래 일정 막대 색으로 본다)
  const pts = useMemo(() => {
    if (wide) {
      const gs = [...(extra?.groups || [])];
      return rawPts.map((p, i) => {
        let level = '적합'; let status = '정상';
        const bad = [];
        gs.forEach(([g, o]) => {
          const q = o.forecast?.[i];
          const wl = q?.weather_level || '적합';
          if (wl !== '적합') bad.push(`${shortGroup(g)} ${q.status}`);
          if ((RANK[wl] ?? 0) > (RANK[level] ?? 0)) { level = wl; status = q.status; }
        });
        return {
          ...p, level, weather_level: level, status, gate: GATE_OF[level], bad, ghosts: [], fixedHere: null,
          ukc_m: null, draught_verdict: null, headline: level === '적합' ? '정상' : bad.join(' · '),
        };
      });
    }
    return rawPts.map((p) => {
      const t = ms(p.at_utc);
      let level = p.weather_level || p.level || '적합';
      const notes = [];
      const stillHere = !(focusPlan?.leaveAt && focusPlan.leaveAt <= t);
      if (stillHere && p.ukc_m != null && focusDraught > 0) level = worse(level, draughtLevel(p.ukc_m, focusDraught));
      const ghosts = plans
        .filter((pl) => pl.kind === 'plan' && pl.berthId === focus.berthId && pl.berthAt != null && pl.berthAt <= t && (!pl.leaveAt || t < pl.leaveAt))
        .map((pl) => {
          const info = arrInfo.get(norm(pl.callsgn)) || {};
          let gl = null; let ukc = null;
          if (!info.draught) gl = '판정불가';
          else if (info.depth && p.tide_m != null) { ukc = info.depth + p.tide_m - info.draught; gl = draughtLevel(ukc, info.draught); }
          const planBad = pl.level && pl.level !== '적합' ? pl.level : null;   // 입항 전 판정(혼재 · 선석 조건)
          return {
            berthId: pl.berthId, call_sign: pl.callsgn, vessel_name: pl.name, eta: pl.eta, draught: info.draught || null,
            draught_basis: info.draught_basis || null, ukc, draughtLv: gl, planBad, fixedWhy: pl.fixedWhy,
            level: planBad ? worse(gl || '적합', planBad) : gl,
          };
        });
      // 이 선석으로 배정됐지만 부적합이라 정박지에서 보류된 배 — 선석은 비어 있어도 이 배정은 부적합이다
      const heldOut = plans.filter((pl) => pl.hold === 'entry' && pl.berthId === focus.berthId && pl.eta <= t);
      heldOut.forEach((pl) => {
        level = worse(level, pl.level);
        notes.push(`${pl.name} 입항 보류${pl.fixedWhy ? `(${causeWord(pl.fixedWhy)})` : ''}`);
      });
      ghosts.filter((g) => g.level).forEach((g) => {
        level = worse(level, g.level);
        if (g.planBad) notes.push(`${g.vessel_name} ${g.planBad}${g.fixedWhy ? `(${causeWord(g.fixedWhy)})` : ''}`);
        if (g.draughtLv === '판정불가') notes.push(`${g.vessel_name} 흘수 미신고`);
        else if (g.draughtLv && g.draughtLv !== '적합') notes.push(`${g.vessel_name} 흘수 여유 ${signed(g.ukc)} m`);
      });
      const wx = p.weather_level && p.weather_level !== '적합' ? p.status : null;
      const fixedHere = fixed && stillHere ? fixed : null;
      if (fixedHere) level = worse(level, fixedHere.level);
      const headline = [wx, fixedHere ? fixedHere.why : null, ...notes].filter(Boolean).join(' · ')
        || (level === '적합' ? '정상' : p.headline || p.status);
      return { ...p, level, gate: GATE_OF[level] || p.gate, headline, ghosts, fixedHere, heldOut };
    });
  }, [rawPts, plans, wide, extra, focus.berthId, focusDraught, focusPlan, fixed, arrInfo]);
  const n = pts.length;
  // 첫 변화 = 지금보다 나빠지는 첫 시각(시간이 지나도 그대로인 사유만으로 처음부터 주의면 그건 '변화'가 아니다)
  const baseLevel = fixed ? fixed.level : '적합';
  const firstIdx = useMemo(() => {
    const i = pts.findIndex((p) => p.level && (RANK[p.level] ?? 0) > (RANK[baseLevel] ?? 0));
    return i >= 0 ? i : null;
  }, [pts, baseLevel]);

  const tStart = n ? ms(pts[0].at_utc) : t0;
  const tEnd = n ? ms(pts[n - 1].at_utc) + H : t0 + 72 * H;
  const xPct = (t) => Math.min(100, Math.max(0, ((t - tStart) / (tEnd - tStart)) * 100));

  // ── 시계 ─────────────────────────────────────────────────────────────────
  // 시각은 매 프레임 흐르지만 화면(React)은 한 시각이 넘어가거나 배의 단계가 바뀔 때만 다시 그린다.
  // 바늘과 시계 글자는 DOM 을 바로 고친다. 3D 의 배는 같은 시계(simClock)를 매 프레임 읽어 자리를 잡는다.
  const applyTime = (t) => {
    const tt = Math.min(tEnd - 1, Math.max(t0, t));
    simClock.t = tt; simClock.active = true;
    const i = n ? Math.min(n - 1, Math.max(0, Math.floor((tt - tStart) / H))) : 0;
    if (i !== cursorRef.current) { cursorRef.current = i; setCursor(i); }
    const s = plans.map((p) => stateAt(p, tt).phase).join('|');
    if (s !== sigRef.current) { sigRef.current = s; setSig(s); }
    const left = `${xPct(tt)}%`;
    if (needleA.current) needleA.current.style.left = left;
    if (needleB.current) needleB.current.style.left = left;
    if (clockRef.current) clockRef.current.textContent = clockText(tt, t0);
  };
  const goLive = () => {
    simClock.active = false; simClock.t = t0;
    cursorRef.current = -1; sigRef.current = ''; setCursor(-1); setSig(''); setPlaying(false);
  };
  const jumpTo = (t, thenPlay = false) => { if (!n) return; applyTime(t); setPlaying(thenPlay); };

  useEffect(() => {
    if (!playing || !n) return undefined;
    let raf = 0;
    let last = performance.now();
    let hold = cursorRef.current === -1 ? FIRST_HOLD_MS : 0;
    const tick = (nowMs) => {
      const dt = Math.min(100, nowMs - last);
      last = nowMs;
      if (hold > 0) { hold -= dt; raf = requestAnimationFrame(tick); return; }
      const from = cursorRef.current === -1 ? t0 : simClock.t;
      const moving = plans.some((p) => MOVING.has(stateAt(p, from).phase));
      const next = from + (dt / 1000) * (moving ? SLOW_H_PER_S : BASE_H_PER_S) * speedRef.current * H;
      applyTime(next);
      if (next >= tEnd - 1) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, n, plans, tEnd]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 재료가 다 모이면 한 번 자동으로 돌린다. 보기를 바꿔 온 것이면 보던 시각에 멈춰 선다
  useEffect(() => {
    if (!data || !sim || !n) return;
    if (keepT.current != null) {
      const t = keepT.current;
      keepT.current = null;
      autoPlayed.current = true;
      cursorRef.current = -2;   // 같은 시각이어도 화면을 다시 맞춘다
      applyTime(t);
      return;
    }
    if (autoPlayed.current) return;
    autoPlayed.current = true;
    setPlaying(true);
  }, [data, sim, n]);   // eslint-disable-line react-hooks/exhaustive-deps

  const live = cursor === -1;
  const tNow = live ? t0 : simClock.t;
  const cur = wide ? null : data?.current || null;
  const point = cursor >= 0 ? pts[cursor] : null;
  // 그 시각 항만에 있는 배
  const present = useMemo(
    () => plans.map((p) => ({ p, st: stateAt(p, tNow) })).filter((x) => x.st.phase !== 'absent' && x.st.phase !== 'gone'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plans, cursor, sig],
  );
  const phaseLabel = (x) => {
    const pct = x.st.progress != null && ['work', 'stopped'].includes(x.st.phase) ? ` ${Math.round(x.st.progress * 100)}%` : '';
    return `${PHASE_TEXT[x.st.phase] || ''}${pct}`;
  };

  // 3D 장면에 알린다 — 지목 선석은 세부 판정으로, 나머지 선석은 그 시각의 기상 + 접안한 배의 판정으로 색을 바꾼다.
  //   장면 글씨는 한 낱말만(하역중단 · 주의 · 혼재 …) — 긴 사유는 아래 패널에 있다.
  const sceneWord = (src) => {
    if (!src) return null;
    if (src.weather_level && src.weather_level !== '적합') return src.status;
    if (src.level && src.level !== '적합') return src.fixedHere ? `${src.level} · 혼재` : src.level;
    return '정상';
  };
  const berthLevelsAt = (t, i) => {
    const out = {};
    Object.keys(ONSAN_BERTHS_3D).forEach((id) => {
      if (id === focus.berthId) return;
      const q = extra?.groups?.get(ONSAN_WEATHER_GROUP[id])?.forecast?.[i];
      let level = q?.weather_level || '적합';
      let word = level !== '적합' ? q.status : null;
      plans.forEach((pl) => {
        if (pl.berthId !== id || !pl.level || pl.level === '적합') return;
        const ph = stateAt(pl, t).phase;
        if (!isAtBerth(ph) && ph !== 'heldOut') return;
        if ((RANK[pl.level] ?? 0) > (RANK[level] ?? 0)) {
          level = pl.level;
          // 등급은 색이 말한다 — 글은 한 낱말
          word = ph === 'heldOut' ? '입항 보류' : ph === 'held' ? '하역 보류' : pl.fixedWhy ? causeWord(pl.fixedWhy) : pl.level;
        }
      });
      out[id] = { level, headline: word || '정상', status: q?.status || null, wide: true };
    });
    return out;
  };
  useEffect(() => {
    if (!data) { setOutlookPreview(null); return; }
    const src = point || cur || {};
    const nowLevel = fixed ? worse(cur?.level || '적합', fixed.level) : cur?.level || null;
    const nowWord = fixed ? `${nowLevel} · 혼재` : (cur?.headline || cur?.status || null);
    setOutlookPreview({
      berthId: wide ? null : focus.berthId,
      level: point ? src.level : nowLevel,
      status: src.status || null,
      headline: point ? sceneWord(point) : nowWord, gate: src.gate || null,
      at_utc: point ? point.at_utc : null, offsetH: point ? Math.max(0, Math.round((tNow - t0) / H)) : 0,
      wave_m: point ? point.wave_m : null,
      simOn: !live && plans.length > 0, plans, at_ms: tNow,
      berthLevels: !live && sim ? berthLevelsAt(tNow, cursor) : null,
    });
  }, [data, cursor, sig, sim, cur, focus.berthId, wide, setOutlookPreview, fixed, playing]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { simClock.active = false; setOutlookPreview(null); }, [setOutlookPreview]);

  // 패널이 3D 아래쪽을 덮는 만큼 장면을 위로 민다(Scene ViewShift) — 배가 움직이는 자리가 패널 뒤로 가지 않게
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    // 위쪽은 경고 띠와 선석 현황 띠(84px)가 덮는다 — 두 띠 사이 보이는 자리의 가운데로 맞춘다
    const ro = new ResizeObserver(() => setTwinViewShift(Math.round(Math.max(0, el.offsetHeight + 16 - 84) / 2)));
    ro.observe(el);
    return () => { ro.disconnect(); setTwinViewShift(0); };
  }, [setTwinViewShift]);

  // ── 일정 줄 ──────────────────────────────────────────────────────────────
  // 줄 하나 = 선석의 자리 하나. 막대 = 그 자리에 머무는 배(실선 = 지금 접안, 점선 = 입항 예정).
  const showAll = wide;
  const lanesAll = useMemo(() => {
    const rows = [];
    Object.keys(ONSAN_BERTHS_3D).forEach((id) => {
      if (!showAll && id !== focus.berthId) return;
      const mine = plans.filter((p) => p.berthId === id);
      if (!mine.length) return;
      const laneOf = (p) => p.lane ?? (p.slot || 0);
      const slots = [...new Set(mine.map(laneOf))].sort((x, y) => x - y);
      slots.forEach((s) => {
        const items = mine.filter((p) => laneOf(p) === s);
        // 72시간 안에 들어오거나 나가는 배가 있는 자리인가
        const changes = items.some((p) => p.kind === 'plan' || p.hold || (p.leaveAt != null && p.leaveAt < tEnd));
        rows.push({ key: `${id}-${s}`, id, items, changes });
      });
    });
    return rows;
  }, [plans, showAll, focus.berthId, tEnd]);
  // 온산 전체는 바뀌는 자리만 먼저 보인다 — 11개 선석을 다 펴면 패널이 3D 를 절반 덮는다
  const stillCount = lanesAll.filter((r) => !r.changes).length;
  const lanes = useMemo(() => {
    const rows = showAll && !everyLane ? lanesAll.filter((r) => r.changes || r.id === focus.berthId) : lanesAll;
    return rows.map((r, i) => ({ ...r, first: i === 0 || rows[i - 1].id !== r.id }));
  }, [lanesAll, showAll, everyLane, focus.berthId]);
  const stopSpans = useMemo(() => {   // 기상으로 하역이 막히는 구간 — 일정 막대 뒤에 깐다
    const out = [];
    pts.forEach((pt, i) => {
      if (!(pt.weather_level && pt.weather_level !== '적합')) return;
      const last = out[out.length - 1];
      if (last && last.to === i) last.to = i + 1; else out.push({ from: i, to: i + 1 });
    });
    return out;
  }, [pts]);
  const events = useMemo(
    () => (sim?.events || []).filter((e) => e.at >= t0 && e.at < tEnd && (showAll || e.plan.berthId === focus.berthId)),
    [sim, showAll, focus.berthId, t0, tEnd],
  );
  const resim = (next) => {       // 보던 시각을 그대로 두고 다시 계산
    keepT.current = simClock.active ? simClock.t : null;
    if (keepT.current != null) autoPlayed.current = true;
    setOverrides(next); setSim(null);
  };
  const RISK_TO_LEVEL = { 안전: '적합', 주의: '주의', 위험: '주의', 배정불가: '부적합' };
  const openAlts = async (pl) => {
    const r = (extra?.arrivals || []).find((x) => simNorm(x.call_sign) === simNorm(pl.callsgn));
    if (!r) return;
    const cargos = (r.cargos || []).filter((c) => c.chem_id);
    const main = cargos[0] || { chem_id: r.chem_id, cas_no: r.cas_no, name: r.cargo_name };
    setAlt({ callsgn: pl.callsgn, name: pl.name, state: 'loading' });
    try {
      const res = await fetchAlternativeBerths({
        draught_m: Number(r.draught_m) || null, chem_id: main.chem_id, cas_no: main.cas_no, name_hint: r.vessel_name,
        hours: 24, extra_cargos: cargos.slice(1), exclude_wharf_name: r.wharf_name || r.facility_name,
        start: new Date(Math.max(Date.now(), pl.eta || Date.now())),
      });
      const cands = [...new Map((res?.candidates || []).map((c) => [c.wharf_name, c])).values()].filter((c) => berthIdOf(c.wharf_name)).slice(0, 4);
      const rows = await Promise.all(cands.map(async (c) => {
        let risk = null;
        try {
          const adjacent = await fetchAdjacentCargos({ wharf_name: c.wharf_name, call_sign: r.call_sign });
          const v = await assessSafetyVerdict({
            cargo_name: main.name, chem_id: main.chem_id, cas_no: main.cas_no, berth_name: c.wharf_name,
            adjacent_operations: adjacent || [], extra_cargos: cargos.slice(1).map((x) => ({ chem_id: x.chem_id, cas_no: x.cas_no })), call_sign: r.call_sign,
          });
          risk = v?.risk_level || null;
        } catch { /* 등급을 못 내면 판정불가로 둔다 */ }
        const level = RISK_TO_LEVEL[risk] || '판정불가';
        const bid = berthIdOf(c.wharf_name);
        const ov = { berthId: bid, level, depth: Number(c.depth_m) || null, wharf: c.wharf_name };
        const trial = runSim({ t0, berths, extra, overrides: { ...overrides, [simNorm(pl.callsgn)]: ov } });
        const tp = trial.plans.find((x) => simNorm(x.callsgn) === simNorm(pl.callsgn));
        return { ...ov, risk, berthAt: tp?.berthAt ?? null, waitH: tp?.waitH ?? 0, hold: tp?.hold || null };
      }));
      setAlt({ callsgn: pl.callsgn, name: pl.name, state: rows.length ? 'ready' : 'empty', rows });
    } catch (e) {
      setAlt({ callsgn: pl.callsgn, name: pl.name, state: 'error', error: e.message });
    }
  };
  const applyAlt = (pl, row) => { resim({ ...overrides, [simNorm(pl.callsgn)]: { ...row, from: pl.berthId, name: pl.name } }); setAlt(null); };
  const heldPlans = plans.filter((x) => x.hold === 'entry' && (showAll || x.berthId === focus.berthId));
  const ovList = Object.entries(overrides);

  const eventStart = (e) => (e.type === 'arrive' ? e.plan.appearAt
    : e.type === 'berth' ? Math.max(t0, e.at - SIM.SHIFT_H * H) : e.at);

  // 한 형식의 선박 일정 막대(2026-09-30, 현우 "배마다 구분은 되는데 통일된 선박 일정 느낌이 덜하다").
  //   모든 배가 같은 막대(회청색) — 안의 구간 색이 같은 뜻: 준비 · 마무리(밝은 회청) · 하역 중(청록) · 기상 중단(빨강)
  //   막대 밖 빗금: 정박지 · 조위 대기(노랑) · 입항 보류(빨강), 출항 추정 범위(회색). 판정은 이름 앞 점 색.
  //   지금 접안한 배는 왼쪽이 잘린 채(이미 와 있음), 입항 예정 선박은 둥근 머리(그 시각에 들어옴)
  const GANTT = { base: '#22364a', edge: 'rgba(148,163,184,0.45)', prep: '#3d5873', work: '#0f9f95', halt: '#ef4444' };
  const hatch = (rgb, a = 0.75) => `repeating-linear-gradient(135deg, rgba(${rgb},${a}) 0 3px, rgba(${rgb},0.12) 3px 7px)`;
  const btTip = bt ? ` (최근 온산 입출항 ${bt.n}건 검증: 추정 오차 중앙값 ${Math.round(bt.medianErrH)}시간, 실제 출항이 범위 안 ${bt.inRangePct}%)` : '';
  const bar = (p, top, h) => {
    const out = [];
    const dot = LEVEL_COLOR[p.level] || '#94a3b8';
    const label = (txt, extraTxt) => (
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 5px', maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textShadow: '0 0 3px rgba(0,0,0,0.95)' }}>
        <i style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0, boxShadow: '0 0 0 1px rgba(0,0,0,0.4)' }} />
        <b style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{txt}</b>
        {extraTxt && <span style={{ color: '#fde68a', fontWeight: 700 }}>{extraTxt}</span>}
      </span>
    );
    const moved = overrides[simNorm(p.callsgn)];
    if (p.waitFrom != null) {
      const wl = xPct(p.waitFrom); const wr = xPct(p.berthAt ?? tEnd);
      const held = p.hold === 'entry';
      const word = held ? '입항 보류' : p.waitReason === 'tide' ? '조위 대기' : '대기';
      const tipW = held
        ? `${p.name} · 입항 보류(부적합${p.fixedWhy ? ` · ${causeWord(p.fixedWhy)}` : ''}) · 입항 예정 ${hm(p.eta)} · 정박지 대기 — 대체 선석 검토`
        : `${p.name} · ${p.waitReason === 'tide' ? `저조로 흘수 여유 부족 — 조위 대기` : '정박지 대기'} ${hm(p.waitFrom)}${p.berthAt ? ` → 접안 ${hm(p.berthAt)}` : ' · 72시간 안에 접안 못 함'}`;
      out.push(
        <button
          key={`${p.key}-w`} type="button" title={tipW} onClick={() => jumpTo(p.appearAt, true)}
          style={{
            // 앞 배 뒤에서 기다리면(나중에 접안) 줄 아래 얇은 띠 — 같은 줄의 앞 배 막대를 덮지 않게. 끝내 못 대면 막대 높이로
            position: 'absolute', left: `${wl}%`, width: `${Math.max(wr - wl, 0.6)}%`,
            top: p.berthAt == null ? top : top + h - 5, height: p.berthAt == null ? h : 5, padding: 0, zIndex: 1,
            borderRadius: p.berthAt == null ? '6px 2px 2px 6px' : 2, border: `1px solid rgba(${held ? '248,113,113' : '251,191,36'},0.6)`, cursor: 'pointer', fontFamily: 'inherit',
            background: hatch(held ? '248,113,113' : '251,191,36', 0.55), color: '#fff', fontSize: 10.5, lineHeight: `${h - 2}px`, textAlign: 'left', overflow: 'hidden',
          }}
        >
          {p.berthAt == null ? label(p.name, word) : null}
        </button>,
      );
    }
    const from = p.kind === 'now' ? tStart : p.berthAt;
    if (from == null) return out;
    const to = p.leaveAt ?? tEnd;
    const span = Math.max(1, to - from);
    const rel = (t) => `${Math.min(100, Math.max(0, ((t - from) / span) * 100))}%`;
    const relW = (a, b) => `${Math.max(0, ((Math.min(b, to) - Math.max(a, from)) / span) * 100)}%`;
    const left = xPct(from); const right = xPct(to);
    const haltH = Math.round(p.halts.reduce((sum, hh) => sum + (hh.to - hh.from), 0) / H);
    const basis = p.endBasis === '신고' ? '출항 예정(신고)' : p.endBasis === '추정' ? '출항 추정(이 부두 재항 중앙값)' : p.endBasis === '가정' ? '출항 가정' : null;
    const tip = [
      `${p.name} · ${shortBerthName(p.berthId)}${moved ? ` (가정 — 원래 ${shortBerthName(moved.from)})` : ''}`,
      p.kind === 'now' ? '접안 중' : `입항 예정 ${hm(p.eta)}${p.waitH ? ` · 대기 ${p.waitH}시간` : ''}`,
      p.hold === 'work' ? '하역 보류(부적합) — 게이트 잠김'
        : p.leaveAt ? `${basis} ${hm(p.leaveAt)}${haltH ? ` · 기상 중단 ${haltH}시간` : ''}${p.delayH ? ` · 예정보다 ${p.delayH}시간 늦음` : ''}${p.estHi ? ` · 범위 ~${hm(p.estHi)}${btTip}` : ''}`
          : '출항 예정 미신고',
      p.level || null, p.cargo || null,
    ].filter(Boolean).join(' · ');
    const open = p.leaveAt == null && p.hold !== 'work';   // 출항을 모름 — 오른쪽이 흐려진다
    out.push(
      <button
        key={p.key} type="button" title={tip}
        onClick={() => jumpTo(p.kind === 'now' ? (p.leaveAt ?? t0) : p.appearAt, p.kind !== 'now' || Boolean(p.leaveAt))}
        style={{
          position: 'absolute', left: `${left}%`, width: `${Math.max(right - left, 0.8)}%`, top, height: h, padding: 0,
          borderRadius: p.kind === 'now' ? '0 5px 5px 0' : 5, border: `1px solid ${moved ? '#fbbf24' : GANTT.edge}`,
          borderLeftWidth: p.kind === 'now' ? 0 : 1, background: GANTT.base, overflow: 'hidden', cursor: 'pointer', fontFamily: 'inherit',
          color: '#fff', fontSize: 10.5, lineHeight: `${h - 2}px`, textAlign: 'left',
          ...(open ? { WebkitMaskImage: 'linear-gradient(90deg, #000 70%, transparent)', maskImage: 'linear-gradient(90deg, #000 70%, transparent)' } : {}),
        }}
      >
        {p.workStart != null && p.workStart > from && (
          <span style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: relW(from, p.workStart), background: GANTT.prep }} />
        )}
        {p.workStart != null && p.workEnd != null && (
          <span style={{ position: 'absolute', top: 0, bottom: 0, left: rel(p.workStart), width: relW(p.workStart, p.workEnd), background: GANTT.work, opacity: 0.9 }} />
        )}
        {p.workEnd != null && p.leaveAt != null && (
          <span style={{ position: 'absolute', top: 0, bottom: 0, left: rel(p.workEnd), width: relW(p.workEnd, p.leaveAt), background: GANTT.prep }} />
        )}
        {p.halts.map((hh) => (
          <span key={hh.from} style={{ position: 'absolute', top: 0, bottom: 0, left: rel(hh.from), width: relW(hh.from, hh.to), background: GANTT.halt }} />
        ))}
        {p.hold === 'work' && <span style={{ position: 'absolute', inset: 0, background: hatch('248,113,113', 0.6) }} />}
        {label(p.name, p.hold === 'work' ? '하역 보류' : moved ? '가정' : null)}
      </button>,
    );
    // 출항 추정 범위 — 재항 중앙값 뒤 90% 까지
    if (p.estHi && p.leaveAt) {
      const el = xPct(p.leaveAt); const er = xPct(p.estHi);
      out.push(
        <span
          key={`${p.key}-e`} title={`${p.name} · 출항 추정 범위 ${hm(p.leaveAt)} ~ ${hm(p.estHi)}${btTip}`}
          style={{ position: 'absolute', left: `${el}%`, width: `${Math.max(er - el, 0.4)}%`, top: top + 3, height: h - 6, borderRadius: '0 3px 3px 0', background: hatch('148,163,184', 0.5) }}
        />,
      );
    }
    return out;
  };

  // ── 글 ───────────────────────────────────────────────────────────────────
  const th = data?.thresholds || {};
  const rule = [
    th.stop_wind_ms != null ? `풍속 중단 ${th.stop_wind_ms} m/s` : '풍속 기준 없음',
    th.stop_wave_m != null ? `파고 중단 ${th.stop_wave_m} m` : '파고 기준 없음',
  ].join(' · ');
  const tf = data?.tide_forecast;
  const hasTide = Boolean(tf) && !tf.error;
  const bias = hasTide ? Number(tf.bias_cm ?? 0) : 0;
  const d = (wide ? null : data?.draught) || {};
  const depth = Number(d.chart_depth_m);
  const draught = Number(d.vessel_draught_m);
  const draughtOn = depth > 0 && draught > 0;
  const zoneKr = ZONE_KR[data?.presence?.presence_zone];
  const noDraught = !callSign
    ? '접안 선박 없음'
    : zoneKr ? `이 배는 지금 선석에 없음(${zoneKr})` : '이 배의 흘수 실측 없음';

  const tideLine = (tideM, ukc, isNow) => {
    if (tideM == null) return '조위 예측 없음 — 흘수 여유는 지금 실측만';
    const src = isNow ? '실측' : `조석예보 + 보정 ${bias >= 0 ? '+' : ''}${Math.round(bias)} cm`;
    if (!draughtOn) return `조위 ${signed(tideM)} m (${src}) · 흘수 — ${noDraught}`;
    return `조위 ${signed(tideM)} m (${src}) · 흘수 여유 ${ukc == null ? '-' : signed(ukc)} m (필요 ${ukcRequired(draught).toFixed(2)})`;
  };
  const actionFor = (p) => {
    if (p.level === '적합') return '없음 — 이 시각 하역 가능';
    const steps = [];
    if (p.fixedHere) steps.push(`${p.fixedHere.action || '하역 개시 전 재확인'} — ${p.fixedHere.why}`);
    if (p.weather_level && p.weather_level !== '적합') steps.push(`${whenLabel(p.at_utc)}부터 ${p.status} 예보 — 그 전에 하역 종료 또는 개시 연기`);
    if (p.draught_verdict && p.draught_verdict !== 'OK') steps.push('조위 오르는 시각으로 이동 또는 수심 깊은 선석');
    if ((p.heldOut || []).length) steps.push(`${p.heldOut.map((pl) => pl.name).join(' · ')} 대체 선석 검토(${causeWord(p.heldOut[0].fixedWhy)}) — 그때까지 입항 보류`);
    const bad = (p.ghosts || []).filter((g) => g.level && g.level !== '적합');
    const names = (list) => list.map((g) => g.vessel_name).join(' · ');
    const swap = bad.filter((g) => g.planBad);
    if (swap.length) steps.push(`${names(swap)} 접안 전 대체 선석 검토(${causeWord(swap[0].fixedWhy)})`);
    const noDr = bad.filter((g) => !g.planBad && g.draughtLv === '판정불가');
    if (noDr.length) steps.push(`${names(noDr)} 흘수 신고 확인 후 입항 전 재판정`);
    const lowDr = bad.filter((g) => !g.planBad && g.draughtLv !== '판정불가');
    if (lowDr.length) steps.push(`${names(lowDr)} 입항 시각을 조위 오르는 때로 조정 또는 대체 선석 검토`);
    return steps.join(' · ') || '하역 개시 전 재확인';
  };

  // 지금(실측) 줄
  const tideNow = d.tide_level_m ?? cur?.tide_m ?? null;
  const ukcNow = draughtOn && tideNow != null ? depth + Number(tideNow) - draught : null;

  // 판정 이력 · 게이트 — 판정 화면 · 게이트와 잇는 두 줄
  const g = wide ? null : data?.gate || null;
  const verdictLine = a?.level
    ? `${a.for === 'vessel' ? (a.vessel_name || a.call_sign || '') : `이 선석 최근(${a.vessel_name || a.call_sign || ''})`} · ${a.stage || ''} ${a.level} (${hm(a.assessed_at_utc)})${a.acknowledged_by ? ' · 확인됨' : ''}`
    : '아직 없음 — 선박 판정 화면에서 [판정 요청]';
  const gateLine = g?.state
    ? `${g.label || g.gate_id} ${g.state === 'LOCKED' ? '잠김' : '해제'}${g.state === 'LOCKED' && g.reason_ko ? ` — ${String(g.reason_ko).slice(0, 40)}` : ''} · ${g.offline ? '장치 미연결' : showDisclosure() ? (g.simulate ? '모의 장치' : '실물') : '장치 연결'}${g.demo && showDisclosure() ? ' · 시연 입력 중' : ''}`
    : null;

  // 요약 — 72시간 동안 무슨 일이 있나
  const first = firstIdx != null ? pts[firstIdx] : null;
  const nowBlocked = Boolean(cur?.level) && cur.level !== '적합';
  const count = (type) => events.filter((e) => e.type === type).length;
  const flowWords = [
    count('arrive') + count('wait') + count('tide') ? `입항 ${count('arrive') + count('wait') + count('tide')}척` : null,
    plans.filter((p) => p.hold === 'entry' && (showAll || p.berthId === focus.berthId)).length
      ? `입항 보류 ${plans.filter((p) => p.hold === 'entry' && (showAll || p.berthId === focus.berthId)).length}척` : null,
    count('leave') ? `출항 ${count('leave')}척` : null,
    count('wait') ? `정박지 대기 ${count('wait')}척` : null,
    count('tide') ? `조위 대기 ${count('tide')}척` : null,
    count('halt') ? `하역 중단 ${count('halt')}회` : null,
  ].filter(Boolean);
  let summary = [
    first ? `첫 변화 ${whenLabel(first.at_utc)} — ${first.headline || first.status}` : '기상 · 조위로 더 나빠지는 시각 없음',
    !first && fixed ? `지금 판정 ${fixed.level}(${fixed.why}) 계속` : null,
    flowWords.length ? flowWords.join(' · ') : (sim ? '입출항 예정 없음' : null),
  ].filter(Boolean).join(' · ');
  if (nowBlocked) summary = `지금은 실측으로 ${cur.headline || cur.status} · ${summary}`;
  const waveNow = nowBlocked && (cur.reasons || []).some((r) => /파고/.test(r) && />=/.test(r));
  const sources = data
    ? `기상청 단기예보 발표 ${hm(pts[0]?.issued_at_utc)} · ${hasTide ? '국립해양조사원 조석예보' : '조위 예측 없음'} · PORT-MIS 입출항 신고 · 항만공사 선박위치 · 예보 격자 ${data.forecast_grid?.note || '-'}`
    : '';

  // 그 시각 이 선석(또는 항만)의 배
  const hereShips = present.filter((x) => (wide ? true : x.p.berthId === focus.berthId));
  const shipLine = wide ? null : hereShips.map((x) => `${x.p.name} ${phaseLabel(x)}`).join(' · ') || '이 선석에 배 없음';
  const tally = (fn) => present.filter(fn).length;
  const portLine = [
    `접안 ${tally((x) => isAtBerth(x.st.phase))}`,
    `하역 중 ${tally((x) => x.st.phase === 'work')}`,
    tally((x) => x.st.phase === 'stopped') ? `하역 중단 ${tally((x) => x.st.phase === 'stopped')}` : null,
    tally((x) => x.st.phase === 'held') ? `하역 보류 ${tally((x) => x.st.phase === 'held')}` : null,
    `대기 ${tally((x) => x.st.phase === 'waiting')}`,
    tally((x) => x.st.phase === 'heldOut') ? `입항 보류 ${tally((x) => x.st.phase === 'heldOut')}` : null,
    `입출항 ${tally((x) => MOVING.has(x.st.phase))}`,
  ].filter(Boolean).join(' · ');
  const movingNow = present.filter((x) => MOVING.has(x.st.phase) || isWaiting(x.st.phase));

  // 지금 커서가 가리키는 시각의 내용
  const view = wide
    ? (n ? {
      stage: point ? `앞으로 · ${whenLabel(point.at_utc)} (+${Math.round((tNow - t0) / H)}시간)` : '지금',
      level: point ? point.level : '적합',
      headline: sim ? portLine : '선박 일정을 읽는 중…',
      line1: point
        ? `부두 기상 ${point.level === '적합' ? '정상' : point.headline} · 예보 풍속 ${num(point.wind_ms, 'm/s')} · 파고 ${num(point.wave_m, 'm')}`
        : '3D 화면은 지금의 실측 위치입니다 — 재생하면 일정대로 움직입니다',
      line2: movingNow.length ? movingNow.map((x) => `${x.p.name} ${phaseLabel(x)} → ${shortBerthName(x.p.berthId)}`).join(' · ') : null,
    } : null)
    : point
      ? {
        stage: `앞으로 · ${whenLabel(point.at_utc)} (+${Math.round((tNow - t0) / H)}시간)`,
        level: point.level, headline: point.headline || point.status, gate: point.gate,
        line0: shipLine,
        line1: `예보 풍속 ${num(point.wind_ms, 'm/s')} · 파고 ${num(point.wave_m, 'm')}${Number(point.precip_mm) > 0 ? ` · 강수 ${num(point.precip_mm, 'mm')}` : ''}`,
        line2: tideLine(point.tide_m, point.ukc_m, false),
        line3: (() => {
          const here = point.ghosts || [];
          if (!here.length) return null;
          return here.map((gh) => `${gh.vessel_name} `
            + (gh.draught ? `흘수 ${gh.draught.toFixed(1)} m`
              + (gh.ukc != null ? ` · 여유 ${signed(gh.ukc)} m (필요 ${ukcRequired(gh.draught).toFixed(2)})` : '') : '흘수 미신고')).join(' / ');
        })(),
        recipient: (point.heldOut || []).length || (point.ghosts || []).some((gh) => gh.level && gh.level !== '적합')
          ? '선석 운영 주체 · VTS (입항 전)'
          : point.fixedHere?.recipient && !(point.weather_level && point.weather_level !== '적합')
            ? point.fixedHere.recipient
            : '터미널 안전관리자 → 하역 개시 게이트',
        action: actionFor(point),
      }
      : cur
        ? (() => {
          const lv = fixed ? worse(cur.level || '적합', fixed.level) : cur.level;
          const wxBad = cur.level && cur.level !== '적합';
          return {
            stage: `지금 · 실측 ${hm(cur.wind_observed_at_utc)}`,
            level: lv,
            headline: [wxBad ? (cur.headline || cur.status) : null, fixed ? fixed.why : null].filter(Boolean).join(' · ')
              || cur.headline || cur.status || '판단불가',
            gate: fixed ? (GATE_OF[lv] || cur.gate) : cur.gate,
            line0: shipLine,
            line1: `풍속 ${num(cur.wind_ms, 'm/s')} · 파고 ${num(cur.wave_m, 'm')}`,
            line2: tideLine(tideNow, ukcNow, true),
            action: fixed ? `${fixed.action || '하역 개시 전 재확인'} — ${fixed.why}`
              : cur.level === '적합' ? '없음 — 배정대로 진행' : '하역 개시 전 재확인',
            recipient: fixed?.recipient || null,
          };
        })()
        : null;
  const levelColor = LEVEL_COLOR[view?.level] || '#94a3b8';

  const onStripClick = (e) => {
    if (!n || !stripRef.current) return;
    const r = stripRef.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    jumpTo(tStart + frac * (tEnd - tStart));
  };
  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    if (!live && simClock.t >= tEnd - 2) goLive();
    setPlaying(true);
  };
  const rowH = showAll ? 14 : 18;
  const title = wide ? '온산항 전체' : `${focus.berth}${vesselName ? ` · ${vesselName}` : ''}`;

  return (
    // 72시간을 보는 동안 선박 목록 · 레이더는 접는다(DigitalTwinPage) — 왼쪽 목록과 겹쳤다(현우)
    <div ref={panelRef} className="outlook-panel" style={{
      position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      width: 'min(1040px, calc(100% - 80px))', minWidth: 600, zIndex: 1000,
      background: 'rgba(15, 23, 42, 0.92)', backdropFilter: 'blur(10px)',
      border: '1px solid rgba(56, 189, 248, 0.45)', borderRadius: 12, padding: '11px 16px 9px',
      color: '#e8f0f2', fontSize: 12.5, boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
    }}>
      {/* 머리 — 무엇의 72시간인가 · 지금 가리키는 시각. 한 줄로 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
        <span style={{ color: '#38bdf8' }}>●</span>
        <strong style={{ fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{title}</strong>
        <span style={{ fontWeight: 800, color: '#38bdf8', whiteSpace: 'nowrap' }}>앞으로 72시간</span>
        <HelpTip title="앞으로 72시간">
          <div><strong>앞으로 72시간</strong>을 시간 순으로 돌려 봅니다 — 접안한 배가 하역을 마치고 떠나고, 입항 예정 선박이 신고한 시각에 들어와 배정 선석에 댑니다. 3D 화면의 배와 선석 색이 같이 움직입니다.</div>
          <div style={{ marginTop: 4 }}><strong>자료</strong> · 입항 · 출항 예정 시각과 배정 선석은 PORT-MIS 신고, 지금 접안은 항만공사 선박위치, 기상은 기상청 단기예보를 부두 기준으로 판정한 것, 흘수 여유는 국립해양조사원 조석예보입니다. 판정 규칙은 관제 화면과 같습니다.</div>
          <div style={{ marginTop: 4 }}><strong>규칙</strong> · 선석이 다 차 있으면 들어오는 배는 정박지에서 기다렸다가 자리가 나면 댑니다. 기상 예보가 하역중단 이상이면 그 시간만큼 하역이 멈추고 출항이 늦어집니다. 출항 예정 신고가 없는 배는 그 부두의 재항 시간 실측(중앙값)으로 잡습니다.</div>
          <div style={{ marginTop: 4 }}><strong>부적합 판정</strong> · 판정 규칙과 같게 움직입니다. 부적합인 입항 예정 선박은 접안하지 않고 정박지에서 <strong>입항 보류</strong>, 접안해 있는 부적합 선박은 게이트가 잠겨 <strong>하역 보류</strong>입니다. 대체 선석이나 화물 조정이 정해져 판정이 바뀌면 흐름도 달라집니다.</div>
          <div style={{ marginTop: 4 }}><strong>두 보기</strong> · 온산 전체에서 선석을 누르면 같은 시각의 그 선석으로, 선석에서 [온산 전체]를 누르면 같은 시각의 전체로 넘어갑니다.</div>
          <div style={{ marginTop: 4 }}><strong>계산으로 채운 것</strong> · 입항 기동 {SIM.APPROACH_H}시간, 하역 준비 {SIM.PREP_H}시간, 마무리 {SIM.FINISH_H}시간, 출항 기동 {SIM.DEPART_H}시간으로 두고 하역은 그 사이를 일정하게 진행한다고 봅니다. 입출항 경로는 정해진 항로이며 실제 항적이 아닙니다.</div>
          <div style={{ marginTop: 4 }}><strong>일정 줄</strong> · 모든 배가 같은 막대입니다. 안의 색이 단계 — 준비 · 마무리(밝은 회청), 하역 중(청록), 기상 중단(빨강). 막대 밖 빗금은 정박지 · 조위 대기(노랑), 입항 보류(빨강), 출항 추정 범위(회색). 이름 앞 점이 판정 색입니다. 지금 접안한 배는 왼쪽이 잘려 있고, 입항 예정 선박은 들어오는 시각에서 시작합니다. 막대나 아래 사건을 누르면 그 시각으로 갑니다.</div>
          <div style={{ marginTop: 4 }}><strong>조위 창</strong> · 흘수 신고가 있는 입항 예정 선박은 접안 시각의 조석예보로 흘수 여유를 봅니다. 필요 여유 max(1.0 m, 흘수×10%)보다 작으면 조위가 오를 때까지 정박지에서 조위 대기입니다.</div>
          <div style={{ marginTop: 4 }}><strong>출항 추정 범위</strong> · 출항 예정 신고가 없는 배는 그 부두 재항 시간 중앙값으로 출항을 잡고, 90%까지를 범위로 그립니다.{bt ? ` 최근 온산 입출항 ${bt.n}건으로 검증하면 중앙값 추정의 오차는 중앙값 ${Math.round(bt.medianErrH)}시간이고, 실제 출항의 ${bt.inRangePct}%가 범위 안에 들었습니다.` : ''}</div>
          <div style={{ marginTop: 4 }}><strong>대체 선석 돌려 보기</strong> · 입항 보류 선박은 선석 검증 에이전트의 후보 선석마다 혼재 등급과 접안 시각을 보이고, 누르면 그 선석에 댄다고 가정해 72시간을 다시 돌립니다. 배정이 아니라 비교이며 판정 이력에 남지 않습니다.</div>
          <div style={{ marginTop: 4 }}>쓰는 때: 하역 도중 기상이 나빠지는 시각을 미리 보고 종료 · 개시 연기를 알리거나, 선석이 겹치는 입항을 미리 조정할 때.</div>
          {waveNow && <div style={{ marginTop: 4 }}>지금 실측 파고는 외해 부이 값이고 예보 파고는 부두 앞 격자 값입니다 — 둘이 다르면 현장 파고를 확인하세요.</div>}
          {sources && <div style={{ marginTop: 4, color: '#94a3b8' }}>{sources}</div>}
        </HelpTip>
        {data && !wide && <span style={{ color: '#94a3b8', fontSize: 11.5, whiteSpace: 'nowrap' }}>{rule}</span>}
        {data && wide && view && (
          <span
            title={[view.headline, view.line2].filter(Boolean).join(' · ')}
            style={{ fontWeight: 700, color: point && point.level !== '적합' ? levelColor : '#e8f0f2', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {[view.headline, point && point.level !== '적합' ? point.headline : null].filter(Boolean).join(' · ')}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span
            ref={clockRef}
            style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, color: live ? '#94a3b8' : '#e8f0f2', whiteSpace: 'nowrap', minWidth: 186, textAlign: 'right' }}
          >
            {live ? '지금 · 실측' : clockText(tNow, t0)}
          </span>
          <button type="button" onClick={onClose} style={iconBtn} title="닫기 — 3D 화면이 지금으로 돌아갑니다"><FaTimes /></button>
        </span>
      </div>

      {/* 가정 중 — 무엇을 바꿔 돌리는지 늘 보인다 */}
      {ovList.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '4px 10px', borderRadius: 6, background: 'rgba(251,191,36,0.14)', border: '1px solid rgba(251,191,36,0.5)', fontSize: 12 }}>
          <b style={{ color: '#fbbf24' }}>가정</b>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
            {ovList.map(([, o]) => `${o.name} → ${shortBerthName(o.berthId)}(원래 ${shortBerthName(o.from)} · 혼재 ${o.risk || '미확인'})`).join(' · ')}
          </span>
          <button type="button" onClick={() => resim({})} style={{ ...iconBtn, marginLeft: 'auto', padding: '2px 8px' }}>원래대로</button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, color: '#f87171' }}>
          판정 흐름을 읽지 못했습니다 ({error}). 관제 서버가 떠 있는지, 선석 이름이 맞는지 확인하세요.
        </div>
      )}
      {!data && !error && <div style={{ marginTop: 10, color: '#94a3b8' }}>판정 흐름을 읽는 중…</div>}

      {data && (
        <>
          {/* 시간축 띠 — 시각마다 판정 색. 누르면 그 시각으로 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button
              type="button" onClick={goLive}
              title="지금(실측)으로"
              style={{
                ...iconBtn, flexShrink: 0, width: 61, justifyContent: 'center', padding: '5px 0',
                borderColor: live ? '#fff' : LEVEL_COLOR[cur?.level] || 'rgba(232,240,242,0.25)',
                color: LEVEL_COLOR[cur?.level] || '#e8f0f2',
              }}
            >
              ● 지금
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                ref={stripRef} onClick={onStripClick} role="slider" aria-label="앞으로 72시간"
                aria-valuemin={0} aria-valuemax={Math.max(0, n - 1)} aria-valuenow={Math.max(0, cursor)}
                style={{ position: 'relative', height: 16, display: 'flex', borderRadius: 3, cursor: 'pointer', border: '1px solid rgba(232,240,242,0.35)' }}
              >
                {pts.map((p, i) => (
                  <div
                    key={p.at_utc}
                    title={`${whenLabel(p.at_utc)} · ${p.headline || p.status}`}
                    style={{ flex: 1, background: LEVEL_COLOR[p.level] || '#64748b', opacity: cursor >= 0 && i > cursor ? 0.5 : 1 }}
                  />
                ))}
                {firstIdx != null && (
                  <div style={{ position: 'absolute', top: -6, bottom: -4, left: `${(firstIdx / n) * 100}%`, width: 2, background: '#ff5a50' }} />
                )}
                <div
                  ref={needleA}
                  style={{
                    position: 'absolute', top: -9, left: `${xPct(tNow)}%`, marginLeft: -6, width: 0, height: 0, display: live ? 'none' : 'block',
                    borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '8px solid #fff',
                  }}
                />
              </div>
              <div style={{ position: 'relative', height: 14, fontSize: 10.5, color: '#aab8be' }}>
                {pts.map((p, i) => (i % 12 === 0 && i < n - 8 ? (   // 끝 눈금과 겹치는 마지막 눈금은 뺀다
                  <span key={p.at_utc} style={{ position: 'absolute', left: `${(i / n) * 100}%`, whiteSpace: 'nowrap' }}>{tickLabel(p.at_utc)}</span>
                ) : null))}
                <span style={{ position: 'absolute', right: 0, whiteSpace: 'nowrap' }}>{tickLabel(tEnd)}</span>
                {firstIdx != null && (
                  <span style={{ position: 'absolute', left: `max(22px, ${(firstIdx / n) * 100}%)`, top: -30, transform: 'translateX(-50%)', color: '#ff8a80', fontWeight: 800, whiteSpace: 'nowrap', fontSize: 11 }}>첫 변화</span>
                )}
              </div>
            </div>
            <span style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
              <button type="button" onClick={togglePlay} style={iconBtn} title={playing ? '멈춤' : '재생'}>
                {playing ? <FaPause /> : <FaPlay />} {playing ? '멈춤' : '재생'}
              </button>
              <button
                type="button" style={{ ...iconBtn, minWidth: 40, justifyContent: 'center' }}
                onClick={() => setSpeed((v) => SPEEDS[(SPEEDS.indexOf(v) + 1) % SPEEDS.length])}
                title="재생 빠르기"
              >
                {speed}×
              </button>
              <button
                type="button" style={iconBtn}
                onClick={() => jumpTo(firstIdx != null ? ms(pts[firstIdx].at_utc) : tEnd - 1)}
                title={firstIdx != null ? '첫 변화 시각으로' : '72시간 끝으로'}
              >
                <FaFastForward /> {firstIdx != null ? '첫 변화' : '끝'}
              </button>
              <button type="button" onClick={() => { goLive(); setPlaying(true); }} style={iconBtn} title="처음부터 다시 재생"><FaUndo /></button>
            </span>
          </div>

          {/* 일정 줄 — 같은 시간축. 줄 = 선석의 자리, 막대 = 머무는 배 */}
          {lanes.length > 0 && (
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <div style={{ width: 61, flexShrink: 0, display: 'grid', gap: 3, alignContent: 'start' }}>
                {lanes.map((r) => (wide && r.first && onBerth ? (
                  <button
                    key={r.key} type="button" onClick={() => onBerth(r.id)} title={`${ONSAN_BERTHS_3D[r.id]?.name} — 이 선석의 판정을 자세히`}
                    style={{ height: rowH, lineHeight: `${rowH}px`, fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', color: '#bae6fd', fontWeight: 700, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textDecorationColor: 'rgba(186,230,253,0.35)', textUnderlineOffset: 2 }}
                  >
                    {shortBerthName(r.id)}
                  </button>
                ) : (
                  <span key={r.key} style={{ height: rowH, lineHeight: `${rowH}px`, fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', color: r.id === focus.berthId ? '#e8f0f2' : '#94a3b8', fontWeight: r.id === focus.berthId ? 800 : 500 }}>
                    {r.first ? shortBerthName(r.id) : ''}
                  </span>
                )))}
              </div>
              <div style={{ flex: 1, minWidth: 0, position: 'relative', height: lanes.length * (rowH + 3) - 3 }}>
                {stopSpans.map((sp) => (
                  <span
                    key={`stop-${sp.from}`} title="기상으로 하역이 막히는 구간"
                    style={{
                      position: 'absolute', top: -2, bottom: -2, left: `${(sp.from / n) * 100}%`, width: `${((sp.to - sp.from) / n) * 100}%`,
                      background: 'repeating-linear-gradient(135deg, rgba(239,68,68,0.28) 0 4px, rgba(239,68,68,0.08) 4px 8px)',
                    }}
                  />
                ))}
                {lanes.map((r, i) => (
                  <span key={r.key} style={{ position: 'absolute', left: 0, right: 0, top: i * (rowH + 3), height: rowH, background: 'rgba(232,240,242,0.05)', borderRadius: 3 }} />
                ))}
                {lanes.map((r, i) => r.items.map((p) => bar(p, i * (rowH + 3), rowH)))}
                <span
                  ref={needleB}
                  style={{ position: 'absolute', top: -3, bottom: -3, left: `${xPct(tNow)}%`, width: 1, background: '#fff', opacity: 0.85, display: live ? 'none' : 'block', pointerEvents: 'none' }}
                />
              </div>
              <span style={{ flexShrink: 0, width: 232, display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
                <span style={{ display: 'flex', gap: 5 }}>
                  {showAll && stillCount > 0 && (
                    <button
                      type="button" onClick={() => setEveryLane((v) => !v)} style={{ ...iconBtn, padding: '3px 8px' }} aria-pressed={everyLane}
                      title="72시간 안에 들어오거나 나가지 않는 배의 자리"
                    >
                      {everyLane ? '바뀌는 자리만' : `머무는 배 ${stillCount}`}
                    </button>
                  )}
                  {!wide && onWide && (
                    <button type="button" onClick={onWide} style={{ ...iconBtn, padding: '3px 8px' }} title="같은 시각의 온산항 전체로">
                      온산 전체
                    </button>
                  )}
                </span>
              </span>
            </div>
          )}
          {lanes.length > 0 && (
            <div className="outlook-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 12px', marginTop: 5, marginLeft: 71, fontSize: 10.5, color: '#94a3b8' }}>
              {[['하역 중', GANTT.work], ['준비 · 마무리', GANTT.prep], ['기상 중단', GANTT.halt]].map(([w, c]) => (
                <span key={w} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><i style={{ width: 14, height: 8, borderRadius: 2, background: c }} />{w}</span>
              ))}
              {[['대기', '251,191,36'], ['보류', '248,113,113'], ['출항 추정 범위', '148,163,184']].map(([w, c]) => (
                <span key={w} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={w === '출항 추정 범위' ? `출항 예정 신고가 없는 배 — 이 부두 재항 시간 중앙값 ~ 90%${btTip}` : undefined}>
                  <i style={{ width: 14, height: 8, borderRadius: 2, background: hatch(c, 0.7) }} />{w}
                </span>
              ))}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {['적합', '주의', '부적합'].map((l) => <i key={l} title={l} style={{ width: 7, height: 7, borderRadius: '50%', background: LEVEL_COLOR[l] }} />)}
                판정
              </span>
            </div>
          )}
          {lanes.length === 0 && !wide && sim && onWide && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
              <button type="button" onClick={onWide} style={{ ...iconBtn, padding: '3px 8px' }} title="같은 시각의 온산항 전체로">온산 전체</button>
            </div>
          )}

          {/* 사건 — 72시간 동안 일어나는 일. 누르면 그 장면부터 재생 */}
          {events.length > 0 && (
            <div className="outlook-events" style={{ display: 'flex', gap: 6, marginTop: 8, overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: 2 }}>
              {events.map((e) => {
                const mk = EVENT_MARK[e.type];
                const past = !live && e.at < tNow;
                return (
                  <button
                    key={`e-${e.type}-${e.plan.key}-${e.at}`} type="button" onClick={() => jumpTo(eventStart(e), true)}
                    title={`${mk.word} · ${e.plan.name} · ${ONSAN_BERTHS_3D[e.plan.berthId]?.name || ''} · ${hm(e.at)}`}
                    style={{
                      ...iconBtn, flexShrink: 0, padding: '3px 8px', fontWeight: 600, fontSize: 11,
                      opacity: past ? 0.5 : 1, borderColor: `${mk.color}66`,
                    }}
                  >
                    <span style={{ color: mk.color }}>{mk.mark}</span>
                    <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', color: '#c3cede' }}>{dayHm(e.at)}</span>
                    {mk.word} {e.plan.name}
                    {showAll && <span style={{ color: '#94a3b8' }}>{shortBerthName(e.plan.berthId)}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {/* 입항 보류 선박 — 대체 선석을 가정해 돌려 본다(배정이 아니라 비교) */}
          {heldPlans.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: 2 }}>
              {heldPlans.map((hp) => (
                <span key={`hold-${hp.key}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ color: '#fca5a5', fontWeight: 700, fontSize: 11.5 }}>◆ {hp.name} 입항 보류</span>
                  {alt?.callsgn !== hp.callsgn && (
                    <button type="button" onClick={() => openAlts(hp)} style={{ ...iconBtn, padding: '2px 8px', fontSize: 11 }}>대체 선석 돌려 보기</button>
                  )}
                  {alt?.callsgn === hp.callsgn && alt.state === 'loading' && <span style={{ color: '#94a3b8', fontSize: 11 }}>후보 선석과 혼재 등급을 보는 중…</span>}
                  {alt?.callsgn === hp.callsgn && (alt.state === 'error' || alt.state === 'empty') && <span style={{ color: '#94a3b8', fontSize: 11 }}>{alt.state === 'empty' ? '3D 에 있는 후보 선석 없음' : `후보를 받지 못함(${alt.error})`}</span>}
                  {alt?.callsgn === hp.callsgn && alt.state === 'ready' && alt.rows.map((row) => (
                    <button
                      key={row.berthId} type="button" onClick={() => applyAlt(hp, row)}
                      title={`${hp.name}을(를) ${row.wharf}에 댄다고 가정하고 다시 돌립니다 — 배정이 아니라 비교입니다`}
                      style={{ ...iconBtn, padding: '2px 8px', fontSize: 11, borderColor: `${LEVEL_COLOR[row.level] || '#94a3b8'}99` }}
                    >
                      → {shortBerthName(row.berthId)}
                      <span style={{ color: LEVEL_COLOR[row.level] || '#94a3b8' }}>혼재 {row.risk || '미확인'}</span>
                      <span style={{ color: '#cbd5e1', fontWeight: 500 }}>{row.hold ? '여전히 보류' : row.berthAt ? `${dayHm(row.berthAt)} 접안${row.waitH ? ` · 대기 ${row.waitH}시간` : ''}` : '72시간 안 접안 못 함'}</span>
                    </button>
                  ))}
                </span>
              ))}
            </div>
          )}

          {/* 그 시각의 판정 */}
          {view && !wide && (
            <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: '6px 18px', marginTop: 9 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>{view.stage}</div>
                <div style={{ fontSize: 16.5, fontWeight: 800, color: levelColor, margin: '2px 0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${view.headline} — ${GATE_TEXT[view.gate] || ''}`}>
                  ● {view.headline} — {GATE_TEXT[view.gate] || ''}
                </div>
                {view.line0 && <div style={{ color: '#a7f3d0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={view.line0}>{view.line0}</div>}
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{view.line1}</div>
                <div style={{ color: '#c3cede', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={view.line2}>{view.line2}</div>
                {view.line3 && <div style={{ color: '#93c5fd', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={view.line3}>{view.line3}</div>}
              </div>
              <div style={{ display: 'grid', gap: 3, alignContent: 'start', paddingTop: 14, minWidth: 0 }}>
                <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={view.action}><span style={dim}>조치안</span>{view.action}</div>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span style={dim}>받는 곳</span>{view.recipient || '터미널 안전관리자 → 하역 개시 게이트'}</div>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={verdictLine}><span style={dim}>지금 판정</span><span style={{ color: a?.level ? LEVEL_COLOR[a.level] : '#c3cede' }}>{verdictLine}</span></div>
                {gateLine && <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={gateLine}><span style={dim}>게이트</span>{gateLine}</div>}
              </div>
            </div>
          )}
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.1)', fontWeight: 700, color: first || nowBlocked ? '#ff8a80' : '#10b981', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={summary}>
            {summary}
          </div>
        </>
      )}
    </div>
  );
}
