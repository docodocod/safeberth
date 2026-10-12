"""라벨 양식·채점 — 사람이 단 정답으로 규칙과 팀을 비교한다 (2026-10-12). DB·네트워크 없음."""
from evals.label_cases import score


def _row(rule, team, label, conds_ok=""):
    return {"rule_level": rule, "team_level": team, "label_level": label, "label_conditions_ok": conds_ok}


def test_score_counts_raises_false_alarms_and_misses():
    rows = [
        _row("적합", "적합", "적합"),          # 둘 다 맞음
        _row("적합", "주의", "주의"),          # 팀 상향이 맞음
        _row("적합", "주의", "적합"),          # 팀 오경보
        _row("적합", "적합", "주의"),          # 둘 다 놓침
    ]
    s = score(rows)
    assert (s["labeled"], s["rule_correct"], s["team_correct"]) == (4, 2, 2)
    assert (s["team_raised"], s["team_raised_correct"], s["false_alarms"], s["misses"]) == (2, 1, 1, 1)


def test_blank_or_unknown_labels_are_skipped_and_counted():
    # 검토 초점 8
    s = score([_row("적합", "적합", ""), _row("적합", "적합", "위험해요"), _row("적합", "적합", "적합")])
    assert (s["labeled"], s["skipped"]) == (1, 2)
