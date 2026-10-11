import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import Scene from '../components/three/Scene';
import { findBerthIdByName, ONSAN_BERTHS, ONSAN_BERTHS_3D, OMNIVERSE_BERTH_IDS } from '../utils/geoUtils';
import HelpTip from '../components/common/HelpTip';
import PortMap from '../components/dashboard/PortMap';
import RadarMap from '../components/three/hud/RadarMap';
import CCTVPanel from '../components/three/hud/CCTVPanel';
import VesselTrafficList from '../components/three/hud/VesselTrafficList';
import BerthStatusBar from '../components/three/hud/BerthStatusBar';
import OutlookTimeline from '../components/three/hud/OutlookTimeline';
import OmniversePreview from '../components/three/OmniversePreview';
import InfoPopup from '../components/three/InfoPopup';
import useSensorStore from '../stores/useSensorStore';
import useLiveTwinShips from '../hooks/useLiveTwinShips';
import useDashboardData from '../hooks/useDashboardData';
import { BACKEND_BASE, postTwinFocus } from '../api/backendAdapter';
import { FaPlay, FaExclamationTriangle, FaFastForward } from 'react-icons/fa';
import { levelStyle, alertParts, mergeAlerts } from '../utils/alertUtils';

// Isaac Sim 6 WebRTC 스트리밍은 웹 뷰어(web-viewer-sample)를 통해 표시된다.
// 실행: D:\omniverse\start_twin_stream.bat (Isaac Sim 스트리밍 + 웹 뷰어 동시 기동)
//
// 뷰어 포트: Vite 는 5173 이 점유되어 있으면 5174, 5175… 로 올려서 뜬다.
// 5173 하나만 보고 있으면 "떠 있는데 못 찾는" 상황이 생기므로 후보를 순차 탐색한다.
const OMNIVERSE_PORTS = [5173, 5174, 5175, 5176];
const omniverseUrl = (port) => `http://localhost:${port}`;

// 온산항 전체의 72시간 — 선석을 지목하지 않는다
const WIDE_FOCUS = { wide: true, berth: null, berthId: null, call_sign: null, vessel_name: null, omniOk: false };

// 경고 한 건이 화면에 머무는 시간. 결론만 보여주므로 5초면 충분히 읽힌다.
const TICKER_ROTATE_MS = 5000;

