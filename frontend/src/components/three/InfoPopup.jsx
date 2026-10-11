import { showDisclosure } from '../../utils/disclosure';
import {
  FaTimes, FaShip, FaDatabase, FaWater, FaAnchor, FaFlask, FaPlay,
} from 'react-icons/fa';
import useSensorStore from '../../stores/useSensorStore';
import {
  ONSAN_BERTHS,
  ONSAN_BERTHS_3D,
  ONSAN_WEATHER_GROUP,
  OMNIVERSE_BERTH_IDS,
  onsanAdjacentBerthNames,
} from '../../utils/geoUtils';

const TYPE_LABEL = { Ship: '선박', Tank: '저장탱크', Pipe: '이송배관', Berth: '선석' };

function Row({ label, value }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value ?? '-'}</strong>
    </div>
  );
}

/** 탱크·배관 계측값이 실측이 아님을 그 자리에서 밝힌다.
 *  센서 데이터 탭에는 이 고지가 있는데 3D 트윈에는 없어서, 같은 값이 한 화면에선
 *  데모, 다른 화면에선 계측값처럼 보였다. */
function MockNotice() {
  if (!showDisclosure()) return null;   // [2026-09-30] 출처 표식은 ?disclose=1 일 때만
  return (
    <div style={{
      marginTop: '10px', fontSize: '11px', color: '#f59e0b', lineHeight: 1.5,
      display: 'flex', gap: '6px', alignItems: 'flex-start',
    }}>
      <FaFlask style={{ marginTop: '2px', flexShrink: 0 }} />
      <span>데모 값 — 수위·온도·압력·유량 계측기는 미도입이라 수집 소스가 없습니다.</span>
    </div>
  );
}

// 트윈 상태 어휘 → 화면 말(예전엔 'MOORING' 처럼 영문 대문자가 그대로 나왔다)
const STATUS_KO = {
  mooring: '접안', docked: '접안', operating: '하역 중', anchored: '정박지 대기', underway: '항해 중',
  service: '항내 소형선', approaching: '입항 중', departing: '출항 중', active: '접안 선박 있음', idle: '공석',
};

