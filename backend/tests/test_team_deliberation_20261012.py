"""반론 라운드 — Supervisor 가 재검토를 요청하고 에이전트가 답한다, Critic 은 되돌리기만 (2026-10-12). DB·네트워크 없음."""
from datetime import datetime, timedelta, timezone

import pytest
from langchain_core.messages import AIMessage
from scripted_chat import ScriptedChat, tool_call

from app.agents import tools
from app.agents.orchestrator import service as orch
from app.agents.orchestrator.schemas import LLMSummary, OrchestratorRequest
from app.agents.safety.schemas import CargoRef, RiskLevel, SafetyAssessmentResult
from app.agents.scheduling.schemas import BerthCandidate, OccupancyStatus, VesselSpec
from app.agents.team import toolbox as tb
from app.agents.team.team import Team
from app.agents.team.toolbox import Toolbox
from app.agents.tools import BerthCheck
from app.agents.weather.schemas import ObservationFactor, WeatherAssessmentResult, WorkStatus

NOW = datetime.now(timezone.utc)
_BLOCKED = [{"call_sign": "OTHER7", "vessel_name": "옆배", "level": "부적합", "reason": "이웃 화물과 혼재 충돌",
             "assessed_at_utc": NOW - timedelta(hours=1)}]


class _NoSummaryLLM:
    async def generate_structured(self, *, schema, **_):
        return schema(**{name: "" for name in schema.model_fields}) if schema is LLMSummary else None


def _request():
    return OrchestratorRequest(vessel=VesselSpec(draught_m=9.0, call_sign="TEST"), cargo=CargoRef(chem_id="001008"),
                               window_start=NOW, window_end=NOW + timedelta(hours=24), assigned_wharf_name="효성부두")


def _patch(monkeypatch, *, blocked_rows=()):
    obs = ObservationFactor(value=5.0, unit="m/s", is_stale=False)

    async def berth(*a, **k):
        return BerthCheck(candidate=BerthCandidate(rank=1, berth_id="효성부두", wharf_name="효성부두", port_name="온산항",
                                                   depth_m=12.0, draught_margin_m=3.0,
                                                   occupancy_status=OccupancyStatus.AVAILABLE))

    async def weather(db, **k):
        return WeatherAssessmentResult(status=WorkStatus.NORMAL, assessed_at_utc=NOW, wind=obs, wave=obs,
                                       reasons=["x"], forecast_warning=None)

    async def segregation(*a, **k):
        return SafetyAssessmentResult.model_construct(
            target_cargo_name="벤젠", risk_level=RiskLevel.SAFE, rule_engine_floor=RiskLevel.SAFE, conflicts=[],
            bulk_compatibility_conflicts=[], packaging_violations=[], unassessed_pairs=[], cargo_verdicts=[],
            checklist=[], key_hazards=[], reasoning="", onboard_conflicts=[], adjacent_count=0, verdict_basis=[],
            needs_check=[], cargo_profile="")

    async def blocked(db, **_):
        return list(blocked_rows)

    for name, fn in (("check_berth", berth), ("check_weather", weather), ("check_segregation", segregation)):
        monkeypatch.setattr(orch.tools, name, fn)
    monkeypatch.setattr(tb, "_fetch_same_wharf_blocked", blocked)


def _submit(level, reasoning="이유", refs=(), call_id="s1", questions=()):
    return tool_call("submit_verdict", {"level": level, "reasoning": reasoning, "evidence_refs": list(refs),
                                        "condition_refs": [], "questions": list(questions)}, call_id)


def _plan(*challenges):
    return tool_call("submit_plan", {"challenges": [{"axis": a, "question": q} for a, q in challenges]}, "p1")


def _review(supported, issue=""):
    return tool_call("submit_review", {"supported": supported, "issue": issue}, "r1")


def _team(replies):
    model = ScriptedChat(replies=replies)
    return Team(chat_model=model, toolbox=Toolbox(None, None, _request(), now=NOW)), model


async def _orchestrate(team):
    return await orch.orchestrate(None, None, _NoSummaryLLM(), _request(), team=team)


def _axis(result, name):
    return next(o for o in result.opinions if o.axis == name)


@pytest.mark.asyncio
async def test_no_challenge_means_one_supervisor_call_and_a_log(monkeypatch):
    _patch(monkeypatch)
    team, model = _team([_submit("적합"), _submit("적합"), _submit("적합"), _plan()])
    result = await _orchestrate(team)
    assert model.cursor == 4 and result.level == "적합"
    assert result.deliberation == ["Supervisor: 재검토 요청 없음"]


@pytest.mark.asyncio
async def test_supervisor_challenge_makes_the_agent_reconsider(monkeypatch):
    # 선석 에이전트가 처음엔 근거를 안 보고 '적합' → Supervisor 가 같은 부두 상태를 물음 → 조사 후 '주의'(Critic 은 Task 4)
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([
        _submit("적합", "흘수 여유 충분"), _submit("적합"), _submit("적합"),
        _plan(("선석", "같은 부두에서 하역 중인 다른 배의 판정을 확인했나요?")),
        tool_call("same_wharf_status", {}, "c9"), _submit("주의", "옆배 OTHER7 의 최신 판정이 부적합입니다", ["F1"], "s9"),
        _review(True),
    ])
    result = await _orchestrate(team)
    assert _axis(result, "선석").level == "주의" and result.level == "주의"
    assert any(line.startswith("Supervisor → 선석") for line in result.deliberation)
    assert any(line.startswith("선석: 적합 → 주의") for line in result.deliberation)


