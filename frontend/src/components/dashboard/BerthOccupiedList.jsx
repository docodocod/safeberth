import { useCallback, useEffect, useState } from 'react';
import { fetchBerthAssignments, postAssessAndRecord } from '../../api/backendAdapter';
import useDashboardData from '../../hooks/useDashboardData';
import { COLORS } from '../../utils/constants';
import { cargoFit } from '../../utils/cargoText';
import HelpTip from '../common/HelpTip';
import DemoChip from '../common/DemoChip';
import SyntheticChip from '../common/SyntheticChip';
import { useDemoCargo } from '../../utils/demoCargo';
import useSensorStore from '../../stores/useSensorStore';
import { VERDICT_COLOR as SHARED_VERDICT_COLOR } from '../../utils/verdict';

// 'MM.DD HH:mm' — 표 칸에 들어가게 짧게(예전 '2026. 9. 29. 12시 0분 0초'는 두 줄로 꺾였다)
function formatKST(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 판정 등급 색 — 지도 팝업(BerthAssignmentMap VERDICT_BG)과 같은 값을 쓴다.
// 두 화면이 같은 등급을 다른 색으로 칠하면 관제사가 둘을 대조할 수 없다.
// [2026-09-29 밤] 화면 공용 판정 색(utils/verdict) — 판정불가는 보라로 통일
const VERDICT_COLOR = SHARED_VERDICT_COLOR;

// 실제 입출항(portmis_vessel 우선, 없으면 upa_port_call, call_sign 대조)을 쓴다.
//
// departure_scheduled_utc는 PORT-MIS가 입항 시점에 이미 받아 둔 출항 신고
// 시각이다 — 아직 실제 출항 전이어도 "언제쯤 이 자리가 빌지" 보여줄 수 있다
// (2026-08-20, "출항시간 기준으로 자리를 비워야" 요청).
//
// [2026-09-22] planned_window(window_start/window_end) 대체 경로를 걷어냈다.
// 그 두 필드는 예약(berth_assignment)이 있던 시절의 것이고 지금
// GET /dashboard/berth-assignments 응답에 아예 없다(실측 — 슬롯 키 22개 중
// 없음). 없는 필드를 보는 분기라 한 번도 탄 적이 없다. 입항 실측이 아직
// 안 잡힌 배는 '-'가 아니라 접안 판정 근거를 대신 적는다 — 그 배가 왜
// 여기 있다고 보는지는 말할 수 있어야 한다.
// [2026-09-29] PORT-MIS 출항 시각은 미리 신고되는 값이라 actual_departure_utc 에도 미래 시각이 온다
//   (실측: 창용1호 9/30 23시가 '출항'으로 표시). 지났는지로 '출항'과 '출항예정'을 가른다.
const departureOf = (row) => row.actual_departure_utc || row.departure_scheduled_utc || null;

function periodLabel(row) {
  if (row.actual_arrival_utc) {
    const dep = departureOf(row);
    const departurePart = !dep
      ? '(재항 중)'
      : new Date(dep).getTime() <= Date.now()
        ? `출항 ${formatKST(dep)}`
        : `${formatKST(dep)} 출항 예정`;
    return `${formatKST(row.actual_arrival_utc)} 입항 → ${departurePart}`;
  }
  // PORT-MIS 입출항 신고가 아직 안 잡힌 배 — 위치 판정으로만 접안을 안다.
  if (row.berth_basis) {
    const age = row.position_age_min != null ? ` · ${row.position_age_min}분 전` : '';
    return `입항 신고 없음 · ${row.berth_basis} 판정${age}`;
  }
  return '-';
}

// 나갔어야 할 시각이 지났는데 아직 이 자리에 잡혀 있는 배가 며칠째인지.
// 실제 항만에서는 출항하면 그 자리가 바로 비고 다음 배가 들어온다 — 출항
// 예정이 지났는데 여전히 "점유 중"이면 그건 현재 상태가 아니라 닫히지 않은
// 기록일 수 있다. 화면이 그걸 "지금 접안 중"인 것처럼 보여주면 안 되므로
// 경과일을 같이 띄운다(2026-09-08 실측 — 7건 전부 8/25에 기간이 끝나 있었다).
//
// [2026-09-22] 기준을 window_end -> departure_scheduled_utc 로 바꿨다.
// window_end 는 응답에 없는 필드라 이 함수는 추가된 커밋(27aa32a, "배정 경과일
// 표시")부터 지금까지 **항상 0** 이었다 — 뱃지가 한 번도 뜬 적이 없다.
// departure_scheduled_utc 는 PORT-MIS 출항 신고 시각이고 실제로 내려온다
// (실측 3건 모두 값 있음). "언제 나가기로 했나"가 곧 "언제 비었어야 하나"다.
//
// [2026-09-29] actual_departure_utc 가 있어도 본다. 이 목록은 AIS 로 **지금 붙어 있는** 배라, 출항 시각이
//   지났다는 것 자체가 확인할 일이다 — 예전엔 "실제로 나갔으면 경과가 아니다"로 빼서, 출항 9/28 인
//   우선호가 9/29 에도 표시 없이 접안 중으로 보였다. 하루가 안 됐으면 시간으로 센다.
function overdueLabel(row) {
  const dep = departureOf(row);
  if (!dep) return null;
  const hours = Math.floor((Date.now() - new Date(dep).getTime()) / 3600000);
  if (hours < 1) return null;
  return hours >= 24 ? `${Math.floor(hours / 24)}일` : `${hours}시간`;
}

// 08_스케줄링_전면재설계_자동배정_설계문서.md §7.2 — 선석 배정현황 페이지.
// 지도는 "어디"를, 아래 목록은 "지금 뭐가 차 있는지"를 보여주는 읽기전용
// 화면이다 — 승인/반려는 여기서 하지 않는다.
//
// [2026-08-19] 승인 액션을 이 페이지에서 뺐다. 원래 지도 팝업(SlotRow)의 승인
// 버튼은 /dashboard/berth-assignments 응답에 assignment_id가 없어 항상
// "undefined"로 호출되며 실패했다(관제사가 실제로 겪은 버그: 승인 눌러도
// [object Object] 에러만 뜸). 게다가 종합에이전트 콘솔(AgentConsole)에도
// 겉보기엔 똑같이 생긴 승인/반려 버튼이 있어, 관제사 입장에서 "어느 쪽이
// 진짜 승인인가"가 애초에 불명확했다. 승인 액션의 유일한 지점을 콘솔 쪽으로
// 정리했다(콘솔은 이미 "종합에이전트 판단 → 관제사 승인"이라는 §5.3 흐름 그대로다).
//
// [2026-08-19 재수정] "승인 대기 목록"(GET /approvals/pending)을 없앴다 — 위
// 지도가 이제 REQUESTED/APPROVED를 구분하지 않고 "점유 여부"만 보여주는
// 것과 같은 이유다. 이 목록도 지도와 같은 질문("지금 뭐가 배정돼 있나")에
// 맞춰 GET /dashboard/berth-assignments 기준 점유 목록으로 바꿨다.

// [2026-09-27] 선석 현황 페이지의 목록을 부품으로 떼어 선박 판정 화면(붙어 있는 배)에 붙였다.
// bare — 선박 판정 화면의 '하역 중' 탭 안에 들어갈 때(카드·제목 없이 표만)
export default function BerthOccupiedList({ scope, bare = false }) {
  const [berths, setBerths] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setBerths(await fetchBerthAssignments());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  // 선석×슬롯 구조를 평평한 행 목록으로 편다 — 이 표는 "지금 뭐가 어디 붙어
  // 있나"만 보면 되므로 빈 슬롯은 뺀다.
  const requestConsole = useSensorStore((st) => st.requestConsole);
  const tracked = useSensorStore((st) => st.trackedVessel);
  const trackVessel = useSensorStore((st) => st.trackVessel);
  const demo = useDemoCargo();
  // [2026-09-28] 판정 전 행의 단추를 입항 선박 표와 같은 뜻으로 맞췄다 — "판정 요청"은 서버가 판정해
  // 이력에 기록하고, "근거 →"는 우하단 에이전트 판단 과정을 그 배로 열어 왜 그 결론인지 본다.
  // 예전엔 여기만 '판단 과정 →'이 판정 실행 입구여서 두 표의 단추 뜻이 달랐다(현우 지적).
  // 흘수는 선석 점유 응답에 없어 대시보드 실선박 목록(항만공사 선박위치)에서 찾는다.
  const { data: dash } = useDashboardData();
  const [judging, setJudging] = useState({});
  const draughtOf = (callSign) => {
    const v = (dash?.real_traffic || []).find((t) => (t.callsgn || t.call_sign || '').trim().toUpperCase() === (callSign || '').trim().toUpperCase());
    return v?.draught_m ?? null;
  };
  const cannotJudge = (row) => {
    if (!row.wharf_name) return '계류시설 없음';
    if (!(Number(draughtOf(row.call_sign)) > 0)) return '흘수 없음';
    if (!row.cargo_chem_id) return '화물 미확인';
    return null;
  };
  const setJudgeBusy = useSensorStore((st) => st.setJudgeBusy);
  const focus = useSensorStore((st) => st.reasoningFocus);
  const judge = async (row) => {
    const key = row.call_sign;
    setJudging((m) => ({ ...m, [key]: 'busy' }));
    setJudgeBusy(key, true);
    try {
      await postAssessAndRecord({
        callSign: row.call_sign, vesselName: row.vessel_name, draughtM: draughtOf(row.call_sign),
        chemId: row.cargo_chem_id, cargoName: row.cargo_name, wharfName: row.wharf_name,
        targetSource: 'AIS', // 이 목록은 AIS 로 본 실제 접안 부두다 — 입항 건 키는 백엔드가 지금 입항 건으로 채운다
      });
      setJudging((m) => { const n = { ...m }; delete n[key]; return n; });
      load();
    } catch (e) {
      setJudging((m) => ({ ...m, [key]: { error: e.message } }));
    } finally {
      setJudgeBusy(key, false);
    }
  };
  // 지도와 목록이 같은 스코프를 본다 — 지도만 온산인데 목록은 전체면 숫자가 안 맞는다

  const scopedBerths = scope === 'onsan'
    ? berths.filter((b) => b.port_name === '온산항')
    : berths;
  // [2026-09-22] 점유 판단을 status -> call_sign 으로 바꿨다. 지도가 d681dea 에서
  // 먼저 옮겨간 계약을 이 목록만 따라가지 못하고 있었다.
  //
  //   status 는 이제 **배정 상태가 아니라 판정 등급**(적합/주의/부적합/판정불가)
  //   이고, 아직 판정 전이면 null 이다. 그걸 점유 조건으로 쓰면 "배는 붙어 있는데
  //   판정이 아직 없는" 슬롯이 통째로 사라진다 — 실측으로 접안 6척 중 3척이
  //   목록에서 빠져 있었고, 위 지도는 같은 순간 6을 세고 있었다(6 vs 3).
  //   판정이 하나도 없는 시점이면 배가 붙어 있어도 목록이 완전히 빈다.
  //
  //   "지금 뭐가 차 있나"의 답은 판정 유무가 아니라 배의 유무다.
  const rows = scopedBerths
    .flatMap((b) => b.slots
      .filter((s) => s.call_sign)
      .map((s) => ({ wharf_name: b.wharf_name, ...s })))
    .sort((a, b) => a.wharf_name.localeCompare(b.wharf_name, 'ko'));

  return (
    <div className={bare ? undefined : 'glass-card'}>
      {!bare && <div className="glass-card-header">
        <h3 className="glass-card-title" style={{ display: 'flex', alignItems: 'center' }}>
          접안 선박 · 온산 {rows.length}척
          <HelpTip title="접안 선박">
            지금 온산 선석에 접안한 선박입니다. 입항 신고가 아니라 항만공사 선박위치로 정합니다. 위 표에서 "하역 중"인 선박을 선석 기준으로 본 것입니다.
            판정 칸은 이 배의 최근 판정 등급, 확인자는 그 판정을 본 관제사입니다.
            판정이 없으면 [판정 요청]으로 판정해 이력에 남기고, [근거]로 왜 그 결론인지 봅니다. 입항 선박 표와 같은 버튼입니다.
          </HelpTip>
        </h3>
      </div>}
      {error && <p style={{ color: COLORS.red, fontSize: '13px' }}>{error}</p>}
      {rows.length === 0 ? (
        <p style={{ color: COLORS.textDim, fontSize: '13px' }}>점유 중인 선석이 없습니다.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: COLORS.textDim, borderBottom: `1px solid ${COLORS.border}` }}>
              <th style={{ padding: '6px 8px' }}>선석</th>
              <th style={{ padding: '6px 8px' }}>선박</th>
              <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>화물<SyntheticChip /></th>
              <th style={{ padding: '6px 8px' }}>입출항</th>
              {/* '승인자'가 아니라 '확인자'다 — 이 시스템은 선석을 배정하지 않으므로
                  승인할 대상이 없다. 남는 기록은 "관제사가 이 판정을 봤다"뿐이고,
                  그 값은 acknowledged_by 로 내려온다(응답에 approved_by 는 없다). */}
              <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>확인자</th>
              <th style={{ padding: '6px 8px', minWidth: 150 }}>판정</th>
            </tr>
          </thead>
          <tbody>
            {/* key 는 assignment_id 였는데 그 필드는 응답에 없다(위 2026-08-19
                주석이 이미 적어 둔 사실이다) — 늘 undefined 라, 한 부두에 배가
                둘 붙는 순간 키가 겹친다. 선석·슬롯은 이 표에서 언제나 유일하다. */}
            {rows.map((row) => (
              <tr
                key={`${row.wharf_name}-${row.slot_no}`}
                data-cs={row.call_sign}
                onClick={() => trackVessel({ callsgn: row.call_sign, vessel_name: row.vessel_name })}
                className={[
                  'row-pick',
                  tracked?.callsgn === row.call_sign ? 'row-track' : '',
                  focus?.callsgn === row.call_sign ? 'row-focus' : '',
                  judging[row.call_sign] === 'busy' || (focus?.callsgn === row.call_sign && focus.loading) ? 'row-busy' : '',
                ].join(' ').trim() || undefined}
                style={{ borderBottom: `1px solid ${COLORS.border}` }}
              >
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{row.wharf_name}{row.slot_no ? ` · 슬롯${row.slot_no}` : ''}</td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{row.vessel_name || '(선명 미상)'} <span style={{ color: COLORS.textDim, fontSize: 11.5 }}>{row.call_sign || ''}</span></td>
                <td style={{ padding: '6px 8px', color: COLORS.textSecondary, whiteSpace: 'nowrap' }} title={(row.cargo_names || []).join(', ')}>
                  {(row.cargo_names?.length ? cargoFit(row.cargo_names, 24) : row.cargo_name) || '-'}
                  {' '}<DemoChip entries={demo.ofShip(row.call_sign)} />
                </td>
                <td style={{ padding: '6px 8px', color: COLORS.textDim, whiteSpace: 'nowrap' }}>{periodLabel(row)}</td>
                <td style={{ padding: '6px 8px', color: COLORS.textDim }}>{row.acknowledged_by || '-'}</td>
                <td style={{ padding: '6px 8px' }}>
                  {/* 판정 전인 행에서 바로 콘솔로 — 예전엔 이 화면이 "승인은 협상
                      로그에서"라고 안내만 하고 이동 수단이 없어, 대시보드로 돌아가
                      그 배를 다시 찾아야 했다(③↔④ 왕복). 클릭하면 콘솔이 이
                      실선박을 대상으로 열린다 — 판정은 콘솔에서 새로 실행한다.

                      [2026-09-22] 조건을 status === 'REQUESTED' 에서 "판정이 없다"로
                      바꿨다. status 는 이제 판정 등급이라 'REQUESTED' 가 나올 수
                      없고(backend approvals.py: 적합|주의|부적합|판정불가), 이
                      버튼은 계약이 바뀐 뒤로 한 번도 뜬 적이 없다 — 행에서 콘솔로
                      가는 길이 끊겨 있었다. 지금 콘솔이 필요한 행은 "배는 붙어
                      있는데 아직 판정이 없는" 행이므로, 그 조건이 곧 이 버튼이다. */}
                  {!row.status ? (
                    judging[row.call_sign] === 'busy' ? (
                      <span style={{ color: COLORS.info, fontSize: '12px' }}>판정 중… (10~20초)</span>
                    ) : cannotJudge(row) ? (
                      <span style={{ color: COLORS.purple, fontSize: '12px', whiteSpace: 'nowrap' }} title="판정에 필요한 값이 없습니다 — 판정불가">
                        판정불가 · {cannotJudge(row)}
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                        <button
                          type="button" onClick={() => judge(row)}
                          title="지금 이 선박을 판정합니다 — 결과는 판정 이력에 남습니다"
                          style={{
                            border: `1px solid ${COLORS.navy}`, background: COLORS.card, color: COLORS.navy,
                            borderRadius: 4, padding: '3px 9px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          판정 요청
                        </button>
                        {judging[row.call_sign]?.error && (
                          <span style={{ fontSize: 11, color: COLORS.red, maxWidth: 220 }}>{judging[row.call_sign].error}</span>
                        )}
                      </span>
                    )
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {/* 등급별 색 — 지도 팝업(BerthAssignmentMap VERDICT_BG)과 같은 표다.
                          예전엔 무엇이든 teal(적합 색)로 칠해 '부적합'이 안전해 보였다. */}
                      <span style={{ color: VERDICT_COLOR[row.status] ?? COLORS.textPrimary, fontSize: '12px', fontWeight: 700 }}>
                        {row.status}
                      </span>
                      {row.status !== '적합' && (() => {
                        const d = demo.around(row.call_sign, row.wharf_name);
                        return d.any ? <DemoChip derived entries={[...d.own, ...d.near]} /> : null;
                      })()}
                      <button
                        type="button"
                        onClick={() => requestConsole(row.call_sign, { chem_id: row.cargo_chem_id, name: row.cargo_name }, {
                          subject: {
                            vessel_name: row.vessel_name, wharf: row.wharf_name, draught_m: draughtOf(row.call_sign),
                            cargo: row.cargo_chem_id ? { chem_id: row.cargo_chem_id, name: row.cargo_name } : null,
                          },
                          record: {
                            level: row.status, stage: row.stage, action: row.action, recipient: row.recipient,
                            assessed_at_utc: row.assessed_at_utc, acknowledged_by: row.acknowledged_by,
                          },
                        })}
                        title="왜 이 판정인지 선석 → 기상 → 혼재 순서로 봅니다 — 보고 나서 [판정 확인]을 남깁니다"
                        style={{
                          border: 'none', background: 'transparent', color: COLORS.navy, padding: 0,
                          fontSize: '11.5px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', textDecoration: 'underline',
                        }}
                      >
                        근거
                      </button>
                      {overdueLabel(row) && (
                        <span
                          title="PORT-MIS 출항 시각이 지났는데 AIS 로는 아직 이 선석에 잡혀 있습니다 — 출항 지연이거나 신고·위치 중 하나가 틀렸을 수 있습니다"
                          style={{
                            color: COLORS.yellow, fontSize: '11px', fontWeight: 700,
                            border: `1px solid ${COLORS.yellow}`, borderRadius: '4px', padding: '1px 5px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          출항 시각 {overdueLabel(row)} 지남
                        </span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
