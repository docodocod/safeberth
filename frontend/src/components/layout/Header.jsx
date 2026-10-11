import { useEffect, useState } from 'react';
import useDashboardData from '../../hooks/useDashboardData';
import AlertBell from './AlertBell';
import { FaCloudSun, FaDatabase } from 'react-icons/fa';

const kstTime = (utc) => {
  if (!utc) return null;
  return new Date(utc).toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul',
  });
};

// ─────────────────────────────────────────────
// 데이터 신선도 배지 (mart.pipeline_health)
// "수집기가 죽었는가"와 "원천(공공데이터포털)이 멈췄는가"는 다른 사고다.
// 2026-08-04 실증: 포털 무응답 8.8일 동안 수집기는 정상 — 이 구분이 없으면
// 시연 중 "왜 배가 안 움직이죠?"에 답할 수 없다. fail-safe 설계의 시각적 증거.
// ─────────────────────────────────────────────
const ageLabel = (min) => {
  if (min == null) return '기록 없음';
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.round(min / 60)}시간 전`;
  return `${(min / 60 / 24).toFixed(1)}일 전`;
};

function freshness(ph) {
  if (!ph) return null;
  // 수집기 자체가 멈춤 (2시간 이상 수집 기록 없음) — 우리 쪽 장애
  if (ph.collect_age_min == null || ph.collect_age_min > 120) {
    return { color: '#ff4b6e', label: '수집기 정지', detail: `마지막 수집 ${ageLabel(ph.collect_age_min)}` };
  }
  // 수집은 도는데 원천 데이터가 오래됨 — 공공데이터포털 쪽 장애
  if (ph.source_age_min != null && ph.source_age_min > 60 * 24) {
    return { color: '#f59e0b', label: `원천 정지 ${ageLabel(ph.source_age_min)}`, detail: '수집기는 정상 — 공공데이터포털 원천 데이터가 갱신되지 않고 있습니다' };
  }
  return { color: '#20e3b2', label: `수집 정상 · ${ageLabel(ph.collect_age_min)}`, detail: `원천 관측 ${ageLabel(ph.source_age_min)} · 수집 ${ageLabel(ph.collect_age_min)}` };
}

export default function Header() {
  // 연결 상태는 실제 데이터 폴링 성공 여부로 판단한다.
  // (구 WebSocket 채널은 사용하지 않아 항상 '끊김'으로 보이던 문제 수정)
  const { data, error } = useDashboardData();
  const connected = !error && !!data;
  const w = data?.weather;
  const observedKst = kstTime(w?.observed_at_utc);
  const fresh = freshness(data?.stats?.pipeline_health);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="header">
      <div className="header-left">
        <div className="header-title">울산항 액체화물 하역 스케줄링 및 안전 관제</div>
      </div>

      <div className="header-right">
        <div
          className="header-badge weather-badge"
          title={observedKst ? `관측 ${observedKst} (KST)${w?.is_stale ? ' — 3시간 초과, 갱신 필요' : ''}` : '기상 데이터 없음'}
        >
          <FaCloudSun color={w?.is_stale ? '#f59e0b' : undefined} />
          <span>
            {w
              ? `풍속 ${w.wind_speed_ms ?? '-'}m/s · 파고 ${w.wave_height_sig_m ?? '-'}m`
              : '기상 로딩 중'}
            {observedKst && (
              <span className="header-sub" style={{ color: w?.is_stale ? '#f59e0b' : '#8ba3b8', marginLeft: 6, fontSize: '11px' }}>
                {observedKst} 관측{w?.is_stale ? ' (오래됨)' : ''}
              </span>
            )}
          </span>
        </div>

        {fresh && (
          <div className="header-badge" title={fresh.detail}>
            <FaDatabase color={fresh.color} />
            <span style={{ color: fresh.color, fontSize: '12px' }}>{fresh.label}</span>
          </div>
        )}

        {/* 관제 경고 — 예전엔 대시보드 본문 상단 카드였다. 재항 전수 판정으로
            건수가 늘면서 첫 화면을 다 먹어 헤더 벨 드롭다운으로 접었다. */}
        <AlertBell />

        <div
          className="header-badge"
          title={connected ? '관제 서버와 연결됨 (3분 주기 갱신)' : `데이터 수신 실패: ${error || '서버 응답 없음'}`}
        >
          <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></div>
          <span>{connected ? '서버 연결' : '연결 끊김'}</span>
        </div>

        <div className="header-badge header-clock" style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
          {currentTime.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' })}
        </div>
      </div>
    </header>
  );
}
