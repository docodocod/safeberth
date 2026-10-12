"""전문 에이전트 실행기 — 루프·예산·판정 제출·오류 처리 (2026-10-12). DB·네트워크 없음."""
import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from scripted_chat import ScriptedChat, tool_call

from app.agents.team.specialist import AxisVerdict, run_specialist


def _lookup_tool(calls: list, *, fail: bool = False) -> StructuredTool:
    async def lookup(wharf: str) -> str:
        """부두 현황을 돌려준다."""
        calls.append(wharf)
        if fail:
            raise RuntimeError("DB 연결 실패")
        return f"{wharf}: 2척"

    return StructuredTool.from_function(coroutine=lookup, name="lookup")


def _submit(level="주의", reasoning="이유", refs=(), conds=(), call_id="s1"):
    args = {"level": level, "reasoning": reasoning, "evidence_refs": list(refs), "condition_refs": list(conds)}
    return tool_call("submit_verdict", args, call_id)


async def _run(model, tools, budget=3):
    return await run_specialist(chat_model=model, system_prompt="sys", task="task", tools=tools, max_tool_calls=budget)


@pytest.mark.asyncio
async def test_agent_submits_verdict_directly():
    note = await _run(ScriptedChat(replies=[_submit("주의", "근거", ["F1"], ["F2"])]), [_lookup_tool([])])
    assert note.verdict == AxisVerdict(level="주의", reasoning="근거", evidence_refs=["F1"], condition_refs=["F2"])
    assert note.tool_calls_used == 0 and note.budget_exhausted is False


@pytest.mark.asyncio
async def test_agent_looks_up_then_submits():
    calls: list = []
    model = ScriptedChat(replies=[tool_call("lookup", {"wharf": "효성부두"}), _submit("적합", "2척 접안")])
    note = await _run(model, [_lookup_tool(calls)])
    assert calls == ["효성부두"] and note.verdict.level == "적합" and note.tool_calls_used == 1
    assert any(m.type == "tool" and "2척" in m.content for m in model.seen[1])


@pytest.mark.asyncio
async def test_plain_text_without_submission_means_no_verdict():
    note = await _run(ScriptedChat(replies=[AIMessage(content="적합해 보입니다.")]), [_lookup_tool([])])
    assert note.verdict is None


@pytest.mark.asyncio
async def test_budget_stops_lookups_without_verdict():
    # 검토 초점 5 — 모델이 계속 조회만 하려 해도 예산에서 멈춘다
    calls: list = []
    model = ScriptedChat(replies=[
        tool_call("lookup", {"wharf": "A"}, "c1"), tool_call("lookup", {"wharf": "B"}, "c2"),
        AIMessage(content="도달하면 안 된다"),
    ])
    note = await _run(model, [_lookup_tool(calls)], budget=1)
    assert calls == ["A"] and note.verdict is None and note.budget_exhausted is True and note.tool_calls_used == 1


@pytest.mark.asyncio
async def test_exhausted_budget_still_allows_submission():
    model = ScriptedChat(replies=[tool_call("lookup", {"wharf": "A"}), _submit("적합", "문제없음")])
    note = await _run(model, [_lookup_tool([])], budget=1)
    assert note.verdict is not None and note.verdict.level == "적합"


@pytest.mark.asyncio
async def test_tool_exception_is_returned_to_model():
    model = ScriptedChat(replies=[tool_call("lookup", {"wharf": "A"}), _submit("적합", "조회 실패로 하한 유지")])
    note = await _run(model, [_lookup_tool([], fail=True)])
    assert note.verdict.level == "적합"
    assert any(m.type == "tool" and "DB 연결 실패" in m.content for m in model.seen[1])


@pytest.mark.asyncio
async def test_invalid_submission_is_returned_to_model_and_retried():
    # 검토 초점 5 — 스키마에 없는 등급이면 오류를 돌려받고 다시 제출한다
    model = ScriptedChat(replies=[_submit("위험", "잘못된 등급", call_id="s1"), _submit("주의", "고쳐 제출", call_id="s2")])
    note = await _run(model, [])
    assert note.verdict == AxisVerdict(level="주의", reasoning="고쳐 제출")


@pytest.mark.asyncio
async def test_submission_ends_the_loop():
    model = ScriptedChat(replies=[_submit("적합", "첫 제출")])
    note = await _run(model, [])
    assert note.verdict.reasoning == "첫 제출" and len(model.seen) == 1


@pytest.mark.asyncio
async def test_repeated_invalid_submissions_end_the_loop():
    # 최종 검토 Important 1 — 잘못된 제출을 계속 보내도 루프가 끝나야 한다(재제출은 1번까지)
    model = ScriptedChat(replies=[_submit("위험", "x", call_id=f"s{i}") for i in range(10)])
    note = await _run(model, [])
    assert note.verdict is None and model.cursor == 2


@pytest.mark.asyncio
async def test_lookups_bundled_with_a_submission_cannot_bypass_the_budget():
    # 최종 검토 Important 1 — 예산을 다 쓴 뒤 '조회 + 제출'을 한 응답에 묶어 보내도 조회는 실행되지 않는다
    calls: list = []
    bundled = AIMessage(content="", tool_calls=[
        {"name": "lookup", "args": {"wharf": "B"}, "id": "c2"},
        {"name": "submit_verdict", "args": {"level": "주의", "reasoning": "x", "evidence_refs": [], "condition_refs": []}, "id": "s1"},
    ])
    model = ScriptedChat(replies=[tool_call("lookup", {"wharf": "A"}), bundled])
    note = await _run(model, [_lookup_tool(calls)], budget=1)
    assert calls == ["A"] and note.verdict is None and note.budget_exhausted is True


@pytest.mark.asyncio
async def test_custom_schema_and_submit_name():
    # Supervisor·Critic 도 같은 루프를 쓴다 — 스키마와 제출 도구 이름을 바꿔 끼운다
    from pydantic import BaseModel as _BM

    class _Plan(_BM):
        items: list[str]

    model = ScriptedChat(replies=[tool_call("submit_plan", {"items": ["a", "b"]})])
    note = await run_specialist(chat_model=model, system_prompt="s", task="t", tools=[], max_tool_calls=0,
                                schema=_Plan, submit_name="submit_plan", submit_description="계획 제출")
    assert note.verdict == _Plan(items=["a", "b"])


@pytest.mark.asyncio
async def test_peer_questions_are_part_of_the_verdict():
    args = {"level": "적합", "reasoning": "x", "evidence_refs": [], "condition_refs": [],
            "questions": [{"to_axis": "선석", "question": "인접 부두에 지금 접안한 배가 있나요?"}]}
    note = await _run(ScriptedChat(replies=[tool_call("submit_verdict", args)]), [])
    assert note.verdict.questions[0].to_axis == "선석"
