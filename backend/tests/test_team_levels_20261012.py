"""등급 결합 — 팀은 규칙 등급을 '주의'까지만 올릴 수 있다 (2026-10-12)."""
from app.agents.team.levels import RANK, TEAM_CAP, apply_team_level, team_conditions
from app.agents.tools import Opinion
from app.models.assessment_history import AssessmentLevel


def _op(axis, level, floor, rationale="이유", conditions=()):
    return Opinion(axis=axis, level=level, floor_level=floor, rationale=rationale, conditions=list(conditions))


def test_rank_covers_the_enum_vocabulary():
    # 문자열 어휘가 AssessmentLevel 과 어긋나면 상향이 조용히 무시된다 — 값으로 확인한다
    assert set(RANK) | {AssessmentLevel.UNKNOWN.value} == {l.value for l in AssessmentLevel}
    assert RANK["적합"] < RANK["주의"] < RANK["부적합"] and TEAM_CAP == "주의"


def test_opinions_without_team_verdict_change_nothing():
    assert apply_team_level("적합", "규칙 이유", [Opinion(axis="선석", level="부적합")]) == ("적합", "규칙 이유")


def test_team_raise_is_followed_and_explained():
    ops = [_op("선석", "주의", "적합", "같은 부두 다른 선박의 최신 판정이 '부적합'입니다")]
    assert apply_team_level("적합", "규칙 이유", ops) == (
        "주의", "에이전트 팀(선석)이 '주의'로 상향 — 같은 부두 다른 선박의 최신 판정이 '부적합'입니다",
    )


def test_team_level_above_cap_is_ignored_defensively():
    # Team.decide 가 이미 깎지만, 결합 단계에서도 '주의' 위의 팀 상향은 받지 않는다(두 겹)
    assert apply_team_level("적합", "규칙 이유", [_op("혼재", "부적합", "적합")]) == ("적합", "규칙 이유")


def test_team_at_floor_changes_nothing():
    assert apply_team_level("주의", "규칙 이유", [_op("혼재", "주의", "주의")]) == ("주의", "규칙 이유")


def test_team_cannot_lower_and_unknown_is_never_resolved():
    assert apply_team_level("부적합", "x", [_op("선석", "주의", "적합")]) == ("부적합", "x")
    assert apply_team_level("판정불가", "x", [_op("선석", "주의", "적합")]) == ("판정불가", "x")


def test_team_conditions_are_collected_in_order_without_duplicates():
    ops = [_op("선석", "적합", "적합", conditions=["A"]), _op("혼재", "적합", "적합", conditions=["B", "A"])]
    assert team_conditions(ops) == ["A", "B"]
