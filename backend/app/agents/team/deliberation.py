"""반론 라운드 — Supervisor 가 재검토를 요청하고, 지목된 에이전트가 답하고, Critic 이 상향을 검증한다 (2026-10-12, 계획 3).

  START → supervisor ─┬→ respond → critic → END
                      └→ critic → END            (재검토 요청이 없을 때)

Supervisor 는 등급을 정하지 않는다 — 재검토만 요청한다. 에이전트 간 질문(AxisVerdict.questions)은 Supervisor 계획과
상관없이 전달된다. 라운드는 1회다. 응답 에이전트의 판정도 Team.decide 를 지나므로 계획 2 의 세 규칙(하한·현재 발견·
'주의' 상한)이 그대로 걸린다. 의견이 끝까지 갈려도 기록만 하고 진행한다(사용자 결정 2026-10-12, 9/17 회의 '확인·기록만').
"""

from typing import TYPE_CHECKING, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from app.agents.orchestrator.schemas import OrchestratorRequest
from app.agents.tools import Opinion

from .levels import RANK
from .prompts import SUPERVISOR_PROMPT
from .specialist import run_specialist

if TYPE_CHECKING:
    from .team import Team

MAX_CHALLENGES = 2


class Challenge(BaseModel):
    axis: Literal["선석", "기상", "혼재"]
    question: str


class SupervisorPlan(BaseModel):
    challenges: list[Challenge] = Field(default_factory=list, description="재검토를 요청할 축과 질문(최대 2)")


class CriticVerdict(BaseModel):
    supported: bool = Field(description="인용한 근거가 이 상향을 뒷받침하는가")
    issue: str = Field(default="", description="뒷받침하지 않으면 그 이유 1문장")


class _State(TypedDict, total=False):
    opinions: list[Opinion]
    challenges: list[Challenge]
    log: list[str]


def _summary(opinions: list[Opinion], peer: list[Challenge]) -> str:
    lines = []
    for o in opinions:
        head = f"[{o.axis}] 규칙 하한 {o.floor_level or o.level} → 팀 판정 {o.level}"
        lines += [head, *(f"  근거: {e}" for e in o.evidence[:3]), *(f"  못 본 것: {m}" for m in o.missing[:3])]
        if o.rationale:
            lines.append(f"  에이전트 이유: {o.rationale}")
    if peer:
        lines += ["[에이전트 간 질문]", *(f"- {c.axis} 에게: {c.question}" for c in peer)]
    return "\n".join(lines)


def _floor_of(o: Opinion) -> Opinion:
    """재검토는 규칙 하한에서 다시 시작한다 — 이전 팀 판정을 근거로 쓰지 않게."""
    return o.model_copy(update={
        "level": o.floor_level or o.level, "floor_level": None, "rationale": "", "consulted_tools": [],
        "evidence_refs": [], "conditions": [], "clamped": "",
    })


def build_deliberation(team: "Team", request: OrchestratorRequest):
    async def supervisor(state: _State) -> _State:
        peer = [Challenge(axis=q.to_axis, question=f"[{frm} 에이전트의 질문] {q.question}") for frm, q in team.questions]
        judged = {o.axis for o in state["opinions"] if o.floor_level is not None}
        try:
            note = await run_specialist(
                chat_model=team.chat_model, system_prompt=SUPERVISOR_PROMPT, task=_summary(state["opinions"], peer),
                tools=[], max_tool_calls=0, schema=SupervisorPlan, submit_name="submit_plan",
                submit_description="재검토를 요청할 축과 질문을 제출한다(없으면 빈 목록).",
            )
            plan = note.verdict or SupervisorPlan()
        except Exception as e:  # noqa: BLE001 - Supervisor 실패는 재검토 없이 진행
            return {"challenges": [], "log": [f"Supervisor: 실패 — 재검토 없이 진행 ({type(e).__name__})"]}
        picked: dict[str, Challenge] = {}
        for c in [*peer, *plan.challenges]:
            if c.axis in judged and c.axis not in picked and len(picked) < MAX_CHALLENGES:
                picked[c.axis] = c
        challenges = list(picked.values())
        log = [f"Supervisor → {c.axis}: {c.question}" for c in challenges] or ["Supervisor: 재검토 요청 없음"]
        return {"challenges": challenges, "log": log}

    async def respond(state: _State) -> _State:
        opinions, log = list(state["opinions"]), list(state["log"])
        for c in state["challenges"]:
            i = next(k for k, o in enumerate(opinions) if o.axis == c.axis)
            before = opinions[i]
            after = await team.decide(_floor_of(before), request, challenge=c.question)
            # 응답 에이전트 실패(예외·하한 불명) 또는 판정 미제출(rationale 이 빔) — 이전 판정 유지(검토 초점 2).
            # [2026-10-12] 미제출을 성공으로 보면 첫 판정의 상향이 하한으로 조용히 떨어진다(실측 C026: 주의 → 적합).
            if after.floor_level is None or not after.rationale:
                log.append(f"{c.axis}: 응답 실패 — 이전 판정 '{before.level}' 유지")
                continue
            opinions[i] = after
            log.append(f"{c.axis}: {before.level} → {after.level} ({after.rationale or after.clamped or '이유 없음'})")
        return {"opinions": opinions, "log": log}

    async def critic(state: _State) -> _State:
        opinions, log = list(state["opinions"]), list(state["log"])
        for i, o in enumerate(opinions):
            if not (o.floor_level in RANK and o.level in RANK and RANK[o.level] > RANK[o.floor_level]):
                continue
            revert, why = await team.critique(o)
            if revert:
                opinions[i] = o.model_copy(update={
                    "level": o.floor_level, "evidence_refs": [], "clamped": f"Critic: {why}",
                    "missing": [*o.missing, f"에이전트 상향 근거 불충분(Critic) — {why}"],
                })
                log.append(f"Critic: {o.axis} 상향 되돌림 — {why}")
            elif why:
                log.append(f"Critic: {o.axis} {why} — 코드 검증을 통과해 상향 유지")
            else:
                log.append(f"Critic: {o.axis} 상향 근거 확인")
        return {"opinions": opinions, "log": log}

    graph = StateGraph(_State)
    graph.add_node("supervisor", supervisor)
    graph.add_node("respond", respond)
    graph.add_node("critic", critic)
    graph.add_edge(START, "supervisor")
    graph.add_conditional_edges("supervisor", lambda s: "respond" if s.get("challenges") else "critic",
                                {"respond": "respond", "critic": "critic"})
    graph.add_edge("respond", "critic")
    graph.add_edge("critic", END)
    return graph.compile()