@pytest.mark.asyncio
async def test_peer_question_is_routed_without_supervisor_naming_it(monkeypatch):
    # 혼재 에이전트가 선석 에이전트에게 물은 질문은 Supervisor 계획이 비어도 전달된다(에이전트 간 협업)
    _patch(monkeypatch)
    ask = _submit("적합", call_id="s3", questions=[{"to_axis": "선석", "question": "인접 부두 현황은?"}])
    team, model = _team([_submit("적합"), _submit("적합"), ask, _plan(), _submit("적합", "인접 부두 이상 없음", call_id="s8")])
    result = await _orchestrate(team)
    assert model.cursor == 5
    assert any("혼재 에이전트의 질문" in line for line in result.deliberation)


@pytest.mark.asyncio
async def test_invalid_or_excess_challenges_are_ignored(monkeypatch):
    # 검토 초점 1 — 팀이 판정하지 않은 축(판정불가 등)·같은 축 중복·3번째 이후 요청은 버린다
    _patch(monkeypatch)
    team, model = _team([_submit("적합"), _submit("적합"), _submit("적합"),
                         _plan(("선석", "a"), ("선석", "b"), ("기상", "c"), ("혼재", "d")),
                         _submit("적합", call_id="x1"), _submit("적합", call_id="x2")])
    result = await _orchestrate(team)
    assert model.cursor == 6                                     # 재검토는 선석·기상 2축만
    assert sum(line.startswith("Supervisor → ") for line in result.deliberation) == 2


@pytest.mark.asyncio
async def test_supervisor_failure_keeps_the_judgment(monkeypatch):
    # 검토 초점 2
    _patch(monkeypatch)
    team, _ = _team([_submit("적합"), _submit("적합"), _submit("적합"), RuntimeError("네트워크")])
    result = await _orchestrate(team)
    assert result.level == "적합" and result.deliberation[0].startswith("Supervisor: 실패")


@pytest.mark.asyncio
async def test_no_team_means_no_deliberation(monkeypatch):
    _patch(monkeypatch)
    result = await orch.orchestrate(None, None, _NoSummaryLLM(), _request())
    assert result.deliberation == []


@pytest.mark.asyncio
async def test_llm_critic_can_revert_an_unsupported_raise(monkeypatch):
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([
        tool_call("same_wharf_status", {}), _submit("주의", "옆배 OTHER7 의 최신 판정이 부적합입니다", ["F1"]),
        _submit("적합"), _submit("적합"), _plan(), _review(False, "옆배의 부적합은 이 배와 무관한 기상 사유"),
    ])
    result = await _orchestrate(team)
    berth = _axis(result, "선석")
    assert berth.level == "적합" and result.level == "적합"
    assert any("Critic" in m for m in result.needs_check)          # 검토 초점 6 — 이견은 '확인 필요'에 남는다
    assert any(line.startswith("Critic: 선석 상향 되돌림") for line in result.deliberation)


@pytest.mark.asyncio
async def test_code_critic_reverts_invented_numbers_without_calling_the_llm(monkeypatch):
    # 검토 초점 4 — 이유에 근거에 없는 수치(25)가 있으면 LLM Critic 을 부르지 않고 되돌린다
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, model = _team([
        tool_call("same_wharf_status", {}), _submit("주의", "풍속 25m/s 와 옆배 OTHER7 때문입니다", ["F1"]),
        _submit("적합"), _submit("적합"), _plan(),
    ])
    result = await _orchestrate(team)
    assert model.cursor == 5 and _axis(result, "선석").level == "적합"
    assert any("25" in line for line in result.deliberation)


@pytest.mark.asyncio
async def test_supported_raise_survives_the_critic(monkeypatch):
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([
        tool_call("same_wharf_status", {}), _submit("주의", "옆배 OTHER7 의 최신 판정이 부적합입니다", ["F1"]),
        _submit("적합"), _submit("적합"), _plan(), _review(True),
    ])
    result = await _orchestrate(team)
    assert result.level == "주의" and any(line == "Critic: 선석 상향 근거 확인" for line in result.deliberation)


@pytest.mark.asyncio
async def test_llm_critic_failure_keeps_a_code_verified_raise(monkeypatch):
    # 검토 초점 2·5 — LLM Critic 이 실패해도 코드 검증을 통과한 상향은 남는다(Critic 은 올리지도, 실패로 내리지도 않는다)
    _patch(monkeypatch, blocked_rows=_BLOCKED)
    team, _ = _team([
        tool_call("same_wharf_status", {}), _submit("주의", "옆배 OTHER7 의 최신 판정이 부적합입니다", ["F1"]),
        _submit("적합"), _submit("적합"), _plan(), RuntimeError("네트워크"),
    ])
    result = await _orchestrate(team)
    assert result.level == "주의" and any("Critic: 선석 LLM 검토 실패" in line for line in result.deliberation)
