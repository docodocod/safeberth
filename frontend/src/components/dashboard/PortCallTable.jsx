import { useEffect, useMemo, useState } from 'react';
import useDashboardData from '../../hooks/useDashboardData';
import useSensorStore from '../../stores/useSensorStore';
import { COLORS, NAV_STATUS } from '../../utils/constants';
import HelpTip from '../common/HelpTip';
import DemoChip from '../common/DemoChip';
import { useDemoCargo } from '../../utils/demoCargo';
import { cargoNames, cargoSummary, cargoFit } from '../../utils/cargoText';

const formatKST = (utcString) => {
  if (!utcString) return '-';
  return new Date(utcString).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Seoul',
  }).replace(/\.\s*/g, '.').replace(/\.(\d\d:\d\d)$/, ' $1');   // "09. 28. 23:41" → "09.28 23:41" (열 폭 절약)
};

const cellStyle = {
  padding: '13px 14px', fontSize: '14px', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
};
const headStyle = {
  ...cellStyle,
  fontSize: '13px',
  color: COLORS.textSecondary,
  fontWeight: 'bold',
  textAlign: 'left',
  borderBottom: `1px solid ${COLORS.border}`,
  userSelect: 'none',
  cursor: 'pointer',
};

const PAGE_SIZE = 12;

// ─────────────────────────────────────────────────────────────────────────────
// 화물 구분 — AIS 선박을 "우리가 다루는 배"와 "그 밖"으로 나눈다.
//
// 중요한 건 3분류라는 점이다. 액체화물선의 나머지는 일반화물선이 아니라
// 대부분 "선종을 모르는 배"다(실측 2026-08-15, 재항 356척 중 271척).
//
// 왜 모르나 — 선종은 PORT-MIS 에만 있고 AIS 에는 없다. 그런데 PORT-MIS 에는
// MMSI 컬럼이 아예 없어서 호출부호로만 붙일 수 있고, AIS 호출부호는 선택 필드라
// 74척은 빈 값이다. 게다가 두 모집단이 다르다 — AIS 는 울산 앞바다의 모든 이동체
// (예선·급유선·통항선)를 잡고, PORT-MIS 는 입항신고를 한 배만 담는다.
//
// 이 셋을 "일반화물"로 뭉뚱그리면 모르는 걸 안다고 말하는 셈이라 따로 둔다.
// ─────────────────────────────────────────────────────────────────────────────
const CARGO_FILTERS = [
  { key: 'ALL', label: '전체', hint: '위치가 수신된 선박 전부' },
  {
    key: 'LIQUID',
    label: '액체화물선',
    hint: 'PORT-MIS 선종이 액체화물선이거나, 재항 위험물 신고가 확인된 배 — 하역 스케줄링 대상',
    test: (v) => v.is_liquid_cargo_vessel,
  },
  {
    key: 'OTHER',
    label: '일반화물선',
    hint: 'PORT-MIS 선종이 액체화물선이 아니라고 확인된 배',
    test: (v) => v.liquid_by_ship_type === false && !v.has_dg_cargo,
  },
  {
    key: 'UNKNOWN',
    label: '선종 미확인',
    hint: 'PORT-MIS 대조가 안 된 배 — 일반화물선이 아니라 "모름"이다 (호출부호 결측 등)',
    test: (v) => v.liquid_by_ship_type == null && !v.has_dg_cargo,
  },
];

/** 화물 셀 표기 — 모르는 것을 아는 것처럼 적지 않는다 */
function cargoLabel(v) {
  // 입항 건 화물이 여럿이면 'A, B 외 N종' — 전체 목록은 칸 title 로.
  if (v.cargo) {
    const all = cargoNames(v.cargos);
    return all.length > 1
      ? { text: cargoFit(v.cargos, 15), title: all.join(', '), dim: false }
      : { text: `${v.cargo.name} (${v.cargo.un_no})`, dim: false };
  }
  // 호출부호가 다른 배와 겹치면 화물·선종을 붙일 수 없다. 왜 비었는지 적어준다.
  if (v.callsgn_ambiguous) return { text: '호출부호 중복 — 대조 불가', dim: true };
  if (v.liquid_by_ship_type === true) return { text: '액체화물선 · 화물 미확인', dim: true };
  if (v.liquid_by_ship_type === false) return { text: '일반화물', dim: true };
  return { text: '미확인', dim: true };
}

