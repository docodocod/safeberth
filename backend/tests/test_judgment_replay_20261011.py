"""판정 리플레이 도구의 순수 함수 — 라이브 DB 없이 본다 (2026-10-11)."""
from types import SimpleNamespace

from evals.judgment_replay import diff, summarize


def _result(level="적합", wharfs=()):
    return SimpleNamespace(
        level=level,
        overall_decision=SimpleNamespace(value="적합"),
        headline="이 선석이 맞습니다",
        opinions=[SimpleNamespace(axis="선석", level="적합"), SimpleNamespace(axis="기상", level="적합")],
        conditions=[],
        needs_check=[],
        suggested_alternatives=[SimpleNamespace(wharf_name=w) for w in wharfs],
    )


def test_summarize_keeps_only_comparable_fields():
    s = summarize(_result(wharfs=("효성부두",)))
    assert s == {
        "level": "적합", "overall_decision": "적합", "headline": "이 선석이 맞습니다",
        "axes": {"선석": "적합", "기상": "적합"}, "conditions": [], "needs_check": [],
        "alternatives": ["효성부두"],
    }


def test_diff_is_empty_for_identical_runs():
    run = {"D8MP": summarize(_result())}
    assert diff(run, run) == []


def test_diff_reports_changed_field_and_missing_vessels():
    before = {"A": summarize(_result("적합")), "B": summarize(_result())}
    after = {"A": summarize(_result("주의")), "C": summarize(_result())}
    lines = diff(before, after)
    assert "A.level: '적합' → '주의'" in lines
    assert "B: 이번 실행에 없음" in lines
    assert "C: 이전 실행에 없음" in lines


def test_diff_surfaces_error_entries():
    # 한 척이 실패해도 나머지는 기록된다 — 실패는 error 필드로 남아 비교에서 눈에 띈다
    before = {"A": summarize(_result())}
    after = {"A": {"error": "RuntimeError('x')"}}
    assert any(line.startswith("A.error") for line in diff(before, after))
