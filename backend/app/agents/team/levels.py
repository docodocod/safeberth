"""등급 결합 — 규칙 하한과 에이전트 팀의 판정 (2026-10-12, 계획 2).

규칙 엔진은 하한만 준다. 팀이 하한 위로 올린 축이 있으면 그 등급이 최종 등급이 되지만 **'주의'까지만** 받는다
(TEAM_CAP). '부적합'은 판정 기록에서 하역 밸브 게이트를 잠그므로(GATE_BLOCKING_LEVELS) 규칙 하한만 낼 수 있다.
규칙이 '판정불가'(근거 부족)이면 팀이 풀지 못한다 — 추측으로 근거 부족을 메우면 '모르면 닫는다'가 깨진다.
"""

from app.agents.tools import Opinion

# '판정불가'는 순서에 없다 — 높고 낮음이 아니라 판정을 못 한 상태다.
RANK: dict[str, int] = {"적합": 0, "주의": 1, "부적합": 2}
TEAM_CAP = "주의"


def _team_raise(o: Opinion) -> bool:
    return (
        o.floor_level in RANK and o.level in RANK
        and RANK[o.floor_level] < RANK[o.level] <= RANK[TEAM_CAP]
    )


def apply_team_level(level: str, headline: str, opinions: list[Opinion]) -> tuple[str, str]:
    """규칙 등급(level·headline)과 팀이 올린 축을 합친 최종 (등급, 이유 한 줄)."""
    if level not in RANK:
        return level, headline
    raised = [o for o in opinions if _team_raise(o) and RANK[o.level] > RANK[level]]
    if not raised:
        return level, headline
    top = max(raised, key=lambda o: RANK[o.level])
    return top.level, f"에이전트 팀({top.axis})이 '{top.level}'로 상향 — {top.rationale}"


def team_conditions(opinions: list[Opinion]) -> list[str]:
    return list(dict.fromkeys(c for o in opinions for c in o.conditions))
