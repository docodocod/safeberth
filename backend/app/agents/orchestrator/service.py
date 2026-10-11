"""오케스트레이터 — 정해진 선석 하나가 지금 이 배·화물에 맞는가(검증모드 전용).

흐름 (감독자 — 27번 설계안):
1. 선석 도구(check_berth): 판정할 선석의 가용수심·흘수 여유·이웃 화물. 맞지 않으면
   종료 — 근거 부족이면 판정불가, 실제 부적합이면 대체 선석 **제안**을 붙인다.
2. 기상 도구(check_weather): 그 선석의 임계값으로 판정. 정상이 아니면 종료
   (관측 없음 → 판정불가, 기준 초과 → 기상 사유 + 대체 제안).
3. 혼재 도구(check_segregation): 이웃 화물과의 규칙 하한. 배정불가면 부적합 + 대체 제안.
4. 교차 확인(_cross_check): 체류 중 예보 악화 등 조건을 붙인다.
5. 마무리(_finish): 판정 기록과 같은 함수로 등급·등급 이유를 정하고, 도구 의견의 '못 본 것'을
   '확인 필요'로 모은 뒤, 판정불가가 아니면 LLM 이 관제사용 문장을 쓴다(등급은 바꾸지 못한다).
도구마다 의견(Opinion: 등급 · 확인한 것 · 못 본 것)을 모아 결과에 싣는다.

[2026-09-27] 탐색모드(선석 top-3 를 새로 고르고, 점유면 대체 선석 → 정박지 대기로
재탐색)를 걷어냈다(27번 설계안 D단계, 결정 7-3). 우리는 배정하지 않는다 — 실측(9/27):
종합 판정 콘솔이 탐색모드로 43척 중 42척에 실제 접안 선석 검증과 다른 답(다른 선석
추천·'적합 선석 없음')을 보여 주고 있었다. 정박지는 위치로 관찰만 한다(/dashboard/anchorages).
"""

import asyncio
import logging
from collections.abc import Awaitable

from neo4j import AsyncDriver
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents import tools  # noqa: F401 - 테스트가 service.tools 를 바꿔친다(graph.py 와 같은 모듈 객체)
from app.agents.team.levels import apply_team_level, team_conditions
from app.agents.team.team import Team
from app.llm.base import LLMClient
from app.models.assessment_history import AssessmentLevel
from app.services.assessment import level_from_decision

from .graph import build_judge_graph
from .prompt import ASSIGNMENT_WORDS, SYSTEM_PROMPT, build_user_prompt
from .schemas import LLMSummary, OrchestratorRequest, OrchestratorResult

logger = logging.getLogger(__name__)

def _template_summary(result: OrchestratorResult) -> str:
    """LLM 없이 쓰는 종합 문장 — 판정불가이거나 LLM 을 부르지 않는 회차(판정 잡)."""
    head = result.headline.rstrip(". ")
    if result.level == AssessmentLevel.UNKNOWN.value:
        # 빠진 근거가 '확인 필요'에 이미 적혀 있으면 같은 문장을 되풀이하지 않는다 — 판정불가 건은
        # 등급 이유와 확인 필요가 같은 문장이라 화면에 세 번 떴다(실측 장생포호안).
        if result.needs_check:
            return "판정에 필요한 근거가 없어 판정하지 못했습니다. 확인 필요 항목의 빠진 근거를 채운 뒤 다시 판정해야 합니다."
        return f"{head}. 빠진 근거를 채운 뒤 다시 판정해야 합니다."
    if result.needs_check:
        return f"{head}. 확인 필요: {', '.join(m.split(' — ')[0] for m in result.needs_check)}."
    return f"{head}."


async def _finish(
    result: OrchestratorResult, request: OrchestratorRequest, llm_client: LLMClient | None,
) -> OrchestratorResult:
    """등급·등급 이유·확인 필요를 채우고 종합 문장을 붙인다.

    등급은 판정 기록과 **같은 함수**(level_from_decision)로 정한다 — 예전엔 화면이
    overall_decision 을 그대로 써서, 기록은 '주의'인데 콘솔은 초록 '적합'으로 보였다.
    판정불가면 LLM 을 부르지 않는다 — 정리할 판정이 없고, 템플릿이 빠진 근거를 그대로 말한다.
    """
    result.target_source = request.target_source
    level, headline = level_from_decision(result)
    # [2026-10-12] 에이전트 팀이 하한 위로 올린 축('주의'까지)과 팀이 붙인 조건을 반영한다(문서 5장).
    # 아래 `level is not AssessmentLevel.UNKNOWN` 검사는 규칙 등급 기준 그대로다 — 팀은 판정불가를 풀지 못한다.
    result.level, result.headline = apply_team_level(level.value, headline, result.opinions)
    result.conditions += [c for c in team_conditions(result.opinions) if c not in result.conditions]
    result.needs_check = list(dict.fromkeys(m for o in result.opinions for m in o.missing))
    summary = ""
    if llm_client is not None and level is not AssessmentLevel.UNKNOWN:
        llm_result = await llm_client.generate_structured(
            system_prompt=SYSTEM_PROMPT,
            user_prompt=build_user_prompt(result, request),
            schema=LLMSummary,
        )
        summary = llm_result.summary.strip()
        # '배정된 선석'은 PORT-MIS 사전배정 사실이라 금지어 검사에서 뺀다(등급 이유의 주어다).
        if any(w in summary.replace("배정된", "") for w in ASSIGNMENT_WORDS):
            logger.warning("종합 문장에 배정·추천 어휘 — 템플릿으로 대체: %s", summary)
            summary = ""
    result.summary = summary or _template_summary(result)
    return result


async def orchestrate(
    db: AsyncSession,
    neo4j_driver: AsyncDriver,
    llm_client: LLMClient,
    request: OrchestratorRequest,
    *,
    summarize: bool = True,
    team: Team | None = None,
) -> OrchestratorResult:
    """summarize=False 면 종합 문장을 템플릿으로 쓴다(안전 서술 LLM 은 그대로 부른다).

    판정 잡이 쓴다 — 종합 문장은 판정 기록에 저장되지 않아, 잡에서 LLM 으로 쓰면 버려진다.

    [2026-09-29] 혼재 서술 LLM(체크리스트)은 판정 중에 기다리지 않고, 종합 문장 LLM 과 함께 기다린다.
    종합 문장은 규칙 결과(근거·확인 필요)만 보므로 서술을 기다릴 필요가 없다 — 두 호출이 차례로 약 6초였다.
    """
    pending: list[Awaitable[None]] = []
    result = await _judge(db, neo4j_driver, llm_client, request, defer=pending, team=team)
    result, *_ = await asyncio.gather(_finish(result, request, llm_client if summarize else None), *pending)
    return result


async def _judge(
    db: AsyncSession,
    neo4j_driver: AsyncDriver,
    llm_client: LLMClient,
    request: OrchestratorRequest,
    *,
    defer: list[Awaitable[None]] | None = None,
    team: Team | None = None,
) -> OrchestratorResult:
    """판정 본체 — 종합 문장(summary)은 비워 두고 _finish 가 채운다. defer 는 assess_safety 참고.

    [2026-10-11] 선석 → 기상 → 혼재 사슬은 graph.py 의 LangGraph 로 옮겼다(동작 불변).
    """
    graph = build_judge_graph(db, neo4j_driver, llm_client, defer, team)
    final = await graph.ainvoke({"request": request})
    return final["result"]
