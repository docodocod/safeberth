import { useEffect, useRef, useState } from 'react';
import useOnsanApi from '../../hooks/useOnsanApi';
import useSensorStore from '../../stores/useSensorStore';
import AgentChip from '../../utils/AgentChip';
import { COLORS } from '../../utils/constants';
import { FaAnchor, FaExclamationTriangle } from 'react-icons/fa';

// 4단계 에스컬레이션 뱃지 색 (정상 → 하역중단 → 이안 → 호스분리)
const LEVEL_STYLE = {
  '정상': { color: COLORS.teal, label: '정상 — 하역 가능' },
  '하역중단': { color: COLORS.yellow, label: '하역작업 중단' },
  '이안': { color: '#D2601A', label: '부두 이안' },
  '호스분리': { color: COLORS.red, label: '로딩암/호스 분리' },
  '판단불가': { color: COLORS.textDim, label: '판단불가' },
};

function ThresholdChip({ name, t }) {
  if (!t || (t.wind == null && t.wave == null)) return null;
  const parts = [];
  if (t.wind != null) parts.push(`풍속 ${t.wind}m/s`);
  if (t.wave != null) parts.push(`파고 ${t.wave}m`);
  return (
    <span style={{
      fontSize: '11px', color: COLORS.textSecondary, background: COLORS.card,
      border: `1px solid ${COLORS.border}`, borderRadius: '6px', padding: '3px 8px',
    }}>
      {name} {parts.join(' · ')}
    </span>
  );
}

