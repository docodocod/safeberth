"""전문 에이전트 실행기 — 도구를 골라 부르고 판정을 직접 제출하는 ReAct 루프 (LangGraph).

[2026-10-12] 계획 2. 한 축의 에이전트가 규칙 하한을 보고, 필요하면 조회 도구를 부른 뒤 `submit_verdict` 로 판정을
낸다. 판정을 보정하는 세 규칙(하한·현재 발견·팀 상한)은 이 루프가 아니라 호출부(team.py)가 코드로 건다 — 루프는
에이전트가 무엇을 제출했는지만 정확히 돌려준다.

루프: START → agent ─┬→ tools(ToolNode) ─┬→ agent …
                    └→ END              └→ END  (판정 제출됨)
  agent 다음 END: 도구 요청이 없거나, 조회 예산을 다 썼는데 또 조회를 요청한 때(판정 없음)
  submit_verdict 는 예산과 상관없이 허용한다 — 예산을 다 써도 판정은 낼 수 있어야 한다.

`create_react_agent` 를 쓰지 않는 이유: 이 버전에서 폐기 예정 표시가 붙어 있고 대체 함수는 설치되지 않은
`langchain` 패키지에 있다.
"""

from typing import Annotated, Literal, TypedDict

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel, Field

SUBMIT = "submit_verdict"


class AxisVerdict(BaseModel):
    level: Literal["적합", "주의", "부적합"] = Field(description="이 축에 대한 당신의 최종 판정")
    reasoning: str = Field(description="판정 이유 1~2문장")
    evidence_refs: list[str] = Field(default_factory=list, description="등급을 올린 근거 발견 id(예: F1)")
    condition_refs: list[str] = Field(default_factory=list, description="조건으로 붙일 '예정' 발견 id")


class SpecialistNote(BaseModel):
    verdict: AxisVerdict | None = None
    tool_calls_used: int = 0
    budget_exhausted: bool = False


class _State(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]


def _lookups(messages: list[AnyMessage]) -> list[ToolMessage]:
    return [m for m in messages if isinstance(m, ToolMessage) and m.name != SUBMIT]


async def run_specialist(
    *,
    chat_model: BaseChatModel,
    system_prompt: str,
    task: str,
    tools: list[BaseTool],
    max_tool_calls: int,
) -> SpecialistNote:
    captured: list[AxisVerdict] = []

    async def submit_verdict(level: str, reasoning: str, evidence_refs: list[str], condition_refs: list[str]) -> str:
        """이 축의 판정을 제출한다. 제출하면 판정이 끝난다."""
        captured.append(AxisVerdict(
            level=level, reasoning=reasoning, evidence_refs=evidence_refs, condition_refs=condition_refs,
        ))
        return "판정이 제출되었습니다."

    submit = StructuredTool.from_function(coroutine=submit_verdict, name=SUBMIT, args_schema=AxisVerdict)
    all_tools = [*tools, submit]
    bound = chat_model.bind_tools(all_tools)

    async def agent(state: _State) -> _State:
        return {"messages": [await bound.ainvoke(state["messages"])]}

    def after_agent(state: _State) -> str:
        calls = getattr(state["messages"][-1], "tool_calls", None) or []
        if not calls:
            return END
        if any(c["name"] == SUBMIT for c in calls):
            return "tools"
        return "tools" if len(_lookups(state["messages"])) < max_tool_calls else END

    def after_tools(state: _State) -> str:
        return END if captured else "agent"

    graph = StateGraph(_State)
    graph.add_node("agent", agent)
    # handle_tool_errors=True: 도구 예외·인자 검증 오류를 ToolMessage 로 바꿔 모델에게 돌려준다 — 루프가 죽지 않는다.
    graph.add_node("tools", ToolNode(all_tools, handle_tool_errors=True))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", END: END})
    graph.add_conditional_edges("tools", after_tools, {"agent": "agent", END: END})

    messages: list[AnyMessage] = [SystemMessage(content=system_prompt), HumanMessage(content=task)]
    final = (await graph.compile().ainvoke({"messages": messages}))["messages"]
    last = final[-1]
    return SpecialistNote(
        verdict=captured[0] if captured else None,
        tool_calls_used=len(_lookups(final)),
        budget_exhausted=not captured and isinstance(last, AIMessage) and bool(last.tool_calls),
    )
