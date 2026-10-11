"""도구 상자 — 조회 도구와 발견을 만드는 도구 (2026-10-12, 계획 2).

새 판정 로직은 두지 않는다. 기존 운영 조회(`app/agents/tools.py`), 규칙 전용 혼재 판정(`assess_verdict`), DB 뷰를
부르고, 결과를 짧은 JSON 문자열과 **발견(Finding)**으로 돌려준다. 모델이 정하는 것은 도구 인자뿐이다 — 선박·화물·
체류 구간 같은 판정 맥락은 요청(request)이 쥐고 있어 모델이 바꿀 수 없다.

발견을 만드는 도구:
  same_wharf_status            현재 — 같은 부두에서 하역 중인 **다른** 선박의 최신 판정이 부적합·판정불가.
                               게이트 규칙(회의 §8, services/gate_state.py)과 같은 조건이다. 자기 판정은 뺀다(순환 방지).
  upcoming_neighbor_conflicts  예정 — 체류 구간 안에 이 부두·인접 부두로 입항 예정인 선박(PORT-MIS)의 화물과
                               혼재 규칙(assess_verdict)이 '안전'이 아님. 예정값이라 조건의 근거만 된다(결정 7-1,
                               동시 계류 과대 계산 실측 7/125 — scheduling/occupancy.py).
정보만 주는 도구: who_is_at · where_is · wind_trend(상향 근거로 쓸 '임계 근접' 기준의 출처가 없다).
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

from langchain_core.tools import BaseTool, StructuredTool
from neo4j import AsyncDriver
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents import tools as judgment_tools
from app.agents.orchestrator.schemas import OrchestratorRequest
from app.agents.safety.schemas import AdjacentCargo, CargoRef, RiskLevel, SafetyAssessmentRequest
from app.agents.safety.service import assess_verdict
from app.models.assessment_history import GATE_BLOCKING_LEVELS, AssessmentStage

from .findings import Finding

# 도구 결과를 모델에게 돌려줄 때의 길이 상한(글자). 부두에 붙은 배가 많으면 프롬프트가 불어난다.
_MAX_RESULT_CHARS = 1500
_MAX_WIND_HOURS = 24

# 게이트 규칙과 같은 조건(gate_state._QUERY_GATE_SOURCE) — 하역중 단계, 6시간 이내 최신 판정.
_SQL_SAME_WHARF_BLOCKED = text("""
    WITH latest AS (
        SELECT DISTINCT ON (call_sign) call_sign, vessel_name, wharf_name, level, reasons, assessed_at_utc
        FROM assessment_history
        WHERE stage = :during_cargo
          AND assessed_at_utc > CAST(:now AS timestamptz) - interval '6 hours'
          AND assessed_at_utc <= CAST(:now AS timestamptz)
        ORDER BY call_sign, assessed_at_utc DESC
    )
    SELECT call_sign, vessel_name, level, reasons[1] AS reason, assessed_at_utc
    FROM latest
    WHERE wharf_name = :wharf
      AND level = ANY(CAST(:blocking AS text[]))
      AND upper(btrim(call_sign)) <> upper(btrim(coalesce(CAST(:exclude AS text), '')))
    ORDER BY assessed_at_utc DESC
""")

_SQL_UPCOMING_ARRIVALS = text("""
    SELECT a.callsgn, a.assigned_wharf_name AS wharf_name, a.arrival_at_utc, a.departure_at_utc,
           array_remove(array_agg(DISTINCT c.chem_id), NULL) AS chem_ids,
           array_remove(array_agg(DISTINCT coalesce(c.msds_name_ko, c.cargo_name_raw)), NULL) AS cargo_names
    FROM mart.arrival_schedule a
    LEFT JOIN mart.cargo_msds c
      ON c.callsgn = a.callsgn AND c.entry_year = a.entry_year AND c.entry_count = a.entry_count
    WHERE a.assigned_wharf_name = ANY(:wharfs)
      AND a.arrival_at_utc >= CAST(:now AS timestamptz)
      AND a.arrival_at_utc <= CAST(:until AS timestamptz)
      AND upper(btrim(a.callsgn)) <> upper(btrim(coalesce(CAST(:exclude AS text), '')))
    GROUP BY a.callsgn, a.assigned_wharf_name, a.arrival_at_utc, a.departure_at_utc
    ORDER BY a.arrival_at_utc
""")

_SQL_WIND_SERIES = text("""
    SELECT observed_at_utc, station_name, wind_speed_ms
    FROM weather_obs
    WHERE wind_speed_ms IS NOT NULL
      AND observed_at_utc > CAST(:since AS timestamptz) AND observed_at_utc <= CAST(:until AS timestamptz)
    ORDER BY observed_at_utc
    LIMIT 200
