"""판정 그래프 — _judge 의 LangGraph 이식 (2026-10-11).

DB·그래프 없이 도구 계층을 바꿔치기해 노드 연결과 조기 종료만 본다. 판정 내용 자체는
test_supervisor_20260927.py · test_agent_fixes_20260926.py 가 이식 전후 같은 코드로 본다.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.agents import tools
from app.agents.orchestrator import service as orch
from app.agents.orchestrator.graph import build_judge_graph
from app.agents.orchestrator.schemas import OrchestratorRequest, OverallDecision
from app.agents.safety.schemas import CargoRef, RiskLevel, SafetyAssessmentResult
from app.agents.scheduling.schemas import BerthCandidate, OccupancyStatus, VesselSpec
from app.agents.tools import BerthCheck
from app.agents.weather.schemas import ObservationFactor, WeatherAssessmentResult, WorkStatus

NOW = datetime.now(timezone.utc)


def _request() -> OrchestratorRequest:
    return OrchestratorRequest(
        vessel=VesselSpec(draught_m=9.0, call_sign="TEST"),
        cargo=CargoRef(chem_id="001008"),
        window_start=NOW, window_end=NOW + timedelta(hours=24),
        assigned_wharf_name="효성부두",
    )


def _weather(status: WorkStatus) -> WeatherAssessmentResult:
    obs = ObservationFactor(value=5.0, unit="m/s", is_stale=False)
    return WeatherAssessmentResult(
        status=status, assessed_at_utc=NOW, wind=obs, wave=obs, reasons=["x"], forecast_warning=None,
    )


def _candidate() -> BerthCandidate:
    return BerthCandidate(
        rank=1, berth_id="효성부두", wharf_name="효성부두", port_name="온산항", depth_m=12.0,
        draught_margin_m=3.0, occupancy_status=OccupancyStatus.AVAILABLE,
    )


def _safe() -> SafetyAssessmentResult:
    return SafetyAssessmentResult.model_construct(
        target_cargo_name="벤젠", risk_level=RiskLevel.SAFE, rule_engine_floor=RiskLevel.SAFE,
        conflicts=[], bulk_compatibility_conflicts=[], packaging_violations=[], unassessed_pairs=[],
        cargo_verdicts=[], checklist=[], key_hazards=[], reasoning="", onboard_conflicts=[],
        adjacent_count=0, verdict_basis=[], needs_check=[], cargo_profile="",
    )


def test_graph_has_the_three_judgment_nodes():
    graph = build_judge_graph(None, None, None, None)
    names = set(graph.get_graph().nodes)
    assert {"berth", "weather", "segregation"} <= names


@pytest.mark.asyncio
async def test_berth_evidence_missing_stops_before_weather_and_alternatives(monkeypatch):
    # 근거 부족이면 어디가 문제인지도 모르는 채 다른 자리를 권하지 않는다(기존 동작) — 그래프도 그 자리에서 끝난다
    weather_calls, alt_calls = [], []

    async def fake_berth(*a, **k):
        return BerthCheck(candidate=None, reason="표기 미해소", evidence_missing=True)

    async def fake_weather(db, **k):
        weather_calls.append(k)
        return _weather(WorkStatus.NORMAL)

    async def fake_alternatives(*a, **k):
        alt_calls.append(1)
        return tools.Alternatives()

    monkeypatch.setattr(orch.tools, "check_berth", fake_berth)
    monkeypatch.setattr(orch.tools, "check_weather", fake_weather)
    monkeypatch.setattr(orch.tools, "suggest_alternatives", fake_alternatives)

    result = await orch._judge(None, None, None, _request())

    assert result.overall_decision is OverallDecision.NO_ELIGIBLE_BERTH
    assert result.evidence_missing is True
    assert len(weather_calls) == 1          # 전역 폴백 판정 한 번뿐, 선석별 기상은 가지 않았다
    assert alt_calls == []                  # 대체 선석도 찾지 않았다
    assert [o.axis for o in result.opinions] == ["선석"]


@pytest.mark.asyncio
async def test_weather_stop_ends_before_segregation(monkeypatch):
    async def fake_berth(*a, **k):
        return BerthCheck(candidate=_candidate())

    async def fake_weather(db, **k):
        return _weather(WorkStatus.STOP)

    async def fake_segregation(*a, **k):
        raise AssertionError("기상 중단이면 혼재 심사까지 가지 않는다")

    async def fake_alternatives(*a, **k):
        return tools.Alternatives()

    monkeypatch.setattr(orch.tools, "check_berth", fake_berth)
    monkeypatch.setattr(orch.tools, "check_weather", fake_weather)
    monkeypatch.setattr(orch.tools, "check_segregation", fake_segregation)
    monkeypatch.setattr(orch.tools, "suggest_alternatives", fake_alternatives)

    result = await orch._judge(None, None, None, _request())

    assert result.overall_decision is OverallDecision.WEATHER_BLOCKED
    assert [o.axis for o in result.opinions] == ["선석", "기상"]


@pytest.mark.asyncio
async def test_defer_list_receives_narration_coroutine(monkeypatch):
    # 혼재 서술 LLM 은 판정 중에 기다리지 않고 defer 목록에 쌓인다(2026-09-29) — 그래프를 거쳐도 같다
    ran = []

    async def narrate():
        ran.append(1)

    async def fake_berth(*a, **k):
        return BerthCheck(candidate=_candidate())

    async def fake_weather(db, **k):
        return _weather(WorkStatus.NORMAL)

    async def fake_segregation(*a, defer=None, **k):
        defer.append(narrate())
        return _safe()

    monkeypatch.setattr(orch.tools, "check_berth", fake_berth)
    monkeypatch.setattr(orch.tools, "check_weather", fake_weather)
    monkeypatch.setattr(orch.tools, "check_segregation", fake_segregation)

    pending: list = []
    result = await orch._judge(None, None, None, _request(), defer=pending)

    assert result.overall_decision is OverallDecision.APPROVED
    assert len(pending) == 1 and ran == []   # 아직 안 돌았다
    await asyncio.gather(*pending)
    assert ran == [1]
