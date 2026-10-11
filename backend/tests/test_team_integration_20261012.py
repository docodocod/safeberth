"""에이전트 팀 ↔ 판정 그래프 — 세 규칙(하한·현재 발견·팀 상한)과 조건 (2026-10-12). DB·네트워크 없음."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage
from scripted_chat import ScriptedChat, tool_call

from app.agents import tools
from app.agents.orchestrator import service as orch
from app.agents.orchestrator.schemas import LLMSummary, OrchestratorRequest, OverallDecision
from app.agents.safety.schemas import CargoRef, RiskLevel, SafetyAssessmentResult
from app.agents.scheduling.schemas import BerthCandidate, OccupancyStatus, VesselSpec
from app.agents.team import toolbox as tb
from app.agents.team.team import Team
from app.agents.team.toolbox import Toolbox
from app.agents.tools import BerthCheck
from app.agents.weather.schemas import ObservationFactor, WeatherAssessmentResult, WorkStatus

NOW = datetime.now(timezone.utc)


class _NoSummaryLLM:
    async def generate_structured(self, *, schema, **_):
        return schema(**{name: "" for name in schema.model_fields}) if schema is LLMSummary else None


def _request() -> OrchestratorRequest:
    return OrchestratorRequest(
        vessel=VesselSpec(draught_m=9.0, call_sign="TEST"), cargo=CargoRef(chem_id="001008"),
        window_start=NOW, window_end=NOW + timedelta(hours=24), assigned_wharf_name="효성부두",
    )


def _weather(status: WorkStatus) -> WeatherAssessmentResult:
    obs = ObservationFactor(value=5.0, unit="m/s", is_stale=False)
    return WeatherAssessmentResult(status=status, assessed_at_utc=NOW, wind=obs, wave=obs, reasons=["x"], forecast_warning=None)


def _safe() -> SafetyAssessmentResult:
    return SafetyAssessmentResult.model_construct(
        target_cargo_name="벤젠", risk_level=RiskLevel.SAFE, rule_engine_floor=RiskLevel.SAFE,
        conflicts=[], bulk_compatibility_conflicts=[], packaging_violations=[], unassessed_pairs=[],
        cargo_verdicts=[], checklist=[], key_hazards=[], reasoning="", onboard_conflicts=[],
        adjacent_count=0, verdict_basis=[], needs_check=[], cargo_profile="",
    )


def _core(result):
    """팀 필드를 뺀 판정 핵심 — model_construct 로 만든 안전 결과는 통째로 덤프하지 않는다."""
    return (result.overall_decision, result.level, result.evidence_missing, result.assignment_trace, result.conditions,
            [(o.axis, o.evidence, o.checked, o.missing) for o in result.opinions])


def _patch(monkeypatch, weather_status=WorkStatus.NORMAL, *, blocked_rows=(), arrivals=(), risk=RiskLevel.DANGER):
    async def fake_berth(*a, **k):
        return BerthCheck(candidate=BerthCandidate(
            rank=1, berth_id="효성부두", wharf_name="효성부두", port_name="온산항", depth_m=12.0,
            draught_margin_m=3.0, occupancy_status=OccupancyStatus.AVAILABLE,
        ))

    async def fake_weather(db, **k):
        return _weather(weather_status)

    async def fake_segregation(*a, **k):
        return _safe()

    async def fake_alternatives(*a, **k):
        return tools.Alternatives()

    async def fake_blocked(db, **_):
        return list(blocked_rows)

    async def fake_who(db, neo4j, *, wharf):
        return tools.BerthNow(wharf_name=wharf, neighbors=[tools.NeighborNow(wharf_name="A부두", distance_m=300.0)])

    async def fake_arrivals(db, **_):
        return list(arrivals)

    async def fake_verdict(db, neo4j, req):
        # 이웃 없이(기준선) 물으면 대상 배 자체는 '안전', 입항 예정선 화물을 넣어 물으면 risk
        return SimpleNamespace(risk_level=risk if req.adjacent_cargos else RiskLevel.SAFE)

    for name, fn in (("check_berth", fake_berth), ("check_weather", fake_weather),
                     ("check_segregation", fake_segregation), ("suggest_alternatives", fake_alternatives)):
        monkeypatch.setattr(orch.tools, name, fn)
    monkeypatch.setattr(tools, "who_is_at", fake_who)
    monkeypatch.setattr(tb, "_fetch_same_wharf_blocked", fake_blocked)
    monkeypatch.setattr(tb, "_fetch_upcoming_arrivals", fake_arrivals)
    monkeypatch.setattr(tb, "assess_verdict", fake_verdict)


_BLOCKED = [{"call_sign": "OTHER", "vessel_name": "옆배", "level": "부적합", "reason": "기상 한계 초과",
             "assessed_at_utc": NOW - timedelta(hours=1)}]
_ARRIVAL = [{"callsgn": "INCOMING", "wharf_name": "A부두", "arrival_at_utc": NOW + timedelta(hours=6),
             "departure_at_utc": None, "chem_ids": ["000756"], "cargo_names": ["톨루엔"]}]


def _submit(level, reasoning="이유", refs=(), conds=(), call_id="s1"):
    return tool_call("submit_verdict", {"level": level, "reasoning": reasoning,
                                        "evidence_refs": list(refs), "condition_refs": list(conds)}, call_id)


def _team(replies):
    model = ScriptedChat(replies=replies)
    return Team(chat_model=model, toolbox=Toolbox(None, None, _request(), now=NOW)), model


async def _orchestrate(team=None):
    return await orch.orchestrate(None, None, _NoSummaryLLM(), _request(), team=team)


def _axis(result, name):
    return next(o for o in result.opinions if o.axis == name)


@pytest.mark.asyncio
async def test_present_finding_raises_to_caution(monkeypatch):
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([
        tool_call("same_wharf_status", {}), _submit("주의", "같은 부두 옆배 판정이 부적합입니다", ["F1"]),
        _submit("적합"), _submit("적합"),
    ])
    result = await _orchestrate(team)
    berth = _axis(result, "선석")
    assert (berth.level, berth.floor_level, berth.evidence_refs, berth.clamped) == ("주의", "적합", ["F1"], "")
    assert result.overall_decision is OverallDecision.APPROVED and result.level == "주의"
    assert result.headline == "에이전트 팀(선석)이 '주의'로 상향 — 같은 부두 옆배 판정이 부적합입니다"


@pytest.mark.asyncio
async def test_unfit_request_is_capped_at_caution(monkeypatch):
    # 검토 초점 3 — '부적합'은 게이트를 잠그므로 팀 단독으로는 '주의'까지
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([tool_call("same_wharf_status", {}), _submit("부적합", "옆배 부적합", ["F1"]), _submit("적합"), _submit("적합")])
    result = await _orchestrate(team)
    berth = _axis(result, "선석")
    assert berth.level == "주의" and "'주의' 까지" in berth.clamped and result.level == "주의"


@pytest.mark.asyncio
async def test_raise_without_any_finding_is_clamped(monkeypatch):
    # 검토 초점 2 — 2026-08-23 실측의 실패 양상(근거 없는 상향)
    _patch(monkeypatch)
    team, _ = _team([_submit("주의", "그냥 불안합니다"), _submit("적합"), _submit("적합")])
    result = await _orchestrate(team)
    berth = _axis(result, "선석")
    assert berth.level == "적합" and "현재 사실 발견" in berth.clamped and result.level == "적합"


@pytest.mark.asyncio
async def test_raise_citing_an_expected_finding_is_clamped(monkeypatch):
    # 검토 초점 2 — '예정' 발견은 등급 근거가 아니다(결정 7-1)
    _patch(monkeypatch, arrivals=_ARRIVAL)
    team, _ = _team([_submit("적합"), _submit("적합"),
                     tool_call("upcoming_neighbor_conflicts", {}), _submit("주의", "입항 예정선 혼재", ["F1"])])
    result = await _orchestrate(team)
    seg = _axis(result, "혼재")
    assert seg.level == "적합" and seg.evidence_refs == [] and result.level == "적합"


@pytest.mark.asyncio
async def test_raise_citing_an_unknown_id_is_clamped(monkeypatch):
    _patch(monkeypatch)
    team, _ = _team([_submit("주의", "근거", ["F9"]), _submit("적합"), _submit("적합")])
    result = await _orchestrate(team)
    assert _axis(result, "선석").level == "적합"


@pytest.mark.asyncio
async def test_finding_from_another_axis_cannot_be_cited(monkeypatch):
    # 발견은 그 에이전트의 이번 조사에서 만든 것만 근거가 된다 — 선석이 만든 F1 을 혼재가 인용할 수 없다
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([tool_call("same_wharf_status", {}), _submit("적합", "하한 유지"),
                     _submit("적합"), _submit("주의", "선석이 찾은 F1", ["F1"])])
    result = await _orchestrate(team)
    assert _axis(result, "혼재").level == "적합" and result.level == "적합"


@pytest.mark.asyncio
async def test_expected_finding_becomes_a_condition_not_a_grade(monkeypatch):
    _patch(monkeypatch, arrivals=_ARRIVAL)
    team, _ = _team([_submit("적합"), _submit("적합"),
                     tool_call("upcoming_neighbor_conflicts", {}), tool_call("where_is", {"query": "INCOMING"}, "c2"),
                     _submit("적합", "입항 예정선이 아직 항해 중이라 조건으로 둡니다", conds=["F1"])])

    async def fake_where(db, *, query):
        return [tools.VesselNow(call_sign="INCOMING", vessel_name="들어올배", zone="UNDERWAY")]

    monkeypatch.setattr(tools, "where_is", fake_where)
    result = await _orchestrate(team)
    seg = _axis(result, "혼재")
    assert result.level == "적합" and len(seg.conditions) == 1 and "INCOMING" in seg.conditions[0]
    assert seg.conditions[0] in result.conditions                       # 조건 문장은 코드가 발견 사실로 만든 것
    assert seg.consulted_tools == ["upcoming_neighbor_conflicts", "where_is"]


@pytest.mark.asyncio
async def test_condition_citing_a_present_finding_is_ignored(monkeypatch):
    # 검토 초점 4
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([tool_call("same_wharf_status", {}), _submit("적합", "하한 유지", conds=["F1"]),
                     _submit("적합"), _submit("적합")])
    result = await _orchestrate(team)
    assert _axis(result, "선석").conditions == [] and result.conditions == []


@pytest.mark.asyncio
async def test_team_cannot_lower_below_rule_floor(monkeypatch):
    # 검토 초점 1 — 기상 규칙은 하역중단('부적합'). 에이전트가 '적합'을 내도 하한으로 되돌린다
    _patch(monkeypatch, weather_status=WorkStatus.STOP)
    team, _ = _team([_submit("적합"), _submit("적합", "문제없음")])
    result = await _orchestrate(team)
    weather = _axis(result, "기상")
    assert weather.level == "부적합" and "하한" in weather.clamped
    assert result.overall_decision is OverallDecision.WEATHER_BLOCKED and result.level == "부적합"


@pytest.mark.asyncio
async def test_missing_submission_keeps_the_floor(monkeypatch):
    _patch(monkeypatch)
    team, _ = _team([_submit("적합"), _submit("적합"), AIMessage(content="적합해 보입니다")])
    result = await _orchestrate(team)
    assert "제출하지 않아" in _axis(result, "혼재").clamped and result.level == "적합"


@pytest.mark.asyncio
async def test_model_failure_leaves_judgment_identical(monkeypatch):
    # 검토 초점 6
    _patch(monkeypatch)
    plain = await _orchestrate()
    team, _ = _team([RuntimeError("네트워크 끊김")] * 3)
    with_team = await _orchestrate(team)
    assert all(o.floor_level is None for o in with_team.opinions) and _core(plain) == _core(with_team)


@pytest.mark.asyncio
async def test_unknown_floor_is_never_sent_to_the_agent(monkeypatch):
    # 검토 초점 10 — 판정불가는 에이전트가 추측으로 풀지 못한다
    _patch(monkeypatch, weather_status=WorkStatus.UNKNOWN)
    team, model = _team([_submit("적합")])
    result = await _orchestrate(team)
    assert model.cursor == 1 and _axis(result, "기상").floor_level is None and result.level == "판정불가"


@pytest.mark.asyncio
async def test_expected_finding_at_the_same_wharf_cannot_raise(monkeypatch):
    # 최종 검토 Important 4 — 같은 부두(효성부두) 입항 예정 발견은 부두 검사를 통과하므로, 시점(tense) 검사만이 상향을 막는다
    same_wharf_arrival = [{**_ARRIVAL[0], "wharf_name": "효성부두"}]
    _patch(monkeypatch, arrivals=same_wharf_arrival)
    team, _ = _team([_submit("적합"), _submit("적합"),
                     tool_call("upcoming_neighbor_conflicts", {}), _submit("주의", "같은 부두 입항 예정선", ["F1"])])
    result = await _orchestrate(team)
    seg = _axis(result, "혼재")
    assert seg.level == "적합" and seg.evidence_refs == [] and result.level == "적합"


def test_present_finding_with_condition_text_never_becomes_a_condition():
    # 최종 검토 Important 4 — 조건은 '예정' 발견만. 조건 문장이 있어도 '현재' 발견이면 조건으로 쓰지 않는다
    from app.agents.team.findings import Finding
    from app.agents.team.specialist import AxisVerdict
    from app.agents.team.team import _conditions

    present = Finding(id="F1", kind="SAME_WHARF_BLOCKED", tense="현재", supports="주의",
                      wharf_name="효성부두", condition_text="이 문장은 조건이 되면 안 된다")
    verdict = AxisVerdict(level="적합", reasoning="x", condition_refs=["F1"])
    assert _conditions(verdict, {"F1": present}, _request()) == []