""")


async def _fetch_same_wharf_blocked(db: AsyncSession, *, wharf: str, exclude_call_sign: str | None, now: datetime) -> list[dict]:
    rows = (await db.execute(_SQL_SAME_WHARF_BLOCKED, {
        "during_cargo": AssessmentStage.DURING_CARGO.value, "now": now, "wharf": wharf,
        "blocking": [lv.value for lv in GATE_BLOCKING_LEVELS], "exclude": exclude_call_sign,
    })).mappings().all()
    return [dict(r) for r in rows]


async def _fetch_upcoming_arrivals(
    db: AsyncSession, *, wharfs: list[str], now: datetime, until: datetime, exclude_call_sign: str | None,
) -> list[dict]:
    rows = (await db.execute(_SQL_UPCOMING_ARRIVALS, {
        "wharfs": wharfs, "now": now, "until": until, "exclude": exclude_call_sign,
    })).mappings().all()
    return [dict(r) for r in rows]


async def _fetch_wind_series(db: AsyncSession, *, since: datetime, until: datetime) -> list[dict]:
    rows = (await db.execute(_SQL_WIND_SERIES, {"since": since, "until": until})).mappings().all()
    return [dict(r) for r in rows]


def _brief(value: BaseModel | list[BaseModel]) -> str:
    if isinstance(value, list):
        text_ = "[" + ",".join(v.model_dump_json(exclude_none=True) for v in value) + "]"
    else:
        text_ = value.model_dump_json(exclude_none=True)
    return text_[:_MAX_RESULT_CHARS]


def _payload(findings: list[Finding], notes: list[str]) -> str:
    """발견을 먼저 싣는다 — 길이 상한에 잘려도 발견 id 가 모델에게 보이게."""
    body = {
        "findings": [f.model_dump(mode="json", exclude={"condition_text"}) for f in findings],
        "notes": notes,
    }
    return json.dumps(body, ensure_ascii=False)[:_MAX_RESULT_CHARS]


def _kst(dt: datetime) -> str:
    return f"{dt.astimezone(timezone(timedelta(hours=9))):%m/%d %H:%M} KST"


class Toolbox:
    def __init__(
        self, db: AsyncSession, neo4j_driver: AsyncDriver, request: OrchestratorRequest, *, now: datetime | None = None,
    ) -> None:
        self._db = db
        self._neo4j = neo4j_driver
        self._request = request
        self._now = now or request.weather_as_of or datetime.now(timezone.utc)
        # ToolNode 는 한 응답의 여러 도구 호출을 병렬로 돌릴 수 있는데 AsyncSession 은 동시 사용이 안 된다 —
        # DB·그래프를 쓰는 도구는 이 락으로 한 번에 하나씩만 돈다.
        self._lock = asyncio.Lock()
        self.calls: list[str] = []
        self.findings: dict[str, Finding] = {}
        who, where = self._who_is_at(), self._where_is()
        self._by_agent: dict[str, list[BaseTool]] = {
            "선석": [who, where, self._same_wharf_status()],
            "기상": [self._wind_trend()],
            "혼재": [who, where, self._upcoming_neighbor_conflicts()],
        }

    def tools_for(self, agent: str) -> list[BaseTool]:
        return list(self._by_agent[agent])

    def _add(self, **fields) -> Finding:
        finding = Finding(id=f"F{len(self.findings) + 1}", **fields)
        self.findings[finding.id] = finding
        return finding

    def _who_is_at(self) -> StructuredTool:
        async def who_is_at(wharf: str) -> str:
            """부두 1곳에 지금 붙어 있는 배(화물·최근 판정 포함)와 인접 부두에 붙어 있는 배를 돌려준다. wharf 는 부두 이름."""
            async with self._lock:
                self.calls.append("who_is_at")
                found = await judgment_tools.who_is_at(self._db, self._neo4j, wharf=wharf)
            return "해당 부두를 찾지 못했습니다" if found is None else _brief(found)

        return StructuredTool.from_function(coroutine=who_is_at, name="who_is_at")

    def _where_is(self) -> StructuredTool:
        async def where_is(query: str) -> str:
            """호출부호 또는 선박명(일부)으로 배를 찾아 지금 위치(접안·정박지·항해 중)·속력·화물·최근 판정을 돌려준다."""
            async with self._lock:
                self.calls.append("where_is")
                found = await judgment_tools.where_is(self._db, query=query)
            return "일치하는 선박이 없습니다" if not found else _brief(found)

        return StructuredTool.from_function(coroutine=where_is, name="where_is")

    def _same_wharf_status(self) -> StructuredTool:
        async def same_wharf_status() -> str:
            """판정 대상 부두에서 하역 중인 다른 선박의 최신 판정 중 '부적합'·'판정불가'를 찾는다. 있으면 그 부두의
            하역 밸브 게이트가 잠긴다(회의 §8). 결과의 발견(id)은 등급 상향의 근거가 될 수 있다."""
            req = self._request
            async with self._lock:
                self.calls.append("same_wharf_status")
                rows = await _fetch_same_wharf_blocked(
                    self._db, wharf=req.assigned_wharf_name, exclude_call_sign=req.vessel.call_sign, now=self._now,
                )
            if not rows:
                return _payload([], ["같은 부두에서 하역을 막는 다른 선박의 판정이 없습니다"])
            found = [
                self._add(
                    kind="SAME_WHARF_BLOCKED", tense="현재", supports="주의",
                    wharf_name=req.assigned_wharf_name, call_sign=r["call_sign"],
                    facts=[f"같은 부두 '{req.assigned_wharf_name}'의 {r['vessel_name'] or r['call_sign']}({r['call_sign']}) "
                           f"최신 판정 '{r['level']}' ({_kst(r['assessed_at_utc'])}) — {r['reason'] or '사유 없음'}"],
                )
                for r in rows
            ]
            return _payload(found, [])

        return StructuredTool.from_function(coroutine=same_wharf_status, name="same_wharf_status")

    def _upcoming_neighbor_conflicts(self) -> StructuredTool:
        async def upcoming_neighbor_conflicts() -> str:
            """체류 구간 안에 이 부두와 인접 부두로 입항 예정인 선박(PORT-MIS)의 화물이 이 배 화물과 혼재 규칙에 걸리는지
            점검한다. **예정 일정이라 확정 사실이 아니다** — 결과의 발견(id)은 조건의 근거로만 쓸 수 있다. 일정의
            신뢰도는 where_is 로 그 배의 지금 위치를 보고 판단하라."""
            req = self._request
            notes: list[str] = []
            found: list[Finding] = []
            async with self._lock:
                self.calls.append("upcoming_neighbor_conflicts")
                berth = await judgment_tools.who_is_at(self._db, self._neo4j, wharf=req.assigned_wharf_name)
                wharfs = (
                    [req.assigned_wharf_name] if berth is None
                    else [berth.wharf_name, *(n.wharf_name for n in berth.neighbors)]
                )
                arrivals = await _fetch_upcoming_arrivals(
                    self._db, wharfs=wharfs, now=self._now, until=req.window_end,
                    exclude_call_sign=req.vessel.call_sign,
                )
                for a in arrivals:
                    when = _kst(a["arrival_at_utc"])
                    cargo = "·".join(a["cargo_names"]) or "화물명 없음"
                    head = f"{a['callsgn']} '{a['wharf_name']}' {when} 입항 예정({cargo})"
                    if not a["chem_ids"]:
                        notes.append(f"{head} — 화물이 MSDS 와 매칭되지 않아 혼재 판정 불가")
                        continue
                    verdict = await assess_verdict(self._db, self._neo4j, SafetyAssessmentRequest(
                        target_cargo=req.cargo, target_cargos=req.cargos,
                        adjacent_cargos=[
                            AdjacentCargo(berth_name=a["wharf_name"], cargo=CargoRef(chem_id=c)) for c in a["chem_ids"]
                        ],
                    ))
                    if verdict.risk_level is RiskLevel.SAFE:
                        notes.append(f"{head} — 혼재 규칙 '안전'")
                        continue
                    found.append(self._add(
                        kind="UPCOMING_NEIGHBOR_CONFLICT", tense="예정",
                        supports="부적합" if verdict.risk_level is RiskLevel.BLOCKED else "주의",
                        wharf_name=a["wharf_name"], call_sign=a["callsgn"], starts_at_utc=a["arrival_at_utc"],
                        facts=[f"{head} — 혼재 규칙 '{verdict.risk_level.value}'"],
                        condition_text=(
                            f"체류 중 {when} '{a['wharf_name']}'에 입항 예정인 {a['callsgn']}({cargo})의 화물과 혼재 규칙 "
                            f"'{verdict.risk_level.value}' — PORT-MIS 예정 일정이므로 입항 전 재확인"
                        ),
                    ))
            if not arrivals:
                notes.append("체류 구간 안에 이 부두·인접 부두로 입항 예정인 선박이 없습니다(PORT-MIS 기준)")
            return _payload(found, notes)

        return StructuredTool.from_function(coroutine=upcoming_neighbor_conflicts, name="upcoming_neighbor_conflicts")

    def _wind_trend(self) -> StructuredTool:
        async def wind_trend(hours: int = 6) -> str:
            """최근 몇 시간(1~24)의 관측 풍속 시계열. 정보용 — 임계값 판정은 이미 규칙 하한에 반영돼 있다."""
            span = max(1, min(int(hours), _MAX_WIND_HOURS))
            async with self._lock:
                self.calls.append("wind_trend")
                rows = await _fetch_wind_series(self._db, since=self._now - timedelta(hours=span), until=self._now)
            if not rows:
                return f"최근 {span}시간 풍속 관측이 없습니다"
            series = [f"{_kst(r['observed_at_utc'])} {r['station_name'] or ''} {r['wind_speed_ms']}m/s" for r in rows]
            return json.dumps({"hours": span, "series": series}, ensure_ascii=False)[:_MAX_RESULT_CHARS]

        return StructuredTool.from_function(coroutine=wind_trend, name="wind_trend")