export default function DigitalTwinPage() {
  // 트윈 선박을 실 AIS·재항 화물로 채운다 (예전엔 스토어에 6척이 하드코딩돼 있었다)
  useLiveTwinShips();

  // 다른 화면에서 넘어온 요청을 읽는다.
  //   ?berth=S-Oil 2부두  → 그 선석으로 카메라 이동 + 인접 선석 강조 (안전/환경 관제에서)
  //   ?omniverse=1        → 정밀 검토 스트림을 바로 켠다 (선박 상세 계류 검증에서)
  // 화면끼리 역할이 나뉘어 있어도 흐름이 끊기면 사용자는 매번 처음부터 찾아야 한다.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusBerth = searchParams.get('berth') || null;
  // 3D 장면에는 온산 11개 선석만 있다. 안전/환경 관제는 울산 전역(SK·가스부두 등)을
  // 다루므로, 장면 밖 선석으로 넘어오는 경우가 실제로 생긴다(2026-09-03 실측: SK3부두).
  // 그때 "빨간 링이 대상 선석"이라고 안내하면 있지도 않은 링을 찾게 만든다.
  const focusInScene = focusBerth ? Boolean(findBerthIdByName(focusBerth)) : false;
  const wantOmniverse = searchParams.get('omniverse') === '1';
  //   ?outlook=OTK 1부두   → 그 선석의 "앞으로 72시간"을 바로 연다 (시연 영상·캡처용)
  //   ?outlook=all         → 온산항 전체의 72시간
  const wantOutlook = searchParams.get('outlook') || null;
  //   &at=<시각 ms>          → 그 시각부터(경고 벨의 '앞으로' 경고)
  const wantAt = Number(searchParams.get('at')) || null;

  // 상단 띠에 세울 실경고 — 심각한 것부터 전부 돈다.
  // [2026-09-30] 예전엔 앞 6건만 돌며 '위험 16 · 표시 4/6'이라 적어, 16건 중 왜 6건인지 알 수 없었고
  //   5초마다 글이 툭 바뀌었다(현우). 전부 돌리고, 새 건은 아래에서 올라오며, 띠 아래 선이 다음 건까지 남은 시간을
  //   채운다. 마우스를 올리면 멈추고 ‹ › 로 넘긴다.
  const { data: dashForTicker } = useDashboardData();
  const allAlerts = useMemo(() => mergeAlerts(dashForTicker?.alerts ?? []), [dashForTicker?.alerts]);
  // [2026-09-30] 위험만 돈다 — 주의 · 참고까지 51건을 돌리면 볼 수 없다(현우). 나머지는 경고 벨에서 본다.
  const tickerItems = useMemo(() => allAlerts.filter((x) => x.level === 'DANGER'), [allAlerts]);
  const dangerCount = allAlerts.filter((a) => a.level === 'DANGER').length;
  const [tickerIdx, setTickerIdx] = useState(0);
  const [tickerHold, setTickerHold] = useState(false);
  const [tickerTick, setTickerTick] = useState(0);   // 멈춤을 풀면 진행 선을 처음부터
  useEffect(() => {
    if (tickerItems.length < 2 || tickerHold) return undefined;
    const id = setTimeout(() => setTickerIdx((i) => (i + 1) % tickerItems.length), TICKER_ROTATE_MS);
    return () => clearTimeout(id);
  }, [tickerItems.length, tickerHold, tickerIdx, tickerTick]);
  const stepTicker = (d) => setTickerIdx((i) => (i + d + tickerItems.length) % tickerItems.length);
  const [showMap, setShowMap] = useState(false);
  const [showOmniverseStream, setShowOmniverseStream] = useState(false);
  // 'checking' | 'ok' | 'unreachable'
  const [streamStatus, setStreamStatus] = useState('checking');
  const [omniUrl, setOmniUrl] = useState(omniverseUrl(OMNIVERSE_PORTS[0]));
  const [streamKey, setStreamKey] = useState(0);   // iframe 재마운트용 (세션 재연결)

  // 웹 뷰어가 떠 있는 포트를 찾는다. no-cors 라 응답 내용은 못 읽지만,
  // 연결 거부/타임아웃이면 reject 되므로 "떠 있는지"는 판별 가능하다.
  const checkStream = async () => {
    setStreamStatus('checking');
    for (const port of OMNIVERSE_PORTS) {
      const url = omniverseUrl(port);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      try {
        await fetch(url, { mode: 'no-cors', signal: ctrl.signal });
        clearTimeout(timer);
        setOmniUrl(url);
        setStreamStatus('ok');
        return;
      } catch {
        clearTimeout(timer);   // 다음 포트 시도
      }
    }
    setStreamStatus('unreachable');
  };
  // 3D 화면에서 고른 배·선석 → 정밀 검토 지목 (InfoPopup 의 [정밀 검토] 버튼과 같은 규칙).
  // 장면에는 온산 액체화물 부두 11곳만 있어 그 밖의 선석은 지목할 수 없다.
  const selectedObject = useSensorStore((s) => s.selectedObject);
  const focusFromSelection = (obj) => {
    if (!obj) return null;
    const type = obj.type;
    const berthId = type === 'Ship' ? obj.berth : type === 'Berth' ? obj.id : null;
    // 이 3D 장면에 있는 선석만 — 장면 밖(가스부두·SK 등)은 색을 바꿀 자리가 없다.
    if (!berthId || !ONSAN_BERTHS_3D[berthId]) return null;
    const berthName = type === 'Ship' ? (obj.berth_name || ONSAN_BERTHS[obj.berth]?.name) : ONSAN_BERTHS[obj.id]?.name;
    if (!berthName) return null;
    return {
      berth: berthName,
      berthId,
      call_sign: type === 'Ship' ? (obj.callsgn || null) : null,
      vessel_name: type === 'Ship' ? obj.id : null,
      // Omniverse 장면(11곳)에도 있는 선석이면 보조로 Omniverse 도 볼 수 있다
      omniOk: OMNIVERSE_BERTH_IDS.has(berthId),
    };
  };
  const selectionFocus = focusFromSelection(selectedObject);
  const selectionLabel = selectedObject
    ? (selectedObject.type === 'Ship' ? selectedObject.id : ONSAN_BERTHS[selectedObject.id]?.name || selectedObject.id)
    : null;
  const setOmniPreviewOpen = useSensorStore((s) => s.setOmniPreviewOpen);
  const setSelectedObject = useSensorStore((s) => s.setSelectedObject);
  const requestTwinHome = useSensorStore((s) => s.requestTwinHome);

  // ── 앞으로 72시간 — 이 화면 안의 판정 흐름 (2026-09-27) ────────────────────
  // 정보창·연결 바·?outlook= 에서 요청한다. 열리면 카메라가 그 선석으로 가고(BerthFocus, 링은 끔),
  // 시간축 커서에 따라 Port 가 선석 색·라벨을 바꾼다. Omniverse 는 보조("Omniverse 로 보기").
  const [outlookFocus, setOutlookFocus] = useState(null);
  const outlookRequest = useSensorStore((s) => s.outlookRequest);
  const clearOutlookRequest = useSensorStore((s) => s.clearOutlookRequest);
  useEffect(() => {
    if (!outlookRequest) return;
    const { at, ...focus } = outlookRequest;   // eslint-disable-line no-unused-vars
    setShowOmniverseStream(false);
    setShowMap(false);
    setOutlookFocus(focus);
    // 72시간 패널이 같은 선석 정보를 보여주므로 정보창은 닫는다 — 열어 두면 머리 단추를 덮었다
    setSelectedObject(null);
    clearOutlookRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlookRequest?.at]);
  // [2026-09-30] 72시간을 닫으면 처음 화면으로 — 선택 해제 · 주소 인자(?berth · ?outlook) 해제 · 카메라 조감(현우)
  const closeOutlook = () => {
    setOutlookFocus(null);
    setSelectedObject(null);
    if (searchParams.get('berth') || searchParams.get('outlook')) setSearchParams({}, { replace: true });
    requestTwinHome();
  };
  // [2026-09-30] 머리 단추 — 선석을 고르지 않고 온산항 전체의 72시간을 돌려 본다(조감 시점)
  const openPortOutlook = () => {
    setShowOmniverseStream(false);
    setShowMap(false);
    setSelectedObject(null);
    setOutlookFocus(WIDE_FOCUS);
    requestTwinHome('wide');
  };
  // [2026-09-30] 72시간을 보는 동안 배 · 선석을 누르면(3D · 선석 현황 띠) 정보창 대신 그 선석의 72시간으로 넘어간다.
  //   시각은 패널이 이어 간다(OutlookTimeline keepT) — 온산 전체와 선석 하나는 같은 시뮬레이션의 두 배율이다.
  const focusBerthOutlook = (berthId) => {
    if (!ONSAN_BERTHS_3D[berthId] || !ONSAN_BERTHS[berthId]) return;
    setOutlookFocus({ berth: ONSAN_BERTHS[berthId].name, berthId, call_sign: null, vessel_name: null, omniOk: OMNIVERSE_BERTH_IDS.has(berthId) });
  };
  const widenOutlook = () => { setOutlookFocus(WIDE_FOCUS); requestTwinHome('wide'); };
  useEffect(() => {
    if (!outlookFocus || !selectedObject) return;
    const f = focusFromSelection(selectedObject);
    setSelectedObject(null);
    if (f && (f.berthId !== outlookFocus.berthId || (f.call_sign || null) !== (outlookFocus.call_sign || null))) setOutlookFocus(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedObject]);
  useEffect(() => {
    if (!wantOutlook) return;
    if (wantOutlook === 'all') { setOutlookFocus({ ...WIDE_FOCUS, jumpAt: wantAt }); requestTwinHome('wide'); return; }
    const id = findBerthIdByName(wantOutlook);
    if (id && ONSAN_BERTHS_3D[id]) {
      setOutlookFocus({ berth: ONSAN_BERTHS[id].name, berthId: id, call_sign: null, vessel_name: null, omniOk: OMNIVERSE_BERTH_IDS.has(id), jumpAt: wantAt });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantOutlook, wantAt]);

  

  // 선박 상세의 계류 물리 검증에서 '정밀 검토'로 넘어온 경우 바로 켠다.
  // 사용자가 화면을 옮겨온 목적이 이미 분명한데 버튼을 한 번 더 누르게 할 이유가 없다.
  // 서버 확인(checkStream)도 같이 시작해야 한다 — 창만 열면 '연결 확인 중'에서 영원히 멈춘다(9/17 실측).
  useEffect(() => {
    if (wantOmniverse) {
      setShowOmniverseStream(true);
      checkStream();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantOmniverse]);

  // ── 정밀 검토 지목 ─────────────────────────────────────────────────────────
  // 3D 정보창의 [Omniverse 정밀 검토] → 스토어 요청 → 여기서 백엔드에 지목을 적고
  // 스트림을 연다. Omniverse 앱이 몇 초마다 지목을 읽어 그 선석으로 내려간다.
  // 지목이 없으면 Omniverse 는 조감 → 과거 사례 재생을 순환한다.
  const omniverseRequest = useSensorStore((s) => s.omniverseRequest);
  const clearOmniverseRequest = useSensorStore((s) => s.clearOmniverseRequest);
  const [omniFocus, setOmniFocus] = useState(null);       // 백엔드가 돌려준 현재 지목
  const [omniFocusError, setOmniFocusError] = useState(null);
  const [replayCases, setReplayCases] = useState([]);    // 과거 사례 — 실제로 있었던 날

  const sendFocus = async (focus) => {
    try {
      const res = await postTwinFocus(focus);
      setOmniFocus(res.berth ? res : null);
      setOmniFocusError(null);
    } catch (e) {
      // 지목이 안 적혀도 스트림은 그대로 본다 — Omniverse 는 순환 재생을 계속한다
      setOmniFocusError(e.message);
    }
  };

  useEffect(() => {
    if (!omniverseRequest) return;
    const { at, ...focus } = omniverseRequest;   // eslint-disable-line no-unused-vars
    setShowOmniverseStream(true);
    checkStream();
    sendFocus(focus);
    clearOmniverseRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [omniverseRequest?.at]);

  // 스트림을 열 때 지금 지목과 과거 사례 목록을 맞춰 둔다
  useEffect(() => {
    if (!showOmniverseStream) return;
    fetch(`${BACKEND_BASE}/twin/focus`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f) => { if (f) setOmniFocus(f.berth ? f : null); })
      .catch(() => {});
    if (!replayCases.length) {
      fetch('/demo/replays.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setReplayCases((d?.replays || []).filter((r) => r.kind === 'vessel')))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOmniverseStream]);


  return (
    <div className="digital-twin-page" style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <Scene focusBerth={outlookFocus ? outlookFocus.berth : focusBerth} focusRings={!outlookFocus} />
      <OmniversePreview />

      {/* 어느 선석을 보러 왔는지 알려준다.
          카메라만 옮기면 사용자는 '왜 여기가 비춰지는지' 모른다. */}
      {focusBerth && !showOmniverseStream && !outlookFocus && (
        <div style={{
          // CCTV(왼쪽 440) 와 머리 단추(오른쪽 230) 사이 — 좁은 화면에서도 둘을 덮지 않게
          position: 'absolute', top: 90, left: 440, right: 390,
          zIndex: 840, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', whiteSpace: 'nowrap',
          background: 'rgba(15, 23, 42, 0.88)', backdropFilter: 'blur(10px)',
          border: `1px solid ${focusInScene ? 'rgba(255, 75, 110, 0.55)' : 'rgba(245, 158, 11, 0.55)'}`,
          borderRadius: '10px', padding: '8px 14px', color: '#fff',
          fontSize: '12.5px', fontWeight: 700, width: 'fit-content', margin: '0 auto',
        }}>
          <span style={{ color: focusInScene ? '#ff4b6e' : '#f59e0b' }}>●</span>
          {focusBerth}
          {focusInScene ? (
            <span style={{ display: 'inline-flex', gap: 10, color: '#cbd5e1', fontWeight: 600 }}>
              <span><span style={{ color: '#ff4b6e' }}>●</span> 대상 선석</span>
              <span><span style={{ color: '#f59e0b' }}>●</span> 이웃 선석</span>
            </span>
          ) : (
            <span style={{ color: '#94a3b8', fontWeight: 500 }}>장면 밖 선석</span>
          )}
        </div>
      )}
      
      {/* 관제 경고 배너 — 한 건씩 세워 놓고 자동으로 넘긴다.
          예전엔 경고 전문을 가로로 흘렸는데(marquee), 메시지가 189~229자라
          줄글이 지나가는 꼴이 되어 읽히지 않았다(2026-08-24 피드백).
          결론만 남기고 대상·유형을 따로 세운다 — 상세는 안전/환경 관제에서 본다. */}
      {tickerItems.length > 0 && (() => {
        const a = tickerItems[Math.min(tickerIdx, tickerItems.length - 1)];
        const p = alertParts(a);
        const st = levelStyle(a.level);
        return (
          <div
            className="twin-ticker"
            onMouseEnter={() => setTickerHold(true)}
            onMouseLeave={() => { setTickerHold(false); setTickerTick((t) => t + 1); }}
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: 38,
              background: 'rgba(11,18,32,0.94)', borderBottom: '2px solid rgba(232,238,247,0.12)',
              zIndex: 2000, display: 'flex', alignItems: 'center', gap: 10,
              padding: '0 14px', color: '#e8eef7', fontSize: 13, boxSizing: 'border-box', overflow: 'hidden',
            }}
          >
            <FaExclamationTriangle color={st.color} style={{ flexShrink: 0 }} />
            <span style={{
              flexShrink: 0, background: st.color, color: '#0b1220', fontWeight: 800,
              fontSize: 11, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.02em',
            }}>{st.label}</span>
            {/* 문장 대신 칸 — 대상 · 선석 · 등급 · 이유 · 조치(관제 경고 벨과 같은 규칙). 새 건은 아래에서 올라온다 */}
            <div className="tk-slide" key={`${tickerIdx}-${a.type}`}>
              <span style={{ flexShrink: 0, fontWeight: 800 }}>{p.title}</span>
              {p.place && <span style={{ flexShrink: 0, color: '#c3cede' }}>{p.place}{p.stage ? ` · ${p.stage}` : ''}</span>}
              {p.level && <span style={{ flexShrink: 0, fontWeight: 800, color: st.color }}>{p.level}</span>}
              <span style={{
                flex: 1, minWidth: 0, color: '#b8c4d6',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }} title={p.full}>
                {[p.cargo, p.why].filter(Boolean).join(' · ')}{p.action ? `  →  ${p.action}${p.recipient ? ` (${p.recipient})` : ''}` : ''}
              </span>
            </div>
            <span style={{ flexShrink: 0, color: '#ff8a80', fontSize: 11.5, fontWeight: 700 }}>위험 {dangerCount}</span>
            {tickerItems.length > 1 && (
              <span className="tk-nav">
                <button type="button" onClick={() => stepTicker(-1)} aria-label="이전 경고">‹</button>
                <span>{tickerIdx + 1}/{tickerItems.length}</span>
                <button type="button" onClick={() => stepTicker(1)} aria-label="다음 경고">›</button>
              </span>
            )}
            {/* 다음 경고까지 남은 시간 — 띠 아래 선이 차오른다(멈추면 선도 멈춘다) */}
            {tickerItems.length > 1 && (
              <span
                key={`p-${tickerIdx}-${tickerTick}`}
                className="tk-progress"
                style={{ background: st.color, animationDuration: `${TICKER_ROTATE_MS}ms`, animationPlayState: tickerHold ? 'paused' : 'running' }}
              />
            )}
          </div>
        );
      })()}

      {/* HUD Overlays — 2D 지도/스트리밍 중에는 숨김 */}
      {!showMap && !showOmniverseStream && (
        <>
          {/* 72시간을 보는 동안 레이더 · 선박 목록은 접는다 — 아래 72시간 패널과 겹쳤다(현우) */}
          {!outlookFocus && <RadarMap />}
          {/* 카메라 창도 접는다 — 지금의 현장을 비추는 창이라 72시간 뒤 장면과 섞이고, 움직이는 배를 가린다 */}
          {!outlookFocus && <CCTVPanel />}
          {!outlookFocus && <VesselTrafficList />}
          <BerthStatusBar />
          {selectedObject && !outlookFocus && (
            <InfoPopup object={selectedObject} onClose={() => setSelectedObject(null)} />
          )}
        </>
      )}

      {/* [2026-09-28] 머리 단추는 하나(현우 D4·D7). Omniverse 는 시연 PC 에서 켜지 않으므로 촬영한 정밀 검토 장면을 연다.
          실시간 스트림은 촬영용 주소(?omniverse=1)로만 켠다. 2D 지도는 대시보드 지도와 같아 뺐다. */}
      <div style={{ position: 'absolute', top: 90, right: 20, zIndex: 1000, display: 'flex', gap: '10px' }}>
        {showOmniverseStream ? (
          <button
            className="action-btn"
            onClick={() => setShowOmniverseStream(false)}
            style={{
              padding: '10px 16px', background: 'rgba(16, 185, 129, 0.8)', backdropFilter: 'blur(10px)', color: '#fff',
              border: '1px solid rgba(148, 163, 184, 0.45)', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold',
            }}
          >
            Omniverse 닫기
          </button>
        ) : (
          <>
          {!outlookFocus && (
            <button
              className="action-btn"
              onClick={openPortOutlook}
              title="온산항 전체의 앞으로 72시간 — 접안한 배가 떠나고 입항 예정 선박이 들어오는 흐름을 돌려 봅니다"
              style={{
                padding: '10px 16px', background: 'rgba(14, 116, 144, 0.85)', backdropFilter: 'blur(10px)', color: '#fff',
                border: '1px solid rgba(56, 189, 248, 0.6)', borderRadius: '8px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', whiteSpace: 'nowrap',
              }}
            >
              <FaFastForward /> 앞으로 72시간
            </button>
          )}
          <button
            className="action-btn"
            onClick={() => setOmniPreviewOpen(true)}
            title="같은 72시간 판정을 Omniverse 로 고화질 렌더링한 장면 — 같은 배가 조위 변화로 어떻게 바뀌는지 봅니다"
            style={{
              padding: '10px 16px', background: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(10px)', color: '#cbd5e1',
              border: '1px solid rgba(148, 163, 184, 0.45)', borderRadius: '8px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold',
            }}
          >
            <FaPlay /> 정밀 검토 · Omniverse
          </button>
          </>
        )}
      </div>

      {/* Omniverse WebRTC Streaming Player — 티커 아래에서 시작 */}
      {showOmniverseStream && (
        <div style={{ position: 'absolute', top: 30, left: 0, width: '100%', height: 'calc(100% - 30px)', zIndex: 850, background: '#000' }}>
          {/* 지금 Omniverse 가 무엇을 보여주려 하는지 — 영상만 보면 알 수 없다.
              지목은 3D 관제 화면에서 배·선석을 눌러 하고, 여기서는 과거 사례로 바꾸거나 풀 수 있다. */}
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 870,
            display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'center',
            maxWidth: 'calc(100% - 260px)', padding: '7px 12px', borderRadius: '10px',
            background: 'rgba(15, 23, 42, 0.88)', border: '1px solid rgba(148, 163, 184, 0.35)',
            color: '#e8f0f2', fontSize: '12.5px',
          }}>
            <span style={{ color: omniFocus ? '#10b981' : '#94a3b8' }}>●</span>
            <span style={{ fontWeight: 800 }}>
              {omniFocus
                ? `${omniFocus.vessel_name ? `${omniFocus.vessel_name} · ` : ''}${omniFocus.berth}`
                : '순환 재생'}
            </span>
            <span style={{ color: '#94a3b8' }}>
              {omniFocus ? '· 앞으로 72시간' : '· 지목 없음 — 3D 화면에서 배나 선석을 누르세요'}
            </span>
            <HelpTip title="정밀 검토">
              <div>지목한 선석의 <strong>앞으로 72시간</strong>을 기상청 단기예보 · 국립해양조사원 조석예보로 한 시각씩 판정합니다. 판정 규칙은 관제 화면과 같습니다.</div>
              <div style={{ marginTop: 4 }}>지목이 없으면 조감 → 과거 사례를 순환합니다. 3D 관제 화면에서 배나 선석을 누르고 [Omniverse 로 보기]를 누르면 그곳을 봅니다. 평소에는 이 화면 안의 [앞으로 72시간 판정 흐름]으로 봅니다.</div>
              <div style={{ marginTop: 4 }}>항만 전체의 입출항 흐름은 3D 관제 화면의 [앞으로 72시간]에서 돌려 봅니다. 여기는 지목한 선석 하나를 고화질로 봅니다.</div>
            </HelpTip>
            {replayCases.map((r) => (
              <button
                key={r.id}
                onClick={() => sendFocus({
                  berth: r.berth?.name, call_sign: r.vessel?.call_sign, vessel_name: r.vessel?.name,
                })}
                title={r.headline}
                style={{
                  padding: '3px 9px', borderRadius: '6px', cursor: 'pointer', fontSize: '11.5px',
                  fontWeight: 700, background: 'transparent', color: '#38bdf8',
                  border: '1px solid rgba(56, 189, 248, 0.5)',
                }}
              >
                과거 사례 {r.vessel?.name}
              </button>
            ))}
            {omniFocus && (
              <button
                onClick={() => sendFocus({})}
                style={{
                  padding: '3px 9px', borderRadius: '6px', cursor: 'pointer', fontSize: '11.5px',
                  fontWeight: 700, background: 'transparent', color: '#e8f0f2',
                  border: '1px solid rgba(232, 240, 242, 0.4)',
                }}
              >
                조감으로
              </button>
            )}
            {omniFocusError && (
              <span style={{ color: '#f59e0b', width: '100%', textAlign: 'center' }}>
                지목을 전하지 못했습니다({omniFocusError}) — Omniverse 는 순환 재생을 계속합니다
              </span>
            )}
          </div>

          {streamStatus === 'ok' && (
            <>
              {/* Isaac Sim 기동 직후에는 인코더가 준비되기 전 첫 프레임이 드롭돼
                  검은/흰 화면으로 남는 경우가 있다. 그때 세션만 다시 맺으면 복구된다. */}
              <button
                onClick={() => setStreamKey((k) => k + 1)}
                style={{
                  position: 'absolute', top: 12, left: 12, zIndex: 860,
                  padding: '7px 14px', background: 'rgba(15,23,42,0.85)',
                  color: '#38bdf8', border: '1px solid rgba(56,189,248,0.5)',
                  borderRadius: '8px', cursor: 'pointer', fontSize: '12px', fontWeight: 700,
                }}
                title="화면이 비어 있으면 눌러 세션을 다시 맺습니다"
              >
                ⟳ 스트림 다시 연결
              </button>
              <iframe
                key={streamKey}
                src={omniUrl}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="Omniverse WebRTC Stream"
                allow="camera; microphone; fullscreen; display-capture"
              />
            </>
          )}

          {streamStatus === 'checking' && (
            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#38bdf8', fontSize: '16px', fontWeight: 'bold',
            }}>
              Omniverse 스트리밍 서버 연결 확인 중...
            </div>
          )}

          {streamStatus === 'unreachable' && (
            <div style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: '14px',
              color: '#e8f0f2', textAlign: 'center', padding: '0 24px',
            }}>
              <FaExclamationTriangle size={42} color="#f59e0b" />
              <h2 style={{ margin: 0 }}>Omniverse 스트리밍이 실행되고 있지 않습니다</h2>
              <p style={{ margin: 0, color: '#94a3b8', maxWidth: '560px', lineHeight: 1.6 }}>
                웹 뷰어({OMNIVERSE_PORTS.map((p) => `:${p}`).join(', ')})에서 응답이 없습니다.<br />
                탐색기에서 <strong style={{ color: '#e8f0f2' }}>D:\omniverse\start_twin_onsite.bat</strong> 을 실행하면
                경량 트윈(관제 스택과 동시 구동용)과 웹 뷰어가 함께 켜집니다. 1~2분 뒤 [다시 연결 시도]를 누르세요.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={checkStream}
                  style={{
                    padding: '10px 18px', background: '#10b981', color: '#fff',
                    border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold',
                  }}
                >
                  다시 연결 시도
                </button>
                <button
                  onClick={() => setShowOmniverseStream(false)}
                  style={{
                    padding: '10px 18px', background: '#334155', color: '#fff',
                    border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold',
                  }}
                >
                  3D 시뮬레이션으로 돌아가기
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showMap && (
        /* 티커(30px) 아래에서 시작 → 지도 내부 버튼(온산확대·줌 등)이 가려지지 않음 */
        <div className="map-overlay" style={{ position: 'absolute', top: 30, left: 0, right: 0, bottom: 0, zIndex: 900 }}>
          <PortMap />
        </div>
      )}

      {/* [2026-09-30] 선박 상세 패널은 대시보드 몫 — 2D 지도를 뺀 뒤 여기 남아 있어 대시보드에서 연 선박이 3D 까지 따라왔다(현우) */}

      {/* 앞으로 72시간 — 이 화면 안의 판정 흐름. 2D 지도·Omniverse 위에는 띄우지 않는다 */}
      {outlookFocus && !showOmniverseStream && !showMap && (
        <OutlookTimeline
          focus={outlookFocus}
          onClose={closeOutlook}
          onBerth={focusBerthOutlook}
          onWide={widenOutlook}
        />
      )}

      {/* 시간축 — 지금(이 화면, 실측) ↔ 앞으로 72시간(예보). 스트리밍·판정 흐름 중에는 숨김.
          [2026-09-24] 예전 재생 슬라이더는 미래 이동을 지어내 재생해 껐다(실측이 아닌 것을 실측처럼 보이지 않게).
          [2026-09-27] 빈 슬라이더 대신 두 화면을 잇는 한 줄로. 밤에 다시: 앞으로 72시간도 이 화면 안에서(OutlookTimeline) — Omniverse 는 보조.
          위치 이력 되감기는 이력 연결 뒤 이 자리에 붙인다. */}
      {/* [2026-09-28] 아래 '지금 → 앞으로 72시간' 띠를 뺐다 — 정보창의 같은 단추와 겹쳤고 선박 목록을 가렸다(현우 D11).
          72시간은 배·선석(또는 위 선석 현황 띠)을 눌러 정보창에서 연다. */}
    </div>
  );
}
