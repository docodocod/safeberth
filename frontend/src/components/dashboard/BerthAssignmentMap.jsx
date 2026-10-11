import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip, Popup, Rectangle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { fetchBerthAssignments } from '../../api/backendAdapter';
import { COLORS, ULSAN_BBOX_BOUNDS } from '../../utils/constants';
import { cargoSummary } from '../../utils/cargoText';

const ONSAN_MAP_CENTER = [35.435, 129.365];
const ONSAN_MAP_ZOOM = 14;
const ONSAN_FIT = { padding: [48, 48], maxZoom: 15 };

// 08_스케줄링_전면재설계_자동배정_설계문서.md §7.2 — 선석 배정현황 전용 지도.
//
// PortMap.jsx 와는 다른 질문에 답한다.
//   PortMap          지금 어디에 무엇이 있나
//   이 화면          그 배가 그 자리에 맞나 (관측 + 판정을 겹쳐 본다)
//
// [2026-09-22] 예전엔 "우리 시스템이 이 선석에 무엇을 배정했는가"였다. 우리는
// 배정하지 않으므로 보여줄 배정이 없다 — 대신 실측 접안(mart.vessel_presence)
// 위에 판정 이력(assessment_history)을 얹는다. 두 화면의 점유 근거는 이제 같고,
// 다른 것은 질문뿐이다.
//
// [2026-08-21] 표시 범위를 온산항(달포부두 포함 15개 선석)으로 좁혔다 —
// 예전엔 울산항 전체 69개를 보여줬는데, 스케줄링 에이전트가 이제 온산항
// 선석에만 배정하도록 바뀌었고(scheduling/graph_queries.py의 onsan_scope 하드
// 필터) PortMap.jsx도 원래 온산만 그린다 — 세 화면(스케줄링·이 지도·PortMap)의
// 범위를 일치시켰다. 범위 자체는 백엔드 GET /dashboard/berth-assignments가
// port_name='온산항'으로 이미 걸러서 내려준다(dashboard.py 참고).
//
// 이 화면은 읽기 전용이다. 판정을 남기고 확인하는 액션은 "에이전트 판단
// 과정"(AgentConsole) 한 곳에만 둔다 — 같은 액션을 두 화면에 따로 두면
// 관제사가 헷갈린다.

// [2026-09-22] 점유 판단을 status -> call_sign 으로 바꿨다.
//
//   예전에 slot.status 는 **배정 상태**(REQUESTED/APPROVED/...)라 "값이 있으면
//   우리가 배정한 자리"라는 뜻이었다. 지금 status 는 **판정 등급**(적합/주의/
//   부적합/판정불가)이고, 아직 판정 전이면 null 이다 — 우리는 배정하지 않는다.
//
//   그대로 두니 배가 붙어 있는데도 빈 자리로 그려졌다. 실측(2026-09-22):
//       API 점유 8곳  vs  지도 표시 2곳
//   판정이 붙은 2척만 점유로 세고 나머지 6척이 화면에서 사라진 것이다.
//
//   점유는 "배가 실제로 거기 있는가"이고 그 답은 call_sign 이다. 판정 유무는
//   별개이며, 판정이 없다는 사실은 슬롯 상세가 따로 보여준다.

// 위치 신호가 얼마나 낡았는지 — 백엔드 quality_flag(OK/DEGRADED/STALE/NO_SIGNAL, mart.vessel_presence)를
// 관제 용어로 옮긴다. [2026-09-28] 예전엔 "DEGRADED 18분 전"처럼 내부 코드가 그대로 보였다.
//   OK         12분 이내 — 표시하지 않음
//   DEGRADED   12~30분 — "위치 18분 전 수신"
//   STALE      30분~6시간 — "위치 신호 끊김 · 2시간 전"
//   NO_SIGNAL  6시간 넘음 — "위치 신호 없음"
function positionAgeLabel(flag, ageMin) {
  const age = Number(ageMin);
  const ago = !Number.isFinite(age) ? '' : age < 60 ? `${Math.round(age)}분 전` : `${Math.round(age / 60)}시간 전`;
  if (flag === 'DEGRADED') return `위치 ${ago} 수신`;
  if (flag === 'STALE') return `위치 신호 끊김${ago ? ` · ${ago}` : ''}`;
  if (flag === 'NO_SIGNAL') return '위치 신호 없음';
  return ago ? `위치 ${ago}` : '';
}

