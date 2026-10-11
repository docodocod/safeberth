import { useMemo } from 'react';
import useDashboardData from '../../hooks/useDashboardData';
import { COLORS } from '../../utils/constants';

// [2026-09-27 fix] 모형 진행률 목록을 걷어낼 때 이 함수까지 같이 지워져, 접안 이력이 있는 환경에서
// HistoryGantt 가 ReferenceError 로 선박 판정 화면을 통째로 비웠다(배포 서버는 이력이 비어 있어 캡처 때 안 드러남).
const fmtKST = (utc, withDate = true) =>
  utc
    ? new Date(utc).toLocaleString('ko-KR', {
        ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul',
      })
    : '-';

// 실데이터 접안 이력 간트 (upa_port_call 실기록) — 부두별 그룹
//
// 이영서 요청(2026-08-17): "부두 별로 그룹화하면 현황이 더 잘 드러나지 않을까"
//
// 예전에는 선박 한 척이 한 줄이라 같은 부두 기록이 목록 곳곳에 흩어졌다. 그러면
// "이 부두가 얼마나 붐비나 / 언제 비나"가 안 보인다 — 선석 배정을 판단하려면
// 부두가 축이어야 한다. 이제 부두 한 줄에 그 부두의 접안 구간을 모두 겹쳐 그리고,
// 접안 건수가 많은 부두를 위로 올린다.
function HistoryGantt({ records }) {
  const { t0, span, groups } = useMemo(() => {
    const begins = records.map((r) => new Date(r.begin_utc).getTime());
    const ends = records.map((r) => new Date(r.end_utc).getTime());
    const min = Math.min(...begins);
    const max = Math.max(...ends);

    const byBerth = new Map();
    for (const r of records) {
      const key = r.berth || '(부두 미상)';
      if (!byBerth.has(key)) byBerth.set(key, []);
      byBerth.get(key).push(r);
    }
    // 접안 건수 많은 부두 먼저 — 붐비는 곳이 위로 온다
    const sorted = [...byBerth.entries()]
      .map(([berth, rows]) => ({
        berth,
        rows,
        totalHours: rows.reduce((s, r) => s + (new Date(r.end_utc) - new Date(r.begin_utc)) / 3600000, 0),
      }))
      .sort((a, b) => b.rows.length - a.rows.length || b.totalHours - a.totalHours);

    return { t0: min, span: Math.max(1, max - min), groups: sorted, t1: max };
  }, [records]);

  const t1 = t0 + span;

  return (
    <div>
      {groups.map((g) => (
        <div key={g.berth} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' }}>
          <div style={{ width: '210px', flexShrink: 0, fontSize: '12px' }}>
            <span style={{ fontWeight: 700 }}>{g.berth}</span>
            <span style={{ color: COLORS.textSecondary }}> · {g.rows.length}건</span>
          </div>
          {/* 한 줄 = 한 부두. 그 부두의 접안 구간을 모두 이 트랙 위에 얹는다. */}
          <div style={{
            flex: 1, position: 'relative', height: '18px',
            background: 'rgba(11, 74, 143, 0.05)', borderRadius: '4px',
          }}>
            {g.rows.map((r) => {
              const b = new Date(r.begin_utc).getTime();
              const e = new Date(r.end_utc).getTime();
              const left = ((b - t0) / span) * 100;
              const width = Math.max(1.2, ((e - b) / span) * 100);
              const hours = ((e - b) / 3600000).toFixed(1);
              return (
                <div
                  key={r.job_id}
                  title={`${r.vessel_name}\n${fmtKST(r.begin_utc)} → ${fmtKST(r.end_utc)} (KST) · ${hours}시간 접안`}
                  style={{
                    position: 'absolute', left: `${left}%`, width: `${width}%`,
                    top: 3, height: 12,
                    background: COLORS.info, opacity: 0.8, borderRadius: '3px',
                  }}
                />
              );
            })}
          </div>
          <span style={{ flexShrink: 0, fontSize: '11px', color: COLORS.textDim, width: '58px', textAlign: 'right' }}>
            {g.totalHours.toFixed(0)}h
          </span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', color: COLORS.textDim, marginTop: '4px', paddingLeft: '220px' }}>
        <span>{fmtKST(new Date(t0).toISOString())}</span>
        <span>{fmtKST(new Date(t1).toISOString())} (KST)</span>
      </div>
    </div>
  );
}

// [2026-09-27] "진행 중/예정 작업" 모형 목록(진행률 데모값·시뮬레이션 배정 행)을 뺐다.
// 유량계가 없어 진행률의 실측 소스가 없는데 막대를 그리면, 실데이터로 채운 나머지 화면까지
// 같이 의심받는다(화면_한계명시 §1). 남긴 것은 실수집 접안 이력뿐이고, 대시보드에서
// 선박 판정 화면(선석 점유 아래)으로 옮겼다 — 선석이 축인 정보라 그 화면 몫이다.
export default function GanttChart() {
  const { data } = useDashboardData();
  const ops = data?.operations ?? [];
  const stats = data?.stats;
  const isRealHistory = data?.data_source?.history === 'REAL';
  const history = ops.filter((o) => o.is_real_record);

  return (
    <div className="glass-card full-width">
      <div className="glass-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <h3 className="glass-card-title">
          부두별 접안 이력
          <span style={{ fontWeight: 400, fontSize: '12px', color: COLORS.textDim, marginLeft: '8px' }}>
            참고 · 판정에는 쓰지 않음{isRealHistory ? ' · 실수집' : ''}
          </span>
        </h3>
        {stats?.total_port_calls != null && (
          <span style={{ fontSize: '12px', color: COLORS.textSecondary, display: 'inline-flex', alignItems: 'center' }}
            title="입출항 신고 기록 전체 중, 신고된 계류시설이 선석 기준자료와 맞아 어느 선석인지 확인된 기록만 막대로 그립니다. 나머지는 정박지·시설명 미확인 기록입니다.">
            입출항 신고 <strong style={{ color: COLORS.teal, margin: '0 3px' }}>{stats.total_port_calls.toLocaleString()}</strong>건
            {stats.port_calls_by_facility_type?.BERTH != null && (
              <> 중 선석 확인 <strong style={{ color: COLORS.teal, margin: '0 3px' }}>{stats.port_calls_by_facility_type.BERTH.toLocaleString()}</strong>건 표시</>
            )}
          </span>
        )}
      </div>
      {history.length > 0
        ? <HistoryGantt records={history} />
        : <p style={{ color: COLORS.textDim, fontSize: '13px', margin: 0 }}>접안 이력이 아직 없습니다.</p>}
    </div>
  );
}
