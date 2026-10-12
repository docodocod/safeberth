"""하역 개시 인터락 상태 계산 (D5).

게이트는 **부두 진입이 아니라 하역 밸브 앞에 선다**(9/17 회의 B4, 프런트
HardwarePanel.jsx 주석). 그래서 이 게이트를 여는 근거는 "이 배가 들어와도 되나"가
아니라 **"지금 이 자리에서 하역을 시작해도 되나"** 다.

판정 근거는 회의 §8 이 정한 그대로다.

    하역중 단계의 최신 판정이 '부적합' 또는 '판정불가'  →  INTERLOCK

'판정불가'가 여는 쪽이 아니라 닫는 쪽인 게 핵심이다. 근거가 없다는 것은 안전
하다는 뜻이 아니다(회의 §4 "근거 부족을 안전과 구분"). weather/schemas.py 의
`UNKNOWN = "판단불가"` 가 이미 같은 원칙을 쓴다.

[assessment_history 가 아직 없을 때]
  전 게이트를 INTERLOCK 으로 둔다. 같은 원칙의 극단값이다 — 판정 체계 자체가
  연결되지 않았으면 우리는 아무것도 모르는 상태다. 이렇게 두면 하드웨어는
  판정 연결을 기다리지 않고 배선·릴레이 시험을 바로 시작할 수 있다.

[MQTT]
  아직 붙이지 않았다. backend/requirements.txt 에 클라이언트가 없고 브로커
  주소도 정해지지 않았다. 지금은 판정만으로 상태를 만들어 WS 로 내보낸다 —
  장치 없이도 화면과 인터락 로직이 전부 동작한다. 브로커가 정해지면
  `smartport/gate/+/status` 구독을 이 모듈 안에 꽂고 `fail_safe_ok` 를 장치
  실값으로 바꾸면 된다. **WS 계약은 바뀌지 않는다.**
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.assessment_history import GATE_BLOCKING_LEVELS, AssessmentStage

logger = logging.getLogger("gate_state")

# 프런트 mocks/mockHardware.js 의 "★ MQTT 토픽 계약 ★" 과 같은 값이어야 한다.
STATE_OPEN = "OPEN"
STATE_CLOSED = "CLOSED"
STATE_INTERLOCK = "INTERLOCK"

BEACON_GREEN = "GREEN"
BEACON_AMBER = "AMBER"
BEACON_RED = "RED"

MODE_AUTO = "AUTO"
MODE_MANUAL = "MANUAL"

_BLOCKING_VALUES = tuple(level.value for level in GATE_BLOCKING_LEVELS)


_QUERY_TABLE_EXISTS = text("SELECT to_regclass('public.assessment_history') IS NOT NULL")

# 게이트는 계선시설 단위다. 한 시설에 여러 배가 붙어 있으면 **가장 나쁜 판정**이
# 그 시설의 게이트를 정한다 — 한 배가 부적합인데 옆 배가 적합이라고 밸브를 열 수는 없다.
#
# [2026-10-12] 판단을 SQL 에서 gate_sources() 로 옮겼다. 실데이터로 재현한 세 문제 때문이다.
#   ① 부두별 대표 사유를 array_agg(reasons) 로 모았는데, 같은 부두 2척의 사유 개수가 다르면(6·7개)
#      PostgreSQL 이 'cannot accumulate arrays of different dimensionality' 로 죽었다 — 스냅샷·WS·수동 조작 API 전부 500.
#   ② 판정 잡은 결과가 같으면 새 행을 쓰지 않는다. 그런데 6시간 창만 보니, 같은 '부적합'이 6시간 넘게 이어진 배는
#      게이트 목록에서 사라졌다(관제 화면의 인터락 표시가 없어짐).
#   ③ '하역중' 필터를 최신 행 고르기 전에 걸어, 최신 판정이 바뀌어도(예: 접안직전 적합) 옛 '하역중' 판정이 계속 잠갔다.
# 옛 6시간 창의 의도는 "그 배는 이미 떠났을 수 있다"였다 — 이제 떠났는지를 AIS 접안 현황으로 직접 본다.
_QUERY_LATEST_JUDGMENTS = text("""
    -- 배별 최신 판정(단계 무관). 30일은 조회 비용 상한이다 — 한 판정이 30일 넘게 바뀌지 않고 계류하는 일은 드물다.
    SELECT DISTINCT ON (call_sign)
           call_sign, vessel_name, wharf_name, level, stage, reasons, assessed_at_utc
    FROM assessment_history
    WHERE assessed_at_utc > now() - interval '30 days'
    ORDER BY call_sign, assessed_at_utc DESC
