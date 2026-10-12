"""전문 에이전트 실행기 — 도구를 골라 부르고 판정을 직접 제출하는 ReAct 루프 (LangGraph).

[2026-10-12] 계획 2. 한 축의 에이전트가 규칙 하한을 보고, 필요하면 조회 도구를 부른 뒤 `submit_verdict` 로 판정을
낸다. 판정을 보정하는 세 규칙(하한·현재 발견·팀 상한)은 이 루프가 아니라 호출부(team.py)가 코드로 건다 — 루프는
에이전트가 무엇을 제출했는지만 정확히 돌려준다.

루프: START → agent ─┬→ tools(ToolNode) ─┬→ agent …
                    └→ END              └→ END  (판정 제출됨)
  agent 다음 END: 도구 요청이 없거나, 이 응답의 조회까지 더하면 예산을 넘거나, 제출 시도가 상한을 넘은 때(판정 없음)
  제출만 담은 응답은 조회 예산과 상관없이 허용한다 — 예산을 다 써도 판정은 낼 수 있어야 한다.

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
# [2026-10-12 최종 검토] 판정 제출 시도 상한 — 잘못된 제출(스키마 오류)을 한 번까지만 고쳐 내게 한다. 상한이 없으면
#   잘못된 제출이 반복될 때 루프가 LangGraph 기본 재귀 한도(이 버전 10007)까지 돌아 축 하나에 유료 호출이 수천 번 나간다.
_MAX_SUBMIT_ATTEMPTS = 2


class PeerQuestion(BaseModel):
    to_axis: Literal["선석", "기상", "혼재"] = Field(description="질문을 받을 다른 축")
    question: str = Field(description="그 축 에이전트에게 확인을 요청할 내용 1문장")


class AxisVerdict(BaseModel):
    level: Literal["적합", "주의", "부적합"] = Field(description="이 축에 대한 당신의 최종 판정")
    reasoning: str = Field(description="판정 이유 1~2문장")
    evidence_refs: list[str] = Field(default_factory=list, description="등급을 올린 근거 발견 id(예: F1)")
    condition_refs: list[str] = Field(default_factory=list, description="조건으로 붙일 '예정' 발견 id")
    questions: list[PeerQuestion] = Field(
        default_factory=list, description="다른 축 에이전트에게 확인을 요청할 질문(최대 1개 권장) — Supervisor 가 전달한다",
    )


class SpecialistNote(BaseModel):
    verdict: BaseModel | None = None
    tool_calls_used: int = 0
    budget_exhausted: bool = False


class _State(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]


def _lookups(messages: list[AnyMessage], submit_name: str = SUBMIT) -> list[ToolMessage]:
    return [m for m in messages if isinstance(m, ToolMessage) and m.name != submit_name]


def _submit_attempts(messages: list[AnyMessage], submit_name: str = SUBMIT) -> int:
    return sum(
        any(c["name"] == submit_name for c in (getattr(m, "tool_calls", None) or []))
        for m in messages if isinstance(m, AIMessage)
    )


async def run_specialist(
    *,
    chat_model: BaseChatModel,
    system_prompt: str,
    task: str,
    tools: list[BaseTool],
    max_tool_calls: int,
    schema: type[BaseModel] = AxisVerdict,
    submit_name: str = SUBMIT,
    submit_description: str = "이 축의 판정을 제출한다. 제출하면 판정이 끝난다.",
) -> SpecialistNote:
    # [2026-10-12] 계획 3: Supervisor·Critic 도 같은 루프를 쓰도록 제출 스키마와 도구 이름을 받는다.
    captured: list[BaseModel] = []

    async def submit(**kwargs) -> str:
        captured.append(schema(**kwargs))
        return "제출되었습니다."

    submit_tool = StructuredTool.from_function(
        coroutine=submit, name=submit_name, description=submit_description, args_schema=schema,
    )
    all_tools = [*tools, submit_tool]
    bound = chat_model.bind_tools(all_tools)

    async def agent(state: _State) -> _State:
        return {"messages": [await bound.ainvoke(state["messages"])]}

    def after_agent(state: _State) -> str:
        calls = getattr(state["messages"][-1], "tool_calls", None) or []
        if not calls:
            return END
        if _submit_attempts(state["messages"], submit_name) > _MAX_SUBMIT_ATTEMPTS:
            return END
        # 같은 응답에 묶인 조회도 예산에 센다 — 제출과 함께 보내 예산을 우회하지 못하게. 넘치면 판정 없이 끝낸다(하한 유지).
        lookups_here = sum(c["name"] != submit_name for c in calls)
        return "tools" if len(_lookups(state["messages"], submit_name)) + lookups_here <= max_tool_calls else END

    def after_tools(state: _State) -> str:
        # 제출이 받아들여졌거나, 제출 시도를 다 썼으면 모델을 더 부르지 않는다.
        return END if captured or _submit_attempts(state["messages"], submit_name) >= _MAX_SUBMIT_ATTEMPTS else "agent"

    graph = StateGraph(_State)
    graph.add_node("agent", agent)
    # handle_tool_errors=True: 도구 예외·인자 검증 오류를 ToolMessage 로 바꿔 모델에게 돌려준다 — 루프가 죽지 않는다.
    graph.add_node("tools", ToolNode(all_tools, handle_tool_errors=True))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", END: END})
    graph.add_conditional_edges("tools", after_tools, {"agent": "agent", END: END})

    messages: list[AnyMessage] = [SystemMessage(content=system_prompt), HumanMessage(content=task)]
    # 재귀 한도는 위 라우팅이 틀렸을 때의 마지막 안전망이다(초과 시 GraphRecursionError — Team.decide 가 하한으로 처리).
    limit = 2 * (max_tool_calls + _MAX_SUBMIT_ATTEMPTS) + 3
    final = (await graph.compile().ainvoke({"messages": messages}, config={"recursion_limit": limit}))["messages"]
    last = final[-1]
    return SpecialistNote(
        verdict=captured[0] if captured else None,
        tool_calls_used=len(_lookups(final, submit_name)),
        budget_exhausted=not captured and isinstance(last, AIMessage) and bool(last.tool_calls),
    )