function isOccupied(slots) {
  return slots.some((s) => s.call_sign);
}

// 지도 마커에 쓰는 투명 아이콘 — 화면엔 안 보이고 클릭 대상 역할만 한다.
// 실제로 보이는 건 이름표(Tooltip, .berth-label CSS)뿐이다.
//
// 크기를 [1,1]로 뒀더니 클릭 히트박스가 사실상 없어서 팝업이 안 열렸다(실사용
// 중 발견, 2026-08-19) — 이름표(Tooltip)는 지도 다른 상호작용을 막지 않으려고
// pointer-events:none이라 클릭이 그대로 통과해버린다. 이름표가 보통 차지하는
// 크기만큼 히트박스를 넉넉히 잡아서 이름표를 눌러도 실제로는 이 마커가 클릭을
// 받게 한다(중심 앵커라 이름표 direction="center"와 겹친다).
const INVISIBLE_ICON = L.divIcon({
  html: '', className: 'invisible-marker', iconSize: [90, 24], iconAnchor: [45, 12],
});

// 판정 등급 → 배지 색. assessment_history.level 의 네 값이 전부다.
// '판정불가'를 회색이 아니라 노랑으로 두는 것이 핵심이다 — 근거가 없다는 사실
// 자체를 관제사가 봐야 한다. 회색으로 두면 '해당 없음'처럼 읽힌다.
const VERDICT_BG = {
  '적합': COLORS.teal,
  '주의': COLORS.yellow,
  '부적합': COLORS.red,
  '판정불가': COLORS.yellow,
};

function formatKST(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Seoul',
  });
}


// 슬롯 하나의 판정근거를 팝업 위에 덮어 보여주는 오버레이(드롭다운이 아니라
// 진짜 팝업으로 띄워달라는 요청, 2026-08-19) — AgentConsole의 근거 원문
// 오버레이(QaPanel::CitationList)와 같은 패턴이다.
//
// [2026-09-22] 보여주는 내용이 배정 근거에서 판정 근거로 바뀌었다.
//   예전엔 decision_detail(선석 스펙 vs 선박 매칭·전용/대체 경로·탈락 후보)을
//   폈다. 그건 우리가 자리를 고르던 시절의 근거다. 지금 백엔드가 주는 것은
//   "왜 이 등급인가"(reasons)와 "그래서 누가 무엇을 해야 하나"(action·recipient)다.
//
//   조치안에 받을 곳을 함께 적는 이유: 우리가 실행하지 않는다는 뜻이 문장에
//   남아야 한다. '대체선석 검토 필요(선석회의)'는 우리가 옮긴다는 말이 아니다.
function ReasonOverlay({ slot, onClose }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 20, background: COLORS.panel,
      display: 'flex', flexDirection: 'column', borderRadius: '8px',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 10px', borderBottom: `1px solid ${COLORS.border}`,
      }}>
        <strong style={{ fontSize: '12.5px', color: COLORS.textPrimary }}>
          슬롯 {slot.slot_no} 판정근거
          {slot.stage && <span style={{ color: COLORS.textDim, fontWeight: 400 }}> · {slot.stage}</span>}
        </strong>
        <button type="button" onClick={onClose} style={{
          background: 'none', border: 'none', color: COLORS.textDim, cursor: 'pointer', fontSize: '15px',
        }}>✕</button>
      </div>
      <div style={{ padding: '10px', overflowY: 'auto' }}>
        <ul style={{
          margin: 0, paddingLeft: '16px', fontSize: '12px',
          color: COLORS.textPrimary, lineHeight: 1.6,
        }}>
          {slot.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        {slot.action && (
          <p style={{ margin: '8px 0 0', fontSize: '11.5px', color: COLORS.teal, fontWeight: 700 }}>
            조치안: {slot.action}{slot.recipient && ` (${slot.recipient})`}
          </p>
        )}
        {slot.assessed_at_utc && (
          <p style={{ margin: '6px 0 0', color: COLORS.textDim, fontSize: '11.5px' }}>
            판정 {formatKST(slot.assessed_at_utc)}
            {slot.acknowledged_by && ` · 확인 ${slot.acknowledged_by}`}
          </p>
        )}
      </div>
    </div>
  );
}