""")

_QUERY_PRESENCE_EXISTS = text("SELECT to_regclass('mart.vessel_presence') IS NOT NULL")

# mart.vessel_presence 는 마지막 위치 수집 시각을 기준으로 한다(now() 가 아님). 수집이 멈춰도 배가 사라지지 않아
# 게이트가 그 때문에 풀리지는 않는다.
_QUERY_PRESENCE = text("""
    SELECT upper(btrim(callsgn)) AS call_sign, presence_zone, berth_name
    FROM mart.vessel_presence
    WHERE NULLIF(btrim(callsgn), '') IS NOT NULL
""")

# AIS 기록이 없는 배(떠났는지 알 수 없음)는 옛 규칙대로 이 시간 안의 판정만 반영한다.
_NO_PRESENCE_WINDOW = timedelta(hours=6)


def _norm(call_sign: str | None) -> str:
    return (call_sign or "").strip().upper()


async def load_gate_inputs(db: AsyncSession) -> tuple[list[dict], dict[str, tuple[str | None, str | None]]]:
    """(배별 최신 판정, AIS 접안 현황). mart.vessel_presence 가 없으면 접안 현황은 비어 있다(→ 6시간 창으로 판단)."""
    judgments = [dict(r) for r in (await db.execute(_QUERY_LATEST_JUDGMENTS)).mappings().all()]
    presence: dict[str, tuple[str | None, str | None]] = {}
    if (await db.execute(_QUERY_PRESENCE_EXISTS)).scalar():
        for r in (await db.execute(_QUERY_PRESENCE)).mappings().all():
            # 같은 호출부호가 여러 위치 행으로 잡히면 접안(BERTH) 행을 우선한다 — 접안 사실을 놓치지 않게.
            if r["call_sign"] not in presence or r["presence_zone"] == "BERTH":
                presence[r["call_sign"]] = (r["presence_zone"], r["berth_name"])
    return judgments, presence


def active_cargo_judgments(
    judgments: list[dict], presence: dict[str, tuple[str | None, str | None]], now: datetime,
) -> dict[str, list[dict]]:
    """부두별로, 지금 그 부두에서 하역 중인 배의 최신 판정. 게이트와 에이전트 팀 도구(same_wharf_status)가 같이 쓴다.

    judgments 는 배별 **최신** 판정(단계 무관), presence 는 호출부호 → (AIS 구역, 접안 부두). 넣는 조건 — 최신 판정이
    '하역중'이고:
      · AIS 상 그 부두에 접안 중이면 → 판정 시각과 상관없이 넣는다(②: 변화 없는 부적합이 계속 잠근다)
      · AIS 상 다른 곳에 있거나 움직이는 중이면 → 뺀다(떠났다는 증거)
      · AIS 기록이 없으면 → 6시간 이내 판정만 넣는다(모르는 경우는 옛 동작 그대로)
    """
    by_wharf: dict[str, list[dict]] = {}
    for j in judgments:
        if j["stage"] != AssessmentStage.DURING_CARGO.value or not j["wharf_name"]:
            continue
        seen = presence.get(_norm(j["call_sign"]))
        if seen is None:
            if now - j["assessed_at_utc"] > _NO_PRESENCE_WINDOW:
                continue
        elif seen != ("BERTH", j["wharf_name"]):
            continue
        by_wharf.setdefault(j["wharf_name"], []).append(j)
    return by_wharf


def gate_sources(
    judgments: list[dict], presence: dict[str, tuple[str | None, str | None]], now: datetime,
) -> list[dict]:
    """부두별 게이트 근거 — active_cargo_judgments 를 부두 하나의 대표 판정으로 줄인다."""
    by_wharf = active_cargo_judgments(judgments, presence, now)
    out = []
    for wharf, rows in sorted(by_wharf.items()):
        # 대표 = 막는 판정 중 가장 최근, 없으면 가장 최근 판정.
        lead = max(rows, key=lambda r: (r["level"] in _BLOCKING_VALUES, r["assessed_at_utc"]))
        out.append({
            "wharf_name": wharf,
            "vessel_count": len(rows),
            "blocked": any(r["level"] in _BLOCKING_VALUES for r in rows),
            "lead_call_sign": lead["call_sign"],
            "lead_vessel_name": lead["vessel_name"],
            "lead_level": lead["level"],
            "lead_reasons": list(lead["reasons"] or []),
            "assessed_at_utc": max(r["assessed_at_utc"] for r in rows),
        })
    return out


def _gate_id(wharf_name: str) -> str:
    """계선시설명 → 게이트 식별자. 장치 토픽(`smartport/gate/{id}/…`)에 쓰인다."""
    return f"G-{wharf_name}"


async def build_gate_snapshot(db: AsyncSession, *, manual_overrides: dict | None = None) -> dict:
    """지금 게이트 상태 한 벌. 프런트 `useHardwareData` 가 기대하는 형태 그대로."""
    now = datetime.now(timezone.utc)
    overrides = manual_overrides or {}

    has_history = bool((await db.execute(_QUERY_TABLE_EXISTS)).scalar())
    if not has_history:
        # 판정 체계 미연결 — 모르면 닫는다.
        return {
            "gates": [],
            "assessment_connected": False,
            "note": "판정 이력(assessment_history)이 없어 모든 게이트를 인터락으로 둡니다.",
            "ts_utc": now.isoformat(),
        }

    judgments, presence = await load_gate_inputs(db)
    rows = gate_sources(judgments, presence, now)

    gates = []
    for row in rows:
        wharf = row["wharf_name"]
        gate_id = _gate_id(wharf)
        blocked = bool(row["blocked"])
        reasons = list(row["lead_reasons"] or [])

        if blocked:
            state, beacon, mode = STATE_INTERLOCK, BEACON_RED, MODE_AUTO
        else:
            # 판정이 통과해도 **자동으로 열지 않는다.** 하역 개시는 터미널의
            # 결정이다(회의 §2) — 우리는 "막을 이유가 없다"까지만 말한다.
            override = overrides.get(gate_id)
            if override == "APPROVE":
                state, beacon, mode = STATE_OPEN, BEACON_GREEN, MODE_MANUAL
            elif override == "BLOCK":
                state, beacon, mode = STATE_CLOSED, BEACON_AMBER, MODE_MANUAL
            else:
                state, beacon, mode = STATE_CLOSED, BEACON_AMBER, MODE_AUTO

        gates.append({
            "gate_id": gate_id,
            "name": f"{wharf} 하역 개시 인터락",
            "state": state,
            "mode": mode,
            "beacon": beacon,
            # 장치가 없으므로 페일세이프 회로 상태를 실제로는 모른다. 장치 연동
            # 전까지 True 로 두되, assessment_connected 와 함께 화면이 "장치
            # 미연결"임을 알 수 있게 한다 — 모르는 값을 아는 척하지 않는다.
            "fail_safe_ok": True,
            "ts_utc": now.isoformat(),
            # ↓ 판정 근거. 게이트가 왜 닫혔는지 관제사가 화면에서 바로 읽게 한다.
            "wharf_name": wharf,
            "level": row["lead_level"],
            "call_sign": row["lead_call_sign"],
            "vessel_name": row["lead_vessel_name"],
            "vessel_count": row["vessel_count"],
            "reasons": reasons,
            "assessed_at_utc": row["assessed_at_utc"].isoformat() if row["assessed_at_utc"] else None,
        })

    return {
        "gates": gates,
        "assessment_connected": True,
        "device_connected": False,  # MQTT 미연결 — 위 docstring 참고
        "ts_utc": now.isoformat(),
    }


def is_interlocked(snapshot: dict, gate_id: str) -> bool:
    """이 게이트가 인터락 상태인가. 모르는 게이트는 **인터락으로 본다**(모르면 닫는다)."""
    for gate in snapshot.get("gates", []):
        if gate["gate_id"] == gate_id:
            return gate["state"] == STATE_INTERLOCK
    return True