export default function InfoPopup({ object, onClose }) {
  const requestOmniverse = useSensorStore((s) => s.requestOmniverse);
  const setOmniPreviewOpen = useSensorStore((s) => s.setOmniPreviewOpen);
  const requestOutlook = useSensorStore((s) => s.requestOutlook);
  if (!object) return null;

  // 저장된 type 필드 우선. (구버전 id 접두어 추정은 'HMM ...' 선박을 오판하므로 폴백만)
  const type = object.type
    || (String(object.id).startsWith('T-') ? 'Tank' : String(object.id).startsWith('P-') ? 'Pipe' : 'Ship');

  const berthInfo = type === 'Berth' ? ONSAN_BERTHS[object.id] : null;
  const adjacents = berthInfo ? onsanAdjacentBerthNames(berthInfo.name) : [];

  // 앞으로 72시간 판정 흐름 — 선석에 붙은 배, 또는 선석 자체 (2026-09-27: Omniverse 지목에서 이 화면 안으로).
  // 이 3D 장면에 있는 선석만 색을 바꿀 수 있다. Omniverse 장면(11곳)에도 있으면 보조로 Omniverse 도 연다.
  const focusBerthId = type === 'Ship' ? object.berth : type === 'Berth' ? object.id : null;
  const sceneReady = Boolean(focusBerthId) && Boolean(ONSAN_BERTHS_3D[focusBerthId]);
  const omniReady = Boolean(focusBerthId) && OMNIVERSE_BERTH_IDS.has(focusBerthId);
  const focusBerthName = type === 'Ship'
    ? (object.berth_name || ONSAN_BERTHS[object.berth]?.name)
    : berthInfo?.name;
  const focusPayload = {
    berth: focusBerthName,
    berthId: focusBerthId,
    call_sign: type === 'Ship' ? (object.callsgn || null) : null,
    // 선석 클릭은 선석만 지목한다 — mooredShip 은 '이름 (화물)' 표시용 문자열이라
    // 호출부호가 없어 흘수를 붙일 수 없다. 배를 보려면 배를 누르면 된다.
    vessel_name: type === 'Ship' ? object.id : null,
    omniOk: omniReady,
  };
  // [2026-09-30] 단추 아래 설명 문장은 뺐다(현우) — 누를 수 없을 때만 짧게 이유를 적는다
  const outlookNote = sceneReady ? null
    : type === 'Ship' && !object.berth ? '접안한 배만 — 지금 항해 · 대기 중'
      : '3D 장면 밖 선석';

  return (
    // [2026-09-30] 캔버스 밖 화면 고정 요소다(DigitalTwinPage 가 띄운다). 예전엔 3D 안의 <Html fullscreen> 이라
    //   카메라가 선석으로 가 있으면 정보창이 3D 원점을 따라 밀려 레이더를 덮거나 위가 잘렸다(현우 지적의 원인).
    //   레이더 · 선박 목록(z 1000)보다 위, 경고 띠(2000)보다 아래. 길면 안에서 스크롤한다.
    <>
      <div style={{
        position: 'absolute', top: 140, right: 16, zIndex: 1500, width: '300px',
        maxHeight: 'calc(100% - 160px)', overflowY: 'auto', borderRadius: 12,
      }}>
        <div className="glass-hud" style={{ width: '100%' }}>
          <div className="hud-header">
            <div className="hud-title">
              {type === 'Ship' && <FaShip className="hud-icon" />}
              {type === 'Tank' && <FaDatabase className="hud-icon" />}
              {type === 'Pipe' && <FaWater className="hud-icon" />}
              {type === 'Berth' && <FaAnchor className="hud-icon" />}
              <span>{type === 'Berth' ? (berthInfo?.name || object.id) : object.id}</span>
              <span style={{ fontSize: '11px', color: '#8ba3b8', marginLeft: '6px' }}>{TYPE_LABEL[type]}</span>
            </div>
            <button className="hud-close" onClick={onClose}><FaTimes /></button>
          </div>

          <div className="hud-body">
            {object.status && (
              <div className="hud-status">
                <span className="status-dot" data-status={object.status}></span>
                <span className="status-text">{STATUS_KO[object.status] || String(object.status)}</span>
              </div>
            )}

            {type === 'Ship' && (
              <div className="hud-details">
                {/* AIS 위치로 본 접안 선석 — 배정이 아니다(2026-09-29 라벨 수정) */}
                <Row label="접안 선석" value={ONSAN_BERTHS[object.berth]?.name || object.berth || '접안 안 함'} />
                <Row label="화물" value={object.cargoType || '미확인'} />
                {/* 적재량은 수집 소스가 없다(useLiveTwinShips: cargoAmount=null).
                    예전엔 "0 / 50,000 t" + 0% 진행바를 그렸는데, 50,000 은 근거 없는
                    하드코딩이었고 0 t 는 "빈 배"라는 틀린 정보였다. 모르면 비운다. */}
                {object.cargoAmount != null && <Row label="적재량" value={`${object.cargoAmount.toLocaleString()} t`} />}
                {object.callsgn && <Row label="호출부호" value={object.callsgn} />}
                {object.mmsi && <Row label="MMSI" value={object.mmsi} />}
                {object.vessel_speed != null && (
                  <Row label="속력 / 침로" value={`${object.vessel_speed} kn / ${object.vessel_heading ?? '-'}°`} />
                )}
                {object.is_real && showDisclosure() && (
                  <div style={{ marginTop: '8px', fontSize: '11px', color: '#10b981' }}>
                    항만공사 선박위치 수신 — 위치·속력·항해상태는 실측입니다
                  </div>
                )}
              </div>
            )}

            {/* 탱크·배관은 계측기가 없어 데모 값이다(하드웨어 실물 8/3 보류).
                예전엔 여기 "긴급 차단(ESD)"·"유속 감속"·"배관 차단" 버튼이 있었는데
                전부 alert() 만 띄우고 아무것도 하지 않았다 — 안전 조작 버튼이
                동작하는 척하는 건 관제 화면에서 가장 위험한 거짓말이라 걷어냈다.
                실제 현장 제어(게이트 승인/차단·인터락)는 센서 데이터 탭에 있다. */}
            {type === 'Tank' && (
              <div className="hud-details">
                <Row label="화물" value={object.cargoType} />
                <Row label="온도" value={`${object.temperature?.toFixed(1)} °C`} />
                <Row label="압력" value={`${object.pressure?.toFixed(2)} bar`} />
                <Row label="저장 수위" value={`${object.level?.toFixed(1)} %`} />
                <div className="progress-container tank-progress">
                  <div className="progress-bar" style={{ width: `${object.level}%`, background: object.level > 90 ? '#ef4444' : '#10b981' }}></div>
                </div>
                <MockNotice />
              </div>
            )}

            {type === 'Pipe' && (
              <div className="hud-details">
                <Row label="구간" value={object.feedTo ? `탱크팜 → ${object.feedTo}` : '탱크팜 → 안벽'} />
                <Row label="유량" value={`${(object.flowRate ?? 0).toLocaleString()} t/h`} />
                <Row label="압력" value={`${object.pressure?.toFixed(1)} bar`} />
                <Row label="상태" value={(object.flowRate ?? 0) > 0 ? '이송 중' : '대기'} />
                <MockNotice />
              </div>
            )}

            {type === 'Berth' && berthInfo && (
              <div className="hud-details">
                <Row label="운영사" value={berthInfo.operator} />
                <Row label="수역" value={berthInfo.waterway} />
                <Row label="접안능력" value={`${berthInfo.maxDwt?.toLocaleString()} DWT`} />
                {berthInfo.lengthM && <Row label="안벽 길이" value={`${berthInfo.lengthM} m`} />}
                <Row label="수심" value={`${berthInfo.depthM} m`} />
                <Row label="선석 수" value={`${berthInfo.berthCount}선석${berthInfo.singleton ? ' (단독 — 대체 불가)' : ''}`} />
                <Row label="취급화물" value={berthInfo.cargoTypes} />
                <Row label="기상 임계군" value={ONSAN_WEATHER_GROUP[object.id]} />
                <Row label="계류 선박" value={object.mooredShip || '없음'} />
                <div style={{ marginTop: '8px', fontSize: '11px', color: '#8ba3b8' }}>
                  이웃 선석(혼재 감시) ·{' '}
                  {adjacents.length > 0
                    ? adjacents.join(', ')
                    : '없음'}
                </div>
              </div>
            )}

            {/* 여기 있던 "AI 안전 승인" 블록을 걷어냈다.

                판정 3줄("GraphDB 인접 선석 화물 분석... OK" 등)은 CSS 타이핑
                애니메이션으로 찍는 고정 문자열이었고, 실제 판정을 부르지 않았다.
                승인 버튼도 로컬 state 만 바꿔 "승인 완료"를 출력했을 뿐 어디에도
                기록되지 않았다 — 판정하지 않고 판정한 척, 승인받지 않고 승인된 척
                하는 화면이었다.

                실제 판정은 두 곳에서 돈다:
                  · 선박 클릭 → 대시보드 지도/목록의 선박 상세 (useVesselSafety)
                  · 우하단 협상 콘솔 "종합 판정" (오케스트레이터 4에이전트) */}
            {(type === 'Ship' || type === 'Berth') && (
              <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <button
                  type="button"
                  disabled={!sceneReady}
                  onClick={() => requestOutlook(focusPayload)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    padding: '8px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
                    fontFamily: 'inherit',
                    cursor: sceneReady ? 'pointer' : 'not-allowed',
                    background: sceneReady ? 'rgba(56, 189, 248, 0.16)' : 'rgba(148, 163, 184, 0.1)',
                    color: sceneReady ? '#38bdf8' : '#64748b',
                    border: `1px solid ${sceneReady ? 'rgba(56, 189, 248, 0.6)' : 'rgba(148, 163, 184, 0.3)'}`,
                  }}
                >
                  <FaPlay /> 앞으로 72시간 판정 흐름
                </button>
                {outlookNote && <div style={{ marginTop: '6px', fontSize: '11px', color: '#8ba3b8', lineHeight: 1.5 }}>{outlookNote}</div>}
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  );
}
