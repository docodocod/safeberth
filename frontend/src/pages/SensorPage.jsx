import useSensorStore from '../stores/useSensorStore';
import { TankModel, PipeModel } from '../components/sensor/EquipmentModels';
import { COLORS } from '../utils/constants';
import HardwarePanel from '../components/sensor/HardwarePanel';
import HelpTip from '../components/common/HelpTip';
import { showDisclosure } from '../utils/disclosure';

// ─────────────────────────────────────────────────────────────────────────────
// 센서 데이터 — 현장 설비 계측
//
// 이 화면만 실데이터가 아니다. 그 사실을 화면이 직접 말해야 한다.
//
// 예전에는 "IoT 센서 네트워크에서 수집되는 실시간 데이터"라고 적고 우상단에 빨간
// "WebSocket Disconnected" 를 띄우고 있었다. 둘 다 사실과 달랐다 —
//   · 수집하는 IoT 센서가 없다(탱크 수위계·유량계·압력계는 8/3 회의에서 실물 보류).
//   · 끊긴 게 아니라 애초에 연결을 시도하는 코드가 어디에도 마운트돼 있지 않았다.
//     (useWebSocket 훅은 존재했지만 어느 컴포넌트도 부르지 않았다. WS_URL 도 8000을
//      보고 있었는데 백엔드는 8001이고 /ws 엔드포인트 자체가 없다.)
//
// 그래서 "고장난 실시간"처럼 보였다. 지금은 시뮬레이션이라고 밝히고, 무엇이 있으면
// 실데이터가 되는지까지 적는다. 값이 멈춰 있는 것도 정상 동작이라고 말해 둔다.
// ─────────────────────────────────────────────────────────────────────────────

export default function SensorPage() {
  const { tanks, pipes } = useSensorStore();
  // [2026-09-29 밤] 시연 화면은 완성된 모습 — 예시값 표식·점선 구역은 ?disclose=1 일 때만
  const disclose = showDisclosure();

  return (
    <div className="page-content" style={{ padding: '0' }}>
      <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '20px', marginBottom: '6px', display: 'flex', alignItems: 'center' }}>
            현장 설비
            <HelpTip title="현장 설비">
              {disclose
                ? '하역 개시 인터락 게이트는 실물(라즈베리파이·밸브)과 연결됩니다. 아래 탱크·배관은 계측기가 없어 점선 구역에 예시값으로 둔 연결 예정 화면입니다.'
                : '하역 개시 인터락 게이트와 저장탱크 · 이송배관 계측을 봅니다.'}
            </HelpTip>
          </h2>
          {disclose && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', margin: 0 }}>
              하역 개시 게이트 <strong>실물</strong> 2대 · 탱크·배관 <strong>예시값</strong>
            </p>
          )}
        </div>
        {/* '시뮬레이션 모드' 배지도 내렸다(2026-08-23) — 시연 UI 는 도입 후 제품
            모습을 보여준다는 원칙. 이 탭의 값이 하드웨어 부재로 모형이라는 사실은
            설계서·보고서 한계점 절에 명시한다. */}
      </div>

      {/* "실측 아님" 장문 안내는 내렸다(2026-08-21 피드백) — 데이터 계보는
          설계문서 몫. 단 이 탭만은 값 자체가 모형이라, 실측으로 오인하지 않을
          최소 표식(상단 배지 + 툴팁)은 남긴다. 나머지 화면이 전부 실데이터라는
          주장 자체를 지키기 위한 표식이다. */}

      <HardwarePanel />

      {/* [2026-09-28] 탱크·배관은 계측기가 없어 예시값이다. 실물 게이트와 섞이지 않게 점선 · 빗금 구역에 두고
          상태 램프(ACTIVE·FLOWING)를 끄고 '예시값' 표식을 붙인다. 판정·게이트에는 쓰지 않는다. */}
      <section className={disclose ? 'virtual-zone' : undefined} style={{ marginTop: '32px' }} aria-label="저장탱크 · 이송배관">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: disclose ? '6px' : '14px' }}>
          <h3 style={{ fontSize: '16px', margin: 0, color: disclose ? COLORS.textSecondary : COLORS.textPrimary }}>
            {disclose ? '연결 예정 계측 — 탱크 · 배관' : '저장탱크 · 이송배관'}
          </h3>
          {disclose && (
            <span style={{ fontSize: '11.5px', fontWeight: 800, color: '#5F6F78', border: '1px dashed #9AA8B0', borderRadius: '999px', padding: '2px 10px' }}>
              가상 · 계측기 미연결
            </span>
          )}
        </div>
        {disclose && (
          <p style={{ fontSize: '12.5px', color: COLORS.textDim, margin: '0 0 14px' }}>
            터미널 탱크 레벨계 · 유량계를 연결하면 이렇게 보입니다. 지금 숫자는 예시값이며 판정과 게이트에 쓰지 않습니다.
          </p>
        )}
        <h4 style={{ fontSize: '13px', margin: '0 0 10px', color: COLORS.textSecondary }}>저장탱크 수위 · 온도 · 압력</h4>
        <div className="sensor-grid">
          {tanks.map((tank) => <TankModel key={tank.id} tank={tank} />)}
        </div>
        <h4 style={{ fontSize: '13px', margin: '20px 0 10px', color: COLORS.textSecondary }}>이송 배관 유량 · 압력</h4>
        <div className="sensor-grid">
          {pipes.map((pipe) => <PipeModel key={pipe.id} pipe={pipe} />)}
        </div>
      </section>

    </div>
  );
}
