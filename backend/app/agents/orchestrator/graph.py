"""판정 그래프 — orchestrator/service.py 의 _judge 를 LangGraph StateGraph 로 옮긴 것.

[2026-10-11] 동작은 하나도 바꾸지 않았다. 선석 → 기상 → 혼재 사슬의 if/return 을 노드와 조건 엣지로 옮겨,
계획 2~3 에서 전문 에이전트·Supervisor 를 이 그래프 위에 올릴 수 있게 한 것이다.

  START → global_weather → berth ─┬→ END          (선석 부적합·근거 부족: result 가 채워짐)
                                  └→ weather ─┬→ END   (기상 불가·판정불가)
                                              └→ segregation → END

노드는 state["result"] 를 채우면 그래프가 거기서 끝난다. 의존(db·neo4j·LLM·defer)은 요청마다 달라
그래프를 요청마다 클로저로 만든다 — 컴파일 비용은 판정 한 번(DB·그래프 질의 수 회)에 비해 무시할 만하다.
"""

from collections.abc import Awaitable
from datetime import timedelta, timezone
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from neo4j import AsyncDriver
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents import tools
from app.agents.safety.schemas import RiskLevel
from app.agents.scheduling.schemas import BerthCandidate, OccupancyStatus
from app.agents.team.team import Team
from app.agents.weather.schemas import WeatherAssessmentResult, WorkStatus
from app.llm.base import LLMClient

from .schemas import OrchestratorRequest, OrchestratorResult, OverallDecision, RejectedCandidate

_KST = timezone(timedelta(hours=9))


def _cross_check(weather: WeatherAssessmentResult) -> tuple[list[str], str]:
    """교차 확인 — 두 의견을 함께 봐야 나오는 결론. (조건 문장들, 기록 비교용 키).

    27번 설계안 3-2 의 규칙 표. 규칙을 늘릴 때는 여기에 한 줄씩 더하고 테스트를 둔다.

    ① 선석 적합 + 지금 기상 정상 + 체류 중 예보 악화 → 등급은 적합 그대로, 악화 예상
       시각을 조건으로 붙인다(결정 7-1: 새 등급을 만들지 않는다). 그 시각에 실제 관측이
       기준을 넘으면 기상 게이트(3초 주기)가 하역을 멈춘다. 25번 점검 C4 — 6시간 뒤
       풍속 25m/s 예보를 넣어도 아무 표시 없이 '적합'이던 문제.
    """
    fw = weather.forecast_warning
    if (
        weather.status is WorkStatus.NORMAL
        and fw is not None
        and fw.will_deteriorate
        and fw.earliest_deterioration_at_utc is not None
    ):
        at = fw.earliest_deterioration_at_utc.astimezone(_KST)
        # [2026-09-29] 무엇이 기준을 넘는 예보인지 적는다 — "하역중단 예보"만으로는 바람인지 비인지 몰랐다.
        cause = f"({' · '.join(fw.earliest_deterioration_causes)}) " if fw.earliest_deterioration_causes else ""
        return (
            [f"체류 중 {at:%m/%d %H:%M} 부터 '{fw.worst_status.value}' 예보 {cause}— "
             f"그 시각 관측이 기준을 넘으면 기상 게이트가 하역을 멈춥니다"],
            f"예보:{fw.worst_status.value}",
        )
    return [], ""


def _place(request: OrchestratorRequest, wharf_name: str) -> str:
    """판정 경로 문장의 주어 — 선석이 어디서 왔는지 그대로 적는다(2026-09-29)."""
    if request.target_source == "AIS":
        return f"지금 접안한 '{wharf_name}'"
    if request.target_source == "PORT-MIS":
        # 아직 붙지 않은 배다 — '접안'이 아니라 PORT-MIS 가 사전배정한 자리다(2026-09-29).
        return f"배정된 '{wharf_name}'"
    return f"'{wharf_name}'"


def _reported_note(request: OrchestratorRequest) -> list[str]:
    """실제 접안 부두와 PORT-MIS 신고 계류시설이 다르면 한 줄 — 신고 정정이 필요하다는 신호다.

    표기만 다른 같은 부두(띄어쓰기·대소문자)는 같다고 본다. 별칭까지는 풀지 않으므로 '다르다'고
    단정하지 않고 신고값만 적는다.
    """
    reported = (request.reported_wharf_name or "").strip()
    norm = lambda s: s.replace(" ", "").upper()  # noqa: E731
    if request.target_source != "AIS" or not reported or norm(reported) == norm(request.assigned_wharf_name):
        return []
    return [f"PORT-MIS 신고 계류시설: '{reported}'"]


class JudgeState(TypedDict, total=False):
    request: OrchestratorRequest
    global_weather: WeatherAssessmentResult   # 전역 폴백 판정 — 선석 확인 실패·혼재 부적합 응답의 weather_assessment 용
    opinions: list[tools.Opinion]
    candidate: BerthCandidate | None
    trace: list[str]
    berth_weather: WeatherAssessmentResult
    result: OrchestratorResult                # 채워지면 그래프는 여기서 끝난다


