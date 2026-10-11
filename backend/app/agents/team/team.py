"""에이전트 팀 — 전문 에이전트가 판정을 제출하고, 코드가 세 규칙으로 보정한다 (2026-10-12, 계획 2, 문서 5장).

  1. 하한 아래로 못 내린다(불변식 1).
  2. 하한 위로 올리려면 **이번 조사에서 만든, 이 부두의 '현재' 발견**이 근거여야 한다 — 실제로 있지만 관련 없는
     발견(다른 부두·다른 축·예정 일정)을 인용해 올리는 것을 막는다.
  3. 팀 단독 상향은 TEAM_CAP('주의')까지 — '부적합'은 하역 밸브 게이트를 잠근다(GATE_BLOCKING_LEVELS).
조건은 '예정' 발견만 붙이고, 문장은 발견의 condition_text(코드가 사실로 만든 것)를 쓴다.

모델·도구가 어떻게 실패해도 예외를 내지 않는다 — 팀이 죽으면 하한이 그대로 판정이다. 하한이 '판정불가'면 에이전트를
부르지 않는다(추측으로 근거 부족을 메우지 않는다).
"""

import logging
from dataclasses import dataclass

from langchain_core.language_models.chat_models import BaseChatModel

from app.agents.orchestrator.schemas import OrchestratorRequest
from app.agents.tools import Opinion

from .findings import Finding
from .levels import RANK, TEAM_CAP
from .prompts import SYSTEM_PROMPTS
from .specialist import AxisVerdict, run_specialist
from .toolbox import Toolbox

logger = logging.getLogger(__name__)


def _task(opinion: Opinion, request: OrchestratorRequest) -> str:
    subject = request.vessel.name_hint or request.vessel.call_sign or "선박"
    lines = [
        f"[대상] {subject} / {request.assigned_wharf_name} / 체류 종료 예정 {request.window_end:%Y-%m-%d %H:%M} UTC",
        f"[축] {opinion.axis}",
        f"[규칙 하한(낮출 수 없음)] {opinion.level}",
    ]
    for title, items in (("근거", opinion.evidence), ("확인한 것", opinion.checked), ("못 본 것", opinion.missing)):
        if items:
            lines += [f"[{title}]", *(f"- {i}" for i in items)]
    return "\n".join(lines)


def _bounded_level(
    verdict: AxisVerdict, floor: str, mine: dict[str, Finding], request: OrchestratorRequest,
) -> tuple[str, str, list[str]]:
    """(최종 등급, 보정 이유, 받아들인 근거 id)."""
    wanted = verdict.level
    if RANK[wanted] < RANK[floor]:
        return floor, f"에이전트 판정 '{wanted}' 이 규칙 하한 '{floor}' 보다 낮아 하한으로 되돌렸습니다", []
    if RANK[wanted] == RANK[floor]:
        return floor, "", []
    present = [
        f.id for ref in dict.fromkeys(verdict.evidence_refs)
        if (f := mine.get(ref)) is not None and f.tense == "현재" and f.wharf_name == request.assigned_wharf_name
    ]
    if not present or not verdict.reasoning.strip():
        return floor, (
            f"'{wanted}' 로 올릴 현재 사실 발견(이번 조사, 이 부두)이 없어 규칙 하한 '{floor}' 을 유지했습니다"
        ), []
    if RANK[wanted] > RANK[TEAM_CAP]:
        level = TEAM_CAP if RANK[TEAM_CAP] > RANK[floor] else floor
        return level, (
            f"팀 단독 상향은 '{TEAM_CAP}' 까지입니다('{wanted}' 요청 — '부적합'은 하역 밸브 게이트를 잠근다)"
        ), (present if level != floor else [])
    return wanted, "", present


def _conditions(verdict: AxisVerdict, mine: dict[str, Finding], request: OrchestratorRequest) -> list[str]:
    out = []
    for ref in dict.fromkeys(verdict.condition_refs):
        f = mine.get(ref)
        if (
            f is not None and f.tense == "예정" and f.condition_text
            and (f.starts_at_utc is None or f.starts_at_utc <= request.window_end)
        ):
            out.append(f.condition_text)
    return out


@dataclass
class Team:
    chat_model: BaseChatModel
    toolbox: Toolbox
    max_tool_calls: int = 3

    async def decide(self, opinion: Opinion, request: OrchestratorRequest) -> Opinion:
        floor = opinion.level
        if floor not in RANK:
            return opinion
        calls_before = len(self.toolbox.calls)
        known = set(self.toolbox.findings)
        try:
            note = await run_specialist(
                chat_model=self.chat_model,
                system_prompt=SYSTEM_PROMPTS[opinion.axis],
                task=_task(opinion, request),
                tools=self.toolbox.tools_for(opinion.axis),
                max_tool_calls=self.max_tool_calls,
            )
        except Exception:  # noqa: BLE001 - 에이전트 실패가 판정을 막지 않게 한다. 하한이 판정이다
            logger.warning("전문 에이전트 실행 실패 — 규칙 하한을 유지합니다 (%s)", opinion.axis, exc_info=True)
            return opinion

        # 이번 에이전트의 조사에서 새로 생긴 발견만 근거로 인정한다(다른 축이 만든 발견은 인용 불가).
        mine = {fid: f for fid, f in self.toolbox.findings.items() if fid not in known}
        update: dict = {"floor_level": floor, "consulted_tools": self.toolbox.calls[calls_before:]}
        verdict = note.verdict
        if verdict is None:
            update["clamped"] = "에이전트가 판정을 제출하지 않아 규칙 하한을 유지했습니다"
            return opinion.model_copy(update=update)
        level, clamped, refs = _bounded_level(verdict, floor, mine, request)
        update.update(
            level=level, clamped=clamped, evidence_refs=refs, rationale=verdict.reasoning,
            conditions=_conditions(verdict, mine, request),
        )
        return opinion.model_copy(update=update)
