import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaTimes, FaCloudSun, FaShip, FaHistory, FaCube, FaLock } from 'react-icons/fa';
import useSensorStore from '../../stores/useSensorStore';
import useVesselThread from '../../hooks/useVesselThread';
import useDashboardData from '../../hooks/useDashboardData';
import useOnsanApi from '../../hooks/useOnsanApi';
import { fetchBerthHistory } from '../../api/backendAdapter';
import { COLORS, WEATHER_STATUS_COLORS } from '../../utils/constants';
import { VERDICT_BG, berthKey, verdictColor } from '../../utils/verdict';
import { berthMeta, gateOfBerth, historyPattern, weatherGroupOf } from '../../utils/onsanBerths';
import { cargoSummary } from '../../utils/cargoText';
import HelpTip from '../common/HelpTip';

// ─────────────────────────────────────────────────────────────────────────────
// 선석 상세 서랍 (2026-09-29 밤)
//
// 부두 하나에 관한 것을 한 서랍에 모은다 — 지도의 선석 원 · 선석 현황판 칸에서 연다.
//   접안      지금 붙어 있는 배와 판정(선박 판정 '하역 중'과 같은 자료) — 누르면 그 배를 추적
//   부두 기상  그 부두 기준군의 4단계 판정(기상 에이전트). 강수·특별 기상은 관제사가 본 것을 여기서 넣는다
//   최근 3주   출항까지 확정된 입출항 신고(PORT-MIS) + 지금 접안 중인 배를 한 시간축에
//   재항 시간  그 부두 실측 재항 시간 분포(보통 · 대부분) 위에 지금 배가 몇 시간째인지
// 예전엔 부두 기상 판정이 대시보드 한가운데 따로 있었고, 접안 이력은 대시보드 맨 아래 목록이었다(현우 9/29 지적).
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3600000;
const DAY = 24 * HOUR;
const STAGE_TEXT = { 입항전: '입항 전', 접안직전: '접안 직전', 하역중: '하역 중' };
const GENERIC_REASON = /^(배정된|이|지금 접안한|PORT-MIS 신고) 선석이 이 선박·화물 조건에 맞/;
const keyReason = (reasons) => {
  const list = (reasons || []).map(String).filter(Boolean);
  return list.find((t) => !GENERIC_REASON.test(t)) || list[0] || null;
};
const kst = (ms) => new Date(ms).toLocaleString('ko-KR', {
  timeZone: 'Asia/Seoul', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const md = (ms) => {
  const d = new Date(ms + 9 * HOUR);   // KST
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const hoursSince = (iso) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / HOUR) : null);

/** 최근 3주 — 지난 접안(출항 확정)과 지금 접안을 한 시간축에 */
function BerthTimeline({ history, current }) {
  const now = Date.now();
  const t0 = now - 21 * DAY;
  const t1 = now + 3 * DAY;
  const x = (t) => ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * 100;

  const items = [
    ...history.map((h) => ({
      key: `h-${h.callsgn || h.vessel_name}-${h.arrival_at_utc}`, kind: 'past',
      name: h.vessel_name, a: Date.parse(h.arrival_at_utc), d: Date.parse(h.departure_at_utc), facility: h.facility_name,
    })),
    ...current.map((s) => ({
      key: `c-${s.call_sign}`, kind: 'now', name: s.vessel_name || s.call_sign, level: s.status,
      a: s.actual_arrival_utc ? Date.parse(s.actual_arrival_utc) : null,
      d: s.departure_scheduled_utc ? Date.parse(s.departure_scheduled_utc) : null,
    })),
  ].filter((it) => it.kind === 'now' || (Number.isFinite(it.d) && it.d > t0));

  // 겹치지 않게 줄을 나눈다(먼저 온 배부터 빈 줄에)
  const laneEnds = [];
  const placed = [...items].sort((p, q) => (p.a ?? now) - (q.a ?? now)).map((it) => {
    const start = it.a ?? now - 2 * HOUR;
    const end = it.kind === 'now' ? Math.max(now, it.d ?? now) : it.d;
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(end); } else laneEnds[lane] = end;
    return { ...it, start, end, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  const ticks = [21, 14, 7, 0].map((d) => now - d * DAY);

  return (
    <div className="bd-tl" style={{ height: lanes * 22 + 20 }}>
      {ticks.map((t) => (
        <span key={t} className="bd-tl-tick" style={{ left: `${x(t)}%` }}>{t === now ? '지금' : md(t)}</span>
      ))}
      <span className="bd-tl-now" style={{ left: `${x(now)}%` }} />
      {placed.map((it) => {
        const left = x(it.start);
        const solidEnd = it.kind === 'now' ? x(now) : x(it.end);
        const hours = ((Math.min(it.end, it.kind === 'now' ? now : it.end) - it.start) / HOUR).toFixed(0);
        const title = it.kind === 'now'
          ? `${it.name} · 지금 접안${it.a ? ` · ${kst(it.a)} 입항 · ${hours}시간째` : ''}${it.d ? ` · 출항 예정 ${kst(it.d)}` : ''}`
          : `${it.name} · ${kst(it.a)} → ${kst(it.d)} · ${hours}시간${it.facility ? ` · 신고 ${it.facility}` : ''}`;
        return (
          <span key={it.key}>
            <span
              className={`bd-bar ${it.kind}`}
              style={{
                left: `${left}%`, width: `${Math.max(solidEnd - left, 0.9)}%`, top: it.lane * 22,
                ...(it.kind === 'now' ? { '--bar-tone': it.level ? verdictColor(it.level) : COLORS.navy } : {}),
              }}
              title={title}
            >
              {/* 이름이 다 들어가는 막대에만 적는다(좁은 막대는 마우스를 올리면 보인다) — 잘린 글자를 두지 않는다 */}
              {(solidEnd - left) * 3.6 >= String(it.name).length * 10 + 10 && <span>{it.name}</span>}
            </span>
            {it.kind === 'now' && it.end > now && (
              <span
                className="bd-bar plan"
                style={{ left: `${x(now)}%`, width: `${Math.max(x(it.end) - x(now), 0.9)}%`, top: it.lane * 22, '--bar-tone': it.level ? verdictColor(it.level) : COLORS.navy }}
                title={title}
              >
                {/* 입항한 지 얼마 안 돼 칠한 막대가 짧으면 이름을 출항 예정 쪽에 적는다 */}
                {(solidEnd - left) * 3.6 < String(it.name).length * 10 + 10
                  && (x(it.end) - x(now)) * 3.6 >= String(it.name).length * 10 + 10 && <span>{it.name}</span>}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** 재항 시간 — 그 부두 실측 분포 위에 지금 배가 몇 시간째인지 */
function DwellScale({ dwell, current }) {
  const med = Number(dwell.median_hours);
  const p90 = Number(dwell.p90_hours);
  const marks = current
    .map((s) => ({ s, h: hoursSince(s.actual_arrival_utc) }))
    .filter((m) => m.h != null);
  const max = Math.max(p90 * 1.15, ...marks.map((m) => m.h * 1.05), 1);
  const pos = (h) => `${Math.min(100, (h / max) * 100)}%`;
  return (
    <div className="bd-dwell">
      <div className="bd-dw-track">
        <span className="bd-dw-range" style={{ width: pos(p90) }} />
        <span className="bd-dw-med" style={{ left: pos(med) }} />
        {marks.map(({ s, h }) => (
          <span
            key={s.call_sign}
            className="bd-dw-ship"
            style={{ left: pos(h), '--ship-tone': s.status ? verdictColor(s.status) : COLORS.navy }}
            title={`${s.vessel_name || s.call_sign} · 입항 ${Math.round(h)}시간째`}
          />
        ))}
      </div>
      <div className="bd-dw-labels">
        <span>보통 <strong>{Math.round(med)}</strong>시간</span>
        <span>대부분 <strong>{Math.round(p90)}</strong>시간 이내</span>
      </div>
    </div>
  );
}

export default function BerthDetailPanel() {
  const name = useSensorStore((s) => s.selectedBerth);
  const setSelectedBerth = useSensorStore((s) => s.setSelectedBerth);
  const trackVessel = useSensorStore((s) => s.trackVessel);
  const tracked = useSensorStore((s) => s.trackedVessel);
  const navigate = useNavigate();
  const { berths } = useVesselThread();
  const { data } = useDashboardData();
  const { assessBerthWeather } = useOnsanApi();

  const row = useMemo(() => berths.find((b) => berthKey(b.wharf_name) === berthKey(name)) || null, [berths, name]);
  const meta = berthMeta(name);
  const group = weatherGroupOf(name);
  const dwell = (data?.berth_dwell ?? []).find((d) => berthKey(d.wharf_name) === berthKey(row?.wharf_name || name)) || null;
  const ships = (row?.slots || []).filter((s) => s.call_sign);
  const cap = Math.max(row?.max_concurrent_vessels || 0, (row?.slots || []).length, ships.length, 1);

  // 부두 기상 — 기상 에이전트가 그 부두 기준군의 실측 풍속·파고로 판정한다. 강수·특별 기상은 관측 자료가 없어
  // 관제사가 본 것을 넣는다(산업안전보건기준 규칙 제383조 제2호 준용).
  const [precip, setPrecip] = useState(false);
  const [extra, setExtra] = useState(false);
  const [wx, setWx] = useState(null);
  useEffect(() => { setPrecip(false); setExtra(false); }, [name]);
  useEffect(() => {
    if (!name || !group) { setWx(null); return undefined; }
    let alive = true;
    setWx((w) => ({ ...(w?.berth_group === group ? w : {}), busy: true }));
    assessBerthWeather({ berthGroup: group, precipObserved: precip, extraCondition: extra })
      .then((v) => { if (alive) setWx(v); })
      .catch(() => { if (alive) setWx({ error: true }); });
    return () => { alive = false; };
  }, [name, group, precip, extra, assessBerthWeather]);

  // 최근 접안 — 그 부두 이름으로 입출항 신고를 찾는다
  const [hist, setHist] = useState(null);
  useEffect(() => {
    if (!name) return undefined;
    let alive = true;
    setHist(null);
    fetchBerthHistory(historyPattern(row?.wharf_name || name), 12)
      .then((rows) => { if (alive) setHist(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setHist([]); });
    return () => { alive = false; };
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!name) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSelectedBerth(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [name, setSelectedBerth]);

  if (!name) return null;

  const title = row?.wharf_name || meta?.name || name;
  const operator = row?.operator || meta?.operator;
  const depth = row?.depth_m ?? meta?.depthM;
  const length = row?.length_m ?? meta?.lengthM;
  const maxDwt = row?.max_dwt ?? meta?.maxDwt;
  const gate = gateOfBerth(title);
  const obs = wx?.observed;
  const th = wx?.thresholds_used;
  const wxColor = WEATHER_STATUS_COLORS[wx?.status] || COLORS.textDim;

  return (
    <aside className="berth-drawer" aria-label={`${title} 상세`}>
      <header className="bd-head">
        <div>
          <h3>{title}</h3>
          <p>
            {[operator, depth != null ? `수심 ${depth} m` : null, length != null ? `길이 ${length} m` : null,
              maxDwt ? `${Number(maxDwt).toLocaleString()} DWT` : null].filter(Boolean).join(' · ')}
          </p>
          {row?.handling_cargo_name && <p className="bd-dim">{row.handling_cargo_name}</p>}
        </div>
        <button type="button" className="bd-close" onClick={() => setSelectedBerth(null)} aria-label="닫기"><FaTimes /></button>
      </header>

      <section className="bd-sec">
        <h4><FaShip /> 접안 <small>{ships.length}/{cap}</small></h4>
        <ul className="bd-slots">
          {Array.from({ length: cap }).map((_, i) => {
            const s = ships[i];
            if (!s) return <li key={`free-${i}`} className="bd-slot free">비어 있음</li>;
            const mine = tracked && berthKey(tracked.callsgn) === berthKey(s.call_sign);
            const h = hoursSince(s.actual_arrival_utc);
            const reason = s.status && s.status !== '적합' ? keyReason(s.reasons) : null;
            return (
              <li key={s.call_sign} className={`bd-slot${mine ? ' mine' : ''}`} style={{ '--ship-tone': s.status ? verdictColor(s.status) : COLORS.border }}>
                <button type="button" onClick={() => trackVessel({ callsgn: s.call_sign, vessel_name: s.vessel_name })}>
                  <span className="bd-ship-top">
                    <strong>{s.vessel_name || s.call_sign}</strong>
                    <span className="bd-pill" style={{ color: s.status ? verdictColor(s.status) : COLORS.textDim, background: VERDICT_BG[s.status] || COLORS.cardHover }}>
                      {s.status || '판정 전'}
                    </span>
                  </span>
                  <span className="bd-ship-sub">
                    {[STAGE_TEXT[s.stage], s.cargo_names?.length ? cargoSummary(s.cargo_names, 2) : null,
                      h != null ? `${Math.round(h)}시간째` : null].filter(Boolean).join(' · ')}
                  </span>
                  {reason && <span className="bd-reason">{reason}</span>}
                  {s.action && s.status && s.status !== '적합' && (
                    <span className="bd-action">{s.action}{s.recipient ? <> → <strong>{s.recipient}</strong></> : null}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="bd-sec">
        <h4>
          <FaCloudSun /> 부두 기상
          <HelpTip title="부두 기상">
            <div>기상 분석 에이전트가 이 부두 기준군({group || '미등록'})의 실측 풍속·파고로 정상 → 하역중단 → 이안 → 호스분리 4단계를 판정합니다.</div>
            <div style={{ marginTop: 4 }}>강수와 특별 기상(뇌우·태풍 경로 등)은 관측 자료가 없어 관제사가 본 것을 넣습니다 — 켜면 최소 하역중단으로 올라갑니다(산업안전보건기준 규칙 제383조 제2호 준용).</div>
          </HelpTip>
        </h4>
        {!group ? (
          <p className="bd-dim">이 부이는 부두 기상 기준이 등록되지 않았습니다.</p>
        ) : !wx || (wx.busy && !wx.status) ? (
          <p className="bd-dim">판정 중…</p>
        ) : wx.error || wx.is_local_fallback ? (
          <p className="bd-dim">기상 관측을 받지 못했습니다.</p>
        ) : (
          <div className={`bd-wx${wx.busy ? ' busy' : ''}`}>
            <span className="bd-wx-status" style={{ color: wxColor, borderColor: wxColor }}>{wx.status}</span>
            <div className="bd-wx-obs">
              <strong>풍속 {obs?.wind ?? '-'} m/s · 파고 {obs?.wave ?? '-'} m</strong>
              <span>
                {[obs?.station, obs?.observed_at_utc ? kst(Date.parse(obs.observed_at_utc)) : null].filter(Boolean).join(' · ')}
                {obs?.is_stale && <em> · 관측 오래됨</em>}
              </span>
              {th && (
                <span className="bd-dim">
                  기준 중단 {th.stop?.wind ?? '-'} · 이안 {th.unberth?.wind ?? '-'} · 분리 {th.disconnect?.wind ?? '-'} m/s
                  {th.stop?.wave != null ? ` · 파고 ${th.stop.wave} m` : ''}
                </span>
              )}
            </div>
          </div>
        )}
        {wx?.status && wx.status !== '정상' && (wx.reasons || []).length > 0 && (
          <ul className="bd-wx-why">{wx.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
        )}
        {wx?.forecast_warning && <p className="bd-wx-warn">{wx.forecast_warning}</p>}
        {group && (
          <div className="bd-toggles">
            <button type="button" aria-pressed={precip} className={precip ? 'on rain' : ''} onClick={() => setPrecip((p) => !p)}>강수 확인</button>
            <button type="button" aria-pressed={extra} className={extra ? 'on storm' : ''} onClick={() => setExtra((p) => !p)}>특별 기상</button>
          </div>
        )}
      </section>

      <section className="bd-sec">
        <h4><FaHistory /> 최근 3주</h4>
        {hist == null ? (
          <p className="bd-dim">불러오는 중…</p>
        ) : hist.length === 0 && ships.length === 0 ? (
          <p className="bd-dim">최근 입출항 기록이 없습니다.</p>
        ) : (
          <BerthTimeline history={hist} current={ships} />
        )}
        {dwell && (
          <>
            <h5>
              재항 시간
              <HelpTip title="재항 시간">
                <div>이 부두 입항 ~ 출항 실측 {Number(dwell.sample_count).toLocaleString()}건의 분포입니다. 보통 = 중앙값, 대부분 = 10척 중 9척이 이 시간 안에 출항(P90).</div>
                <div style={{ marginTop: 4 }}>하역만이 아니라 대기·검사·급유가 모두 들어 있어 실제 작업 시간보다 깁니다. 점은 지금 접안 중인 배가 입항 후 몇 시간째인지입니다.</div>
              </HelpTip>
            </h5>
            <DwellScale dwell={dwell} current={ships} />
          </>
        )}
      </section>

      <footer className="bd-links">
        <button type="button" onClick={() => { setSelectedBerth(null); navigate(`/twin?berth=${encodeURIComponent(title)}`); }}>
          <FaCube /> 3D 현장
        </button>
        {gate && (
          <button type="button" onClick={() => { setSelectedBerth(null); navigate('/sensors'); }}>
            <FaLock /> 하역 개시 게이트 {gate}
          </button>
        )}
      </footer>
    </aside>
  );
}