// 슬롯 한 줄 — 누가 붙어 있고(관측), 그게 조건에 맞는지(판정)를 함께 적는다.
// 판정이 아직 없으면 그 사실도 숨기지 않는다 — 배는 있는데 아무도 보지 않았다는
// 뜻이고, 그것도 관제사가 알아야 한다.
function SlotRow({ slot, onShowReason }) {
  // '여유'는 판정이 없는 자리가 아니라 **배가 없는** 자리다(isOccupied 주석 참고).
  if (!slot.call_sign) {
    return (
      <div style={{ padding: '6px 0', fontSize: '12px', color: COLORS.textDim }}>
        슬롯 {slot.slot_no} — 여유
      </div>
    );
  }

  // [2026-09-22] 근거의 출처가 바뀌었다. decision_detail(배정 근거 구조화 값)은
  // 배정을 만들던 시절의 것이고 백엔드가 더는 주지 않는다. 지금 자리에 오는 것은
  // 판정 근거(reasons)다 — 왜 적합/주의/부적합인지를 문장으로 담고 있다.
  const hasReason = Boolean(slot.reasons?.length);

  return (
    <div style={{
      padding: '8px 0', borderTop: `1px solid ${COLORS.border}`, fontSize: '12px',
      color: COLORS.textPrimary,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>슬롯 {slot.slot_no}</strong>
        {/* 배지는 배정 상태가 아니라 **판정 등급**이다. 아직 판정 전이면 그렇게
            적는다 — '점유 중'으로 뭉뚱그리면 "봤는데 괜찮다"처럼 읽힌다. */}
        <span style={{
          fontSize: '11px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px',
          color: slot.status ? '#fff' : COLORS.textDim,
          background: slot.status ? (VERDICT_BG[slot.status] ?? COLORS.teal) : 'transparent',
          border: slot.status ? 'none' : `1px solid ${COLORS.border}`,
        }}>
          {slot.status ?? '판정 전'}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px', marginTop: '4px' }}>
        <p style={{ margin: 0 }}>
          {slot.vessel_name || '(선명 미상)'} · {slot.call_sign}
          {(slot.cargo_names?.length || slot.cargo_name)
            && ` · ${slot.cargo_names?.length ? cargoSummary(slot.cargo_names, 3) : slot.cargo_name}`}
        </p>
        {hasReason && (
          <button
            type="button"
            onClick={() => onShowReason(slot)}
            style={{
              flexShrink: 0, background: 'transparent', border: `1px solid ${COLORS.border}`,
              color: COLORS.teal, borderRadius: '5px', padding: '2px 7px',
              fontSize: '10.5px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            판정근거
          </button>
        )}
      </div>
      <p style={{ margin: '2px 0 0', color: COLORS.textDim }}>
        {slot.actual_arrival_utc ? (
          <>
            입항 {formatKST(slot.actual_arrival_utc)} ~ {slot.actual_departure_utc
              ? `출항 ${formatKST(slot.actual_departure_utc)}`
              : slot.departure_scheduled_utc
                ? `출항예정 ${formatKST(slot.departure_scheduled_utc)}`
                : '(재항 중)'}
          </>
        ) : (
          // 계획 구간(window_start/end)은 예약이 있던 시절의 값이라 더는 오지
          // 않는다. 대신 이 배를 언제 어디서 봤는지를 적는다 — 그게 지금 이
          // 슬롯이 채워져 있다고 보는 근거다.
          <>
            {slot.berth_basis ? `위치 판정 ${slot.berth_basis}` : '위치 판정'}
            {slot.distance_m != null && ` · ${Math.round(slot.distance_m)}m`}
            {slot.position_at_utc && ` · ${formatKST(slot.position_at_utc)} 관측`}
            {slot.quality_flag && slot.quality_flag !== 'OK'
              && ` · ${positionAgeLabel(slot.quality_flag, slot.position_age_min)}`}
          </>
        )}
      </p>
    </div>
  );
}

// 선석 기본정보 — upa_berth_facility(UPA 원본) 그대로. 배정 여부와 무관하게
// 클릭하면 항상 보인다("이 선석이 뭐 하는 곳인가"는 배정 상태와 별개 질문).
//
// 예전엔 항목마다 줄을 하나씩 써서 8줄이었다 — 슬롯 목록까지 합치면 팝업이
// 너무 길어졌다(실사용 중 지적, 2026-08-19). 성격이 비슷한 값끼리 한 줄에
// 묶어 최대 3줄로 줄인다.
function BerthInfo({ berth }) {
  const identity = [berth.port_name, berth.wharf_se_name, berth.operator].filter(Boolean).join(' · ');
  const specs = [
    berth.length_m != null ? `안벽 ${berth.length_m}m` : null,
    berth.depth_m != null ? `수심 ${berth.depth_m}m` : null,
    berth.max_dwt != null ? `DWT ${berth.max_dwt.toLocaleString()}t` : null,
    `슬롯 ${berth.max_concurrent_vessels}개`,
  ].filter(Boolean).join(' · ');

  if (!identity && !specs && !berth.handling_cargo_name) return null;

  return (
    <div style={{ fontSize: '11.5px', color: COLORS.textSecondary, marginTop: '6px', lineHeight: 1.6 }}>
      {identity && <div>{identity}</div>}
      {specs && <div>{specs}</div>}
      {berth.handling_cargo_name && <div>취급화물: {berth.handling_cargo_name}</div>}
    </div>
  );
}

// 선석 하나의 팝업 내용 — 슬롯 목록을 보여주다가, 어느 슬롯이든 "배정근거"를
// 누르면 그 슬롯 하나만 ReasonOverlay로 전체를 덮는다. position:relative가
// 있어야 ReasonOverlay의 inset:0이 이 팝업 안쪽만 덮는다(페이지 전체 X).
function BerthPopupContent({ berth, filled }) {
  const [activeSlot, setActiveSlot] = useState(null);

  return (
    <div style={{ color: COLORS.textPrimary, position: 'relative' }}>
      <strong>{berth.wharf_name}</strong>
      <span style={{ color: COLORS.textDim, fontSize: '11px' }}> ({filled}/{berth.slots.length} 슬롯 사용)</span>
      <BerthInfo berth={berth} />
      {berth.slots.map((slot) => (
        <SlotRow key={slot.slot_no} slot={slot} onShowReason={setActiveSlot} />
      ))}
      {activeSlot && <ReasonOverlay slot={activeSlot} onClose={() => setActiveSlot(null)} />}
    </div>
  );
}

const POLL_MS = 30_000;

// 참고 선석(배정 범위 밖) — 작은 회색 사각 라벨. 배정 마커와 형태부터 다르게.
const refIcon = L.divIcon({
  className: 'ref-berth-icon',
  html: '<div style="width:9px;height:9px;border-radius:2px;background:#9AA7AE;border:1px solid #7A8A92;"></div>',
  iconSize: [9, 9], iconAnchor: [4, 4],
});

export default function BerthAssignmentMap({ scope = 'onsan', onScopeChange }) {
  const [berths, setBerths] = useState([]);
  // 참고 레이어(울산 전체 선석) — 배정 범위 밖. scope 전환 시 1회 로드.
  const [refBerths, setRefBerths] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const mapRef = useRef(null);
  // PortMap.jsx처럼 실제 선석 좌표에 맞춰 화면을 잡는다 — 다만 여기 데이터는
  // API에서 비동기로 온다(PortMap의 ONSAN_BERTHS는 정적 큐레이션이라 마운트
  // 즉시 fitBounds 가능했던 것과 다름). 그래서 최초 로드 한 번만 fitBounds하고,
  // 이후 30초 폴링 갱신마다 다시 맞추지는 않는다 — 관제사가 지도를 옮겨/확대해
  // 보고 있는데 갱신 때마다 시점이 리셋되면 방해가 된다.
  const hasFitRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchBerthAssignments();
      setBerths(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // 배정 API 는 온산 MVP 스코프만 준다(2026-08-21, 스케줄링 에이전트가 온산
  // 하드 필터로 바뀌면서 함께 좁힘 — dashboard.py 주석 참고). 그래서 '울산 전체'
  // 는 배정 뷰가 아니라 **참고 레이어**다: 배정이 붙을 수 없는 항만 전체 선석을
  // 회색으로 깔아 "온산이 울산의 어디쯤인가"를 보여준다(2026-08-23 피드백 —
  // 온산/전체 구분). 참고 선석은 실측 /dashboard/berths(69개)에서 온다.
  const withCoords = berths.filter((b) => b.latitude != null && b.longitude != null);
  const occupiedBerthCount = withCoords.filter((b) => isOccupied(b.slots)).length;
  const occupiedSlotCount = withCoords.reduce(
    (sum, b) => sum + b.slots.filter((s) => s.call_sign).length, 0
  );

  useEffect(() => {
    if (hasFitRef.current || withCoords.length === 0 || !mapRef.current) return;
    const bounds = withCoords.map((b) => [b.latitude, b.longitude]);
    requestAnimationFrame(() => mapRef.current?.fitBounds(bounds, ONSAN_FIT));
    hasFitRef.current = true;
  }, [withCoords]);

  // 스코프 전환: 참고 선석을 (필요 시) 불러오고, 그 범위로 시야를 맞춘다
  useEffect(() => {
    let alive = true;
    const apply = async () => {
      let ref = refBerths;
      if (scope === 'all' && ref === null) {
        try {
          const res = await fetch('/api/v1/dashboard/berths');
          ref = res.ok ? await res.json() : [];
        } catch { ref = []; }
        if (!alive) return;
        setRefBerths(ref);
      }
      if (!mapRef.current) return;
      const pts = scope === 'all'
        ? (ref || []).filter((b) => b.latitude != null).map((b) => [b.latitude, b.longitude])
        : withCoords.map((b) => [b.latitude, b.longitude]);
      if (pts.length) mapRef.current.flyToBounds(pts, { ...ONSAN_FIT, duration: 0.6 });
    };
    apply();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', borderRadius: '16px', overflow: 'hidden' }}>
      <MapContainer
        ref={mapRef}
        center={ONSAN_MAP_CENTER}
        zoom={ONSAN_MAP_ZOOM}
        style={{ height: '100%', width: '100%', background: COLORS.bg }}
        attributionControl={false}
      >
        {/* CARTO 는 API 키 없이 회색 안내 타일만 준다(2026-09-18, PortMap 주석) */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <Rectangle
          bounds={ULSAN_BBOX_BOUNDS}
          pathOptions={{ color: COLORS.info, weight: 1.5, dashArray: '8 6', fillOpacity: 0.02 }}
        />

        {/* 참고 레이어: 배정 범위 밖 울산 선석 (회색 · 클릭 액션 없음) */}
        {scope === 'all' && (refBerths || [])
          .filter((b) => b.latitude != null && b.port_name !== '온산항')
          .map((b) => (
            <Marker
              key={`ref-${b.wharf_name}-${b.wharf_se_name || ''}`}
              position={[b.latitude, b.longitude]}
              opacity={0.55}
              icon={refIcon}
            >
              <Tooltip direction="top">
                {b.wharf_name} — 배정 범위 밖 (온산 MVP)
              </Tooltip>
            </Marker>
          ))}

        {withCoords.map((b) => {
          const occupied = isOccupied(b.slots);
          const filled = b.slots.filter((s) => s.call_sign).length;
          return (
            <Marker
              // occupied를 key에 포함시켜 점유 상태가 바뀌면 통째로 다시 그린다 —
              // react-leaflet Tooltip은 className 같은 일부 prop을 마운트 후
              // 갱신에서 안정적으로 반영하지 않는다.
              key={`${b.wharf_name}-${occupied}`}
              position={[b.latitude, b.longitude]}
              icon={INVISIBLE_ICON}
            >
              <Tooltip
                permanent
                direction="center"
                className={occupied ? 'berth-label occupied' : 'berth-label'}
              >
                {b.wharf_name.replace(/부두$/, '')}
              </Tooltip>
              {/* minWidth/maxWidth를 넓혔다(2026-08-20, "배정근거 팝업창 좀 작은거
                  같아" 지적) — ReasonOverlay(배정근거: narrative + 매칭/기상/경로/
                  탈락 행)가 이 팝업 안에 inset:0으로 덮이는 구조라, 원래 300px
                  폭에서는 문장이 계속 줄바꿈되며 실제보다 작고 답답해 보였다. */}
              <Popup minWidth={280} maxWidth={380}>
                <BerthPopupContent berth={b} filled={filled} />
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      <div style={{
        position: 'absolute', bottom: 14, left: 14, zIndex: 1000,
        background: COLORS.glass, border: `1px solid ${COLORS.glassBorder}`,
        backdropFilter: 'blur(8px)', borderRadius: '10px',
        padding: '10px 14px', color: COLORS.textPrimary, fontSize: '12px',
      }}>
        <div style={{ fontWeight: 'bold', marginBottom: '6px' }}>
          <span style={{ display: 'inline-flex', gap: '6px', marginRight: '10px' }}>
            {[['onsan', '온산항 (배정 대상)'], ['all', '울산 전체 보기']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => onScopeChange?.(key)}
                style={{
                  border: `1px solid ${scope === key ? COLORS.teal : COLORS.border}`,
                  background: scope === key ? `${COLORS.teal}18` : 'transparent',
                  color: scope === key ? COLORS.teal : COLORS.textSecondary,
                  borderRadius: '14px', padding: '2px 10px', fontSize: '11.5px',
                  fontWeight: 700, cursor: 'pointer',
                }}
              >{label}</button>
            ))}
          </span>
          선석 {withCoords.length}개 · 점유 {occupiedBerthCount}개({occupiedSlotCount}슬롯)
          {scope === 'all' && (
            <span style={{ color: COLORS.textDim, marginLeft: '8px' }}>
              · 회색 {Math.max(0, (refBerths || []).filter((b) => b.latitude != null && b.port_name !== '온산항').length)}개 = 배정 범위 밖(참고)
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: 14, height: 10, borderRadius: '3px', background: COLORS.teal, display: 'inline-block' }} />
          점유 중 — 클릭하면 배정 상세
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
          <span style={{ width: 14, height: 10, borderRadius: '3px', border: `1px solid ${COLORS.textDim}`, display: 'inline-block' }} />
          배정 없음 — 클릭하면 선석 기본정보
        </div>
        {error && <div style={{ marginTop: '6px', color: COLORS.red }}>불러오기 실패: {error}</div>}
        {loading && <div style={{ marginTop: '6px', color: COLORS.textDim }}>불러오는 중…</div>}
      </div>
    </div>
  );
}
