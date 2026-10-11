"""Opinion 의 팀 판정 필드 — 기본값이 비어 있고 옛 페이로드도 읽힌다 (2026-10-12)."""
from app.agents.tools import Opinion


def test_new_fields_default_to_empty():
    o = Opinion(axis="선석", level="적합")
    assert o.floor_level is None and o.rationale == "" and o.clamped == ""
    assert o.consulted_tools == [] and o.evidence_refs == [] and o.conditions == []


def test_old_payloads_without_new_fields_still_parse():
    # 판정 기록·mock 에 저장된 옛 모양 — 새 필드가 없어도 읽혀야 한다
    o = Opinion.model_validate({"axis": "기상", "level": "판정불가", "missing": ["풍속"]})
    assert o.level == "판정불가" and o.missing == ["풍속"]


def test_default_lists_are_not_shared_between_instances():
    a, b = Opinion(axis="선석", level="적합"), Opinion(axis="기상", level="적합")
    a.consulted_tools.append("who_is_at")
    a.conditions.append("조건")
    assert b.consulted_tools == [] and b.conditions == []