// 컬럼별 정렬값 추출 — real_traffic(backendAdapter.mapVessel) 필드 기준.
// 문자열/숫자를 섞어 반환해도 compareVessels가 타입에 맞게 비교한다.
// width: table-layout:fixed 에서 쓸 고정 비율 (합계 100%) — 정렬 시 내용 길이에 따라
// 컬럼 폭이 흔들리던 문제를 없애기 위함.
const COLUMNS = [
  { key: 'vessel_name', label: '선박명', width: '22%', getValue: (v) => v.vessel_name ?? '' },
  { key: 'callsgn', label: '호출부호', width: '9%', getValue: (v) => v.callsgn ?? '' },
  // 선종은 PORT-MIS 공식 선종코드(51종). 액체/일반 구분의 근거를 화면에 그대로 둔다 —
  // 뱃지만 있으면 "왜 이 배가 위험물선인가"를 물었을 때 답할 근거가 화면에 없다.
  { key: 'ship_kind_nm', label: '선종', width: '12%', getValue: (v) => v.ship_kind_nm ?? '' },
  { key: 'nav_status_category', label: '상태', width: '10%', getValue: (v) => (NAV_STATUS[v.nav_status_category] || NAV_STATUS.UNKNOWN).label },
  { key: 'cargo', label: '화물', width: '17%', getValue: (v) => (v.cargo ? cargoSummary(v.cargos?.length ? v.cargos : [v.cargo]) : '') },
  // AIS 위치로 본 계류 위치(선석·정박지) — 배정이 아니다(2026-09-29 라벨 수정)
  { key: 'berth', label: '계류 위치', width: '10%', getValue: (v) => v.berth ?? (v.anchorage ? `정박지 ${v.anchorage}` : '') },
  { key: 'sog', label: '속력', width: '7%', getValue: (v) => v.sog ?? 0 },
  { key: 'received_at_utc', label: '최근 수신', width: '13%', getValue: (v) => (v.received_at_utc ? new Date(v.received_at_utc).getTime() : 0) },
];

function compareVessels(a, b, getValue) {
  const av = getValue(a);
  const bv = getValue(b);
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av).localeCompare(String(bv), 'ko');
}