export default function BerthWeatherPanel() {
  const { fetchBerthGroups, assessBerthWeather } = useOnsanApi();
  const berthGroups = useSensorStore((s) => s.berthGroups);
  const verdict = useSensorStore((s) => s.berthWeather);
  const selectedBerthGroup = useSensorStore((s) => s.selectedBerthGroup);

  const [berthGroup, setBerthGroup] = useState('');
  const [windSpeed, setWindSpeed] = useState('13');
  const [waveHeight, setWaveHeight] = useState('1.2');
  // 시나리오 ② — 강수는 실황 관측 소스가 없어 관제사 육안 확인을 입력으로 쓴다
  // (백엔드 WeatherAssessmentRequest.precip_observed → 산안법 383조 제2호 기준 적용)
  const [precipObserved, setPrecipObserved] = useState(false);
  const [extraCondition, setExtraCondition] = useState(false);
  const [flash, setFlash] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => { fetchBerthGroups(); }, [fetchBerthGroups]);

  // 선석군 로드되면 첫 항목 선택 + 최초 판정
  useEffect(() => {
    if (!berthGroup && berthGroups.length > 0) setBerthGroup(berthGroups[0]);
  }, [berthGroups, berthGroup]);

  // 지도에서 선석 클릭 시 해당 선석군으로 전환 + 패널로 스크롤 + 하이라이트
  useEffect(() => {
    if (!selectedBerthGroup) return;
    if (selectedBerthGroup !== berthGroup) setBerthGroup(selectedBerthGroup);
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBerthGroup]);

  useEffect(() => {
    if (berthGroup) assessBerthWeather({ berthGroup, windSpeed, waveHeight, precipObserved, extraCondition });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [berthGroup]);

  // 체크박스는 토글 즉시 재판정 — "비가 온다고 표시했는데 판정이 안 바뀌는" 상태를 남기지 않는다
  useEffect(() => {
    if (berthGroup) assessBerthWeather({ berthGroup, windSpeed, waveHeight, precipObserved, extraCondition });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precipObserved, extraCondition]);

  const run = () => assessBerthWeather({ berthGroup, windSpeed, waveHeight, precipObserved, extraCondition });
  const style = LEVEL_STYLE[verdict?.status] || LEVEL_STYLE['판단불가'];
  const th = verdict?.thresholds_used;

  const inputStyle = {
    width: '96px', background: COLORS.card, color: COLORS.textPrimary,
    border: `1px solid ${COLORS.border}`, borderRadius: '8px', padding: '10px 12px', fontSize: '14.5px',
  };
  // 백엔드가 응답 중일 땐 서버가 DB 실측치로 직접 판정하고 이 값은 요청에 아예 안 실린다
  // (postJson('/weather/assess', ...) 참고, wind_speed/wave_height 필드 자체가 없음) —
  // 그런데도 입력창이 활성화돼 있으면 "값을 바꿔도 판정이 안 바뀐다"는 오해를 산다.
  // 백엔드 미응답(로컬 폴백)일 때만 실제로 이 값을 쓰므로 그때만 편집 가능하게 한다.
  const usingBackend = Boolean(verdict && !verdict.is_local_fallback);
  const disabledInputStyle = usingBackend
    ? { ...inputStyle, opacity: 0.5, cursor: 'not-allowed' }
    : inputStyle;

  return (
    <div
      ref={rootRef}
      className="glass-card"
      style={{
        transition: 'box-shadow 0.4s, border-color 0.4s',
        ...(flash ? { boxShadow: `0 0 0 2px ${COLORS.teal}, 0 0 18px ${COLORS.teal}55` } : {}),
      }}
    >
      <div className="glass-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="glass-card-title"><FaAnchor style={{ marginRight: '8px', color: COLORS.teal }} />부두 기상 판정<AgentChip agent="weather" /></h3>
        <span style={{ fontSize: '12px', color: COLORS.textDim }}>부두그룹별 실측 기준 · 정상 → 하역중단 → 이안 → 호스분리 4단계</span>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '16px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: COLORS.textSecondary }}>
          선석군
          <select value={berthGroup} onChange={(e) => setBerthGroup(e.target.value)}
            style={{ ...inputStyle, width: '220px' }}>
            {berthGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        {/* 폴백 입력 — 백엔드가 붙어 있으면 판정에 쓰이지 않으므로 숨긴다 */}
        {!usingBackend && (
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: COLORS.textSecondary }}
          title={usingBackend ? '실측 관측값으로 판정 중 — 이 입력은 판정 서버가 응답하지 않을 때만 쓰입니다' : undefined}
        >
          풍속 (m/s)
          <input type="number" step="0.1" value={windSpeed} disabled={usingBackend}
            onChange={(e) => setWindSpeed(e.target.value)} style={disabledInputStyle} />
        </label>
        )}
        {/* 파고도 풍속과 같은 폴백 입력 — 백엔드가 붙어 있을 때 이 칸만 남아 있어
            "값을 바꿔도 판정이 안 바뀐다"고 오해를 샀다(2026-09-26 캡처). */}
        {!usingBackend && (
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: COLORS.textSecondary }}
        >
          파고 (m)
          <input type="number" step="0.1" value={waveHeight}
            onChange={(e) => setWaveHeight(e.target.value)} style={disabledInputStyle} />
        </label>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12.5px' }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer',
            color: precipObserved ? COLORS.yellow : COLORS.textSecondary, fontWeight: precipObserved ? 700 : 400,
          }}>
            <input type="checkbox" checked={precipObserved}
              onChange={(e) => setPrecipObserved(e.target.checked)}
              style={{ accentColor: COLORS.yellow, width: 15, height: 15, cursor: 'pointer' }} />
            🌧 강수 육안 확인 (관제사)
          </label>
          <label style={{
            display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer',
            color: extraCondition ? COLORS.red : COLORS.textSecondary, fontWeight: extraCondition ? 700 : 400,
          }}>
            <input type="checkbox" checked={extraCondition}
              onChange={(e) => setExtraCondition(e.target.checked)}
              style={{ accentColor: COLORS.red, width: 15, height: 15, cursor: 'pointer' }} />
            ⚠ 특별 기상조건 (뇌우·태풍경로 등)
          </label>
        </div>
        {/* 폴백일 때만 수동 판정이 의미 있다 — 백엔드 연결 시에는 선석군 변경·
            체크박스 토글이 이미 자동 재판정하므로 눌러도 결과가 같다. */}
        {!usingBackend && (
        <button onClick={run} style={{
          background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.tealDark})`, color: '#FFFFFF',
          border: 'none', borderRadius: '8px', padding: '9px 20px', fontWeight: 700, cursor: 'pointer', fontSize: '14px',
        }}>
          판정
        </button>
        )}
      </div>

      {verdict && (
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{
            minWidth: '210px', textAlign: 'center', padding: '22px 20px',
            background: COLORS.card, border: `2px solid ${style.color}`, borderRadius: '12px',
          }}>
            <div style={{ fontSize: '34px', fontWeight: 800, color: style.color, lineHeight: 1.15 }}>{verdict.status}</div>
            <div style={{ fontSize: '13px', color: COLORS.textSecondary, marginTop: '6px' }}>{style.label}</div>
          </div>

          <div style={{ flex: 1, minWidth: '260px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <ThresholdChip name="중단" t={th?.stop} />
              <ThresholdChip name="이안" t={th?.unberth} />
              <ThresholdChip name="호스분리" t={th?.disconnect} />
              {th?.source && (
                <span style={{ fontSize: '11px', color: COLORS.textDim, alignSelf: 'center' }}>출처 {th.source}</span>
              )}
            </div>
            {verdict.observed && (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary }}>
                판정 기준 실측:{' '}
                <strong style={{ color: COLORS.textPrimary }}>
                  풍속 {verdict.observed.wind ?? '-'} m/s · 파고 {verdict.observed.wave ?? '-'} m
                </strong>
                {verdict.observed.station && ` (${verdict.observed.station})`}
                {verdict.observed.observed_at_utc && ` · ${new Date(verdict.observed.observed_at_utc)
                  .toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} KST`}
                {verdict.observed.is_stale && (
                  <span style={{ color: COLORS.yellow }}> · 관측 오래됨</span>
                )}
              </div>
            )}
            <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: COLORS.textPrimary, lineHeight: 1.8 }}>
              {(verdict.reasons || []).map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            {precipObserved && (
              <div style={{
                fontSize: '12px', color: COLORS.yellow, background: `${COLORS.yellow}14`,
                border: `1px solid ${COLORS.yellow}44`, borderRadius: '8px', padding: '7px 10px', lineHeight: 1.6,
              }}>
                🌧 <strong>강수 판정 근거</strong> — 산업안전보건기준에 관한 규칙 제383조 제2호 준용
                (강우 1mm/h 이상 작업중지 · 20mm/h 이안 · 30mm/h 호스분리).
                강수 실황은 관측 API가 없어 <strong>관제사 육안 확인</strong>을 입력으로 사용합니다.
              </div>
            )}
            <div style={{ fontSize: '11px', color: COLORS.textDim }}>
              {verdict.is_local_fallback
                ? '※ 관측값을 받지 못해 위 입력값으로 계산한 결과입니다'
                : '※ 실측 관측값으로 판정했습니다'}
            </div>
            {verdict.forecast_warning && (
              <div style={{ fontSize: '13px', color: COLORS.yellow, display: 'flex', gap: '6px', alignItems: 'center' }}>
                <FaExclamationTriangle /> {verdict.forecast_warning}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