def _end_or(next_node: str):
    return lambda state: END if state.get("result") is not None else next_node


def build_judge_graph(
    db: AsyncSession,
    neo4j_driver: AsyncDriver,
    llm_client: LLMClient,
    defer: list[Awaitable[None]] | None,
    team: Team | None = None,
):
    async def _decided(opinion: tools.Opinion, request: OrchestratorRequest) -> tools.Opinion:
        # [2026-10-12] 규칙 도구가 낸 의견은 하한이다. 팀이 있으면 전문 에이전트가 조사해 그 위에서 판정한다(문서 5장).
        return opinion if team is None else await team.decide(opinion, request)

    async def _alternatives(request: OrchestratorRequest) -> tools.Alternatives:
        # 배정이 아니라 제안이다(회의 §3 조치안). 지금 선석은 뺀다.
        return await tools.suggest_alternatives(
            db, neo4j_driver,
            cargo=request.cargo, cargos=request.cargos, vessel=request.vessel,
            window_start=request.window_start, window_end=request.window_end,
            exclude_wharf_name=request.assigned_wharf_name,
            draught_margin_m=request.draught_margin_m,
        )

    async def global_weather(state: JudgeState) -> JudgeState:
        # 전역 폴백 판정(__GLOBAL_DEFAULT__ 임계값). 선석을 확인하지 못했거나 혼재로 부적합인
        # 응답의 weather_assessment 를 채우는 용도다 — 통과/차단은 선석별 임계값으로 한다.
        # [2026-09-29] 판정 대상 시설 이름을 넘긴다 — 파고 적용 규칙(wave_applies_to)이 이름으로 정해진다.
        #   안 넘기면 외해 파고가 대입돼, 선석 단계에서 끝난 판정의 기상 칸이 "달포부두 기상 판정: 하역중단
        #   (파고 1.6m)"으로 보였다(실측).
        request = state["request"]
        weather = await tools.check_weather(
            db, window_end=request.window_end, wharf_name=request.assigned_wharf_name,
            as_of=request.weather_as_of,
        )
        return {"global_weather": weather, "opinions": []}

    async def berth(state: JudgeState) -> JudgeState:
        request = state["request"]
        berth_check = await tools.check_berth(
            db,
            neo4j_driver,
            wharf_name=request.assigned_wharf_name,
            vessel=request.vessel,
            window_start=request.window_start,
            window_end=request.window_end,
            draught_margin_m=request.draught_margin_m,
        )
        opinions = [*state["opinions"], await _decided(tools.berth_opinion(berth_check), request)]
        candidate = berth_check.candidate
        if candidate is None:
            # 판정할 시설이 **실제로** 안 맞는 경우에만 대체안을 찾는다(회의 §3 조치안).
            # 근거 부족(표기 미해소·조위 예보 없음)이면 찾지 않는다 — 어디가
            # 문제인지도 모르는 채로 다른 자리를 권하는 건 근거 없는 조언이다.
            suggestion = tools.Alternatives() if berth_check.evidence_missing else await _alternatives(request)
            return {
                "opinions": opinions,
                "result": OrchestratorResult(
                    overall_decision=OverallDecision.NO_ELIGIBLE_BERTH,
                    weather_assessment=state["global_weather"],
                    evidence_missing=berth_check.evidence_missing,
                    assignment_trace=([berth_check.reason] if berth_check.reason else []) + _reported_note(request),
                    suggested_alternatives=suggestion.candidates,
                    suggestion_note=suggestion.note,
                    summary="",
                    opinions=opinions,
                ),
            }

        # [2026-09-21, D2 S2 — 점유는 등급이 아니라 정보] 점유를 이유로 다른 자리를 찾지
        # 않는다. 배는 이미 그 부두에 붙어 있고, 질문은 "이 자리를 줄 수 있나"가 아니라
        # "이 자리가 맞나"다. PORT-MIS 출항 시각이 예정값이라 동시 계류를 과대 계산하고
        # (백테스트 7/125), 점유의 근거인 AIS 실측은 대개 검증 대상 자신이다.
        # 점유 사실은 trace 에 남겨 관제사가 "이 부두에 지금 몇 척이 있다"를 볼 수 있게 한다.
        # 종합 문장(LLM) 입력에는 넣지 않는다 — 넣었더니 "다른 시설로 배정 고려"라고 썼다.
        occ_note = (
            f"참고: 이 시설에 다른 선박이 접안 중입니다(AIS 실측). "
            f"판정 등급에는 반영하지 않습니다"
            if candidate.occupancy_status is OccupancyStatus.OCCUPIED
            else None
        )
        trace = [
            f"{_place(request, candidate.wharf_name)} 확인 "
            f"(수심 {candidate.depth_m}m, 흘수 {request.vessel.draught_m}m, "
            f"여유 {candidate.draught_margin_m:.1f}m)",
            *_reported_note(request),
            *([occ_note] if occ_note else []),
        ]
        return {"opinions": opinions, "candidate": candidate, "trace": trace}

    async def weather(state: JudgeState) -> JudgeState:
        request, candidate = state["request"], state["candidate"]
        # 선석 고유 임계값(berth_group)으로 판정한다. berth_group 이 없어도 wharf_name 을
        # 넘겨 외해 부이 파고가 항내 부두에 대입되지 않게 한다(2026-09-21, D2 ②).
        berth_weather = await tools.check_weather(
            db,
            window_end=request.window_end,
            wharf_name=candidate.wharf_name,
            berth_group=candidate.berth_group,
            as_of=request.weather_as_of,
        )
        opinions = [*state["opinions"], await _decided(tools.weather_opinion(berth_weather), request)]
        update: JudgeState = {"opinions": opinions, "berth_weather": berth_weather}
        if berth_weather.status is WorkStatus.NORMAL:
            return update
        # [2026-09-26] 선석이 아니라 기상 때문이다 — '선석이 맞지 않는다'가 아니라
        # 기상 사유로 판정한다. 관측이 없거나 낡았으면 근거 부족(판정불가)이고 대체안도
        # 찾지 않는다.
        if berth_weather.status is WorkStatus.UNKNOWN:
            update["result"] = OrchestratorResult(
                overall_decision=OverallDecision.WEATHER_BLOCKED,
                weather_assessment=berth_weather,
                evidence_missing=True,
                assignment_trace=state["trace"],
                summary="",
                opinions=opinions,
            )
            return update
        suggestion = await _alternatives(request)
        update["result"] = OrchestratorResult(
            overall_decision=OverallDecision.WEATHER_BLOCKED,
            weather_assessment=berth_weather,
            assignment_trace=state["trace"],
            suggested_alternatives=suggestion.candidates,
            suggestion_note=suggestion.note,
            summary="",
            opinions=opinions,
        )
        return update

    async def segregation(state: JudgeState) -> JudgeState:
        request, candidate = state["request"], state["candidate"]
        safety_result = await tools.check_segregation(
            db,
            neo4j_driver,
            llm_client,
            cargo=request.cargo,
            cargos=request.cargos,
            adjacent_cargos=candidate.adjacent_cargos,
            call_sign=request.vessel.call_sign,
            defer=defer,
        )
        opinions = [*state["opinions"], await _decided(tools.segregation_opinion(safety_result), request)]

        if safety_result.risk_level != RiskLevel.BLOCKED:
            # ── 교차 확인 ───────────────────────────────────────────────────
            conditions, condition_key = _cross_check(state["berth_weather"])
            return {"opinions": opinions, "result": OrchestratorResult(
                overall_decision=OverallDecision.APPROVED,
                selected_berth=candidate,
                safety_assessment=safety_result,
                weather_assessment=state["berth_weather"],
                assignment_trace=state["trace"],
                summary="",
                opinions=opinions,
                conditions=conditions,
                condition_key=condition_key,
            )}

        # 혼재 배정불가 — 이 선석이 이 화물에 맞지 않는다. 대체 선석을 제안한다.
        rejected = [
            RejectedCandidate(
                berth_id=candidate.berth_id, rank=candidate.rank,
                reason="; ".join(safety_result.verdict_basis) or safety_result.reasoning,
            )
        ]
        suggestion = await _alternatives(request)
        return {"opinions": opinions, "result": OrchestratorResult(
            overall_decision=OverallDecision.ALL_CANDIDATES_UNSAFE,
            # [2026-09-29] 혼재 심사 결과를 싣는다 — 빠져 있어 화면이 '혼재 심사 생략'을 띄우고, 근거가
            #   선석 검증 메시지(rejected reason)에 한 덩어리로 몰렸다(사용자 지적, BUENA DIOSA).
            safety_assessment=safety_result,
            weather_assessment=state["global_weather"],
            rejected_candidates=rejected,
            suggested_alternatives=suggestion.candidates,
            suggestion_note=suggestion.note,
            summary="",
            opinions=opinions,
        )}

    graph = StateGraph(JudgeState)
    graph.add_node("global_weather", global_weather)
    graph.add_node("berth", berth)
    graph.add_node("weather", weather)
    graph.add_node("segregation", segregation)
    graph.add_edge(START, "global_weather")
    graph.add_edge("global_weather", "berth")
    graph.add_conditional_edges("berth", _end_or("weather"), {"weather": "weather", END: END})
    graph.add_conditional_edges("weather", _end_or("segregation"), {"segregation": "segregation", END: END})
    graph.add_edge("segregation", END)
    return graph.compile()