export default function PortCallTable() {
  const demo = useDemoCargo();
  const { data } = useDashboardData();
  const setSelectedVessel = useSensorStore((s) => s.setSelectedVessel);
  const tracked = useSensorStore((s) => s.trackedVessel);

  // 최근 수신 순 기본 정렬 — 이전 동작(입항 최신순 정렬)과 동일한 기본값 유지.
  const [sort, setSort] = useState({ key: 'received_at_utc', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [cargoFilter, setCargoFilter] = useState('LIQUID');

  const handleSort = (key) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    setPage(1);
  };

  // 실데이터(data.real_traffic, backendAdapter.mapVessel) 사용 — mock인 data.vessels는 미사용.
  const allVessels = data?.real_traffic ?? [];
  const aisTotal = data?.real_traffic_total ?? allVessels.length;

  // 탭에 건수를 같이 적는다 — 필터를 눌러보기 전에 "액체화물선이 몇 척인지"와
  // "모르는 배가 몇 척인지"가 한눈에 보여야 숫자를 오해하지 않는다.
  const filterCounts = useMemo(() => {
    const counts = {};
    for (const f of CARGO_FILTERS) {
      counts[f.key] = f.test ? allVessels.filter(f.test).length : allVessels.length;
    }
    return counts;
  }, [allVessels]);

  const vessels = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key);
    const active = CARGO_FILTERS.find((f) => f.key === cargoFilter);
    const list = active?.test ? allVessels.filter(active.test) : [...allVessels];
    list.sort((a, b) => {
      const cmp = compareVessels(a, b, col.getValue);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [allVessels, sort, cargoFilter]);

  const totalPages = Math.max(1, Math.ceil(vessels.length / PAGE_SIZE));
  // 정렬/데이터 갱신으로 목록이 줄어들면 마지막 페이지로 보정
  const currentPage = Math.min(page, totalPages);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [currentPage, page]);
  const pageVessels = vessels.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="glass-card">
      <div className="glass-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <h3 className="glass-card-title" style={{ display: 'flex', alignItems: 'center' }}>
          항내 선박 목록
          <HelpTip title="항내 선박 목록">
            항만공사 선박위치로 지금 울산항 안에 있는 선박입니다. 입항 신고 기준의 판정은 선박 판정 화면에서 봅니다.
          </HelpTip>
        </h3>
        {/* 관제 선박 KPI(전체)와 이 표의 척수가 다른 이유를 화면에서 말해준다 —
            real_traffic 은 지도 성능 상한(MAP_VESSEL_LIMIT=200)까지만 내려온다. */}
        <span style={{ fontSize: '13px', color: COLORS.textDim }}>
          {aisTotal > filterCounts.ALL
            ? `선박위치 ${aisTotal}척 중 최근 수신 ${filterCounts.ALL}척 · 표시 ${vessels.length}척`
            : `선박위치 ${filterCounts.ALL}척 · 표시 ${vessels.length}척`}
        </span>
      </div>

      {/* 화물 구분 필터 */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {CARGO_FILTERS.map((f) => {
          const on = cargoFilter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              title={f.hint}
              onClick={() => { setCargoFilter(f.key); setPage(1); }}
              style={{
                border: `1px solid ${on ? COLORS.teal : COLORS.border}`,
                background: on ? 'rgba(0, 212, 170, 0.12)' : 'transparent',
                color: on ? COLORS.teal : COLORS.textSecondary,
                borderRadius: '999px', padding: '7px 17px', fontSize: '13px',
                fontWeight: on ? 800 : 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {f.label} {filterCounts[f.key]}
            </button>
          );
        })}
      </div>
      {cargoFilter === 'UNKNOWN' && (
        <div style={{ fontSize: '11.5px', color: COLORS.textDim, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* [2026-09-30] 설명은 도움말로 — 줄글이 목록 위를 차지했다(현우) */}
          선종을 <b>모르는</b> 배입니다
          <HelpTip title="선종 미확인">
            <div>일반화물선이라는 뜻이 아닙니다. 선종은 PORT-MIS 입항 신고에만 있고 AIS(선박위치)에는 없습니다.</div>
            <div style={{ marginTop: 4 }}>PORT-MIS 에 MMSI 가 없어 호출부호로만 두 자료를 맞추는데, AIS 호출부호는 선택 항목이라 빠진 배가 많고, 예선 · 급유선처럼 입항 신고 대상이 아닌 배도 섞입니다.</div>
          </HelpTip>
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', color: COLORS.textPrimary }}>
          <colgroup>
            {COLUMNS.map((col) => <col key={col.key} style={{ width: col.width }} />)}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} style={headStyle} onClick={() => handleSort(col.key)} title="클릭하면 정렬됩니다">
                  {col.label}
                  {sort.key === col.key && (
                    <span style={{ marginLeft: '4px', color: COLORS.teal }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageVessels.map((v) => {
              const status = NAV_STATUS[v.nav_status_category] || NAV_STATUS.UNKNOWN;
              const cargo = cargoLabel(v);
              return (
                <tr
                  key={v.port_call_id}
                  className={tracked?.callsgn && tracked.callsgn === v.callsgn ? 'row-track' : undefined}
                  onClick={() => setSelectedVessel(v)}
                  style={{ borderBottom: `1px solid rgba(78, 205, 196, 0.06)`, cursor: 'pointer' }}
                  title="클릭하면 선박 상세 패널이 열립니다"
                >
                  <td style={{ ...cellStyle, fontWeight: 'bold' }}>
                    {v.vessel_name}
                    {/* 뱃지는 근거가 다르면 다르게 적는다 — 신고된 위험물이 붙은 배와
                        선종만 액체화물선인 배를 같은 "위험물"로 적으면 안 된다. */}
                    {v.has_dg_cargo && (
                      <span
                        title="재항 위험물 신고가 확인된 배"
                        style={{
                          marginLeft: '8px', background: COLORS.red, color: '#fff',
                          borderRadius: '4px', padding: '1px 6px', fontSize: '11px',
                        }}
                      >위험물</span>
                    )}
                    {!v.has_dg_cargo && v.liquid_by_ship_type === true && (
                      <span
                        title="PORT-MIS 선종은 액체화물선이지만, 지금 재항 위험물 신고는 확인되지 않았다"
                        style={{
                          marginLeft: '8px', border: `1px solid ${COLORS.yellow}`, color: COLORS.yellow,
                          borderRadius: '4px', padding: '0 6px', fontSize: '11px',
                        }}
                      >액체</span>
                    )}
                  </td>
                  <td style={{ ...cellStyle, color: v.callsgn_ambiguous ? COLORS.yellow : COLORS.textSecondary }}>
                    {v.callsgn || <span style={{ color: COLORS.textDim }}>미수신</span>}
                    {v.callsgn_ambiguous && (
                      <span title="같은 호출부호를 쓰는 배가 둘 이상이라 선종·화물을 대조할 수 없습니다 (AIS 원문 입력값 문제)"> ⚠</span>
                    )}
                  </td>
                  <td style={{ ...cellStyle, color: v.ship_kind_nm ? COLORS.textPrimary : COLORS.textDim }}>
                    {v.ship_kind_nm || '미확인'}
                  </td>
                  <td style={cellStyle}>
                    <span style={{
                      color: status.color, border: `1px solid ${status.color}`,
                      borderRadius: '999px', padding: '3px 12px', fontSize: '12.5px',
                    }}>
                      {status.label}
                    </span>
                  </td>
                  <td style={{ ...cellStyle, color: cargo.dim ? COLORS.textDim : COLORS.textPrimary }} title={cargo.title}>
                    {cargo.text}
                    {' '}<DemoChip entries={demo.ofShip(v.callsgn)} />
                  </td>
                  <td style={cellStyle}>
                    {v.berth
                      ? v.berth
                      : v.anchorage
                        ? <span style={{ color: COLORS.yellow }}>정박지 {v.anchorage} 대기</span>
                        : <span style={{ color: COLORS.textDim }}>-</span>}
                  </td>
                  <td style={{ ...cellStyle, color: COLORS.textSecondary }}>{v.sog} kn</td>
                  <td style={{ ...cellStyle, color: COLORS.textSecondary }}>{formatKST(v.received_at_utc)}</td>
                </tr>
              );
            })}
            {pageVessels.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} style={{ ...cellStyle, color: COLORS.textDim, textAlign: 'center', padding: '24px' }}>
                  표시할 선박이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', padding: '10px 0 4px' }}>
          <button
            onClick={() => setPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            style={pagerButtonStyle(currentPage <= 1)}
          >
            이전
          </button>
          <span style={{ fontSize: '13px', color: COLORS.textSecondary }}>
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            style={pagerButtonStyle(currentPage >= totalPages)}
          >
            다음
          </button>
        </div>
      )}
    </div>
  );
}

function pagerButtonStyle(disabled) {
  return {
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    color: disabled ? COLORS.textDim : COLORS.textPrimary,
    borderRadius: '6px',
    padding: '4px 12px',
    fontSize: '12px',
    cursor: disabled ? 'default' : 'pointer',
  };
}
