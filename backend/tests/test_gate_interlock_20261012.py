"""하역 개시 인터락 — 게이트 판단 (2026-10-12).

세 문제를 고정한다(2026-10-12 실데이터 재현):
  ① 같은 부두 2척의 사유(reasons) 개수가 다르면 스냅샷 쿼리가 array_agg 오류로 죽었다.
  ② 판정이 바뀌지 않으면 새 행이 없어, 같은 '부적합'이 6시간 넘게 이어지면 게이트가 목록에서 사라졌다.
  ③ '하역중' 필터를 최신 행 고르기 전에 걸어, 최신 판정이 바뀌어도 옛 '하역중' 판정이 계속 잠갔다.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.services.gate_state import build_gate_snapshot, gate_sources

NOW = datetime(2026, 10, 12, 4, 0, tzinfo=timezone.utc)


def _j(call_sign, wharf, level, *, stage="하역중", hours_ago=1.0, reasons=("사유",), name=None):
    return {"call_sign": call_sign, "vessel_name": name or call_sign, "wharf_name": wharf, "level": level,
            "stage": stage, "reasons": list(reasons), "assessed_at_utc": NOW - timedelta(hours=hours_ago)}


def _by_wharf(rows):
    return {r["wharf_name"]: r for r in rows}


def test_two_vessels_with_different_reason_counts_do_not_break():
    # ① — 사유 개수(6·7)가 달라도 부두 하나로 묶인다. 막는 배가 대표다.
    rows = gate_sources(
        [_j("A", "가스부두", "적합", reasons=["1"] * 6), _j("B", "가스부두", "부적합", reasons=["2"] * 7)],
        {"A": ("BERTH", "가스부두"), "B": ("BERTH", "가스부두")}, NOW,
    )
    g = _by_wharf(rows)["가스부두"]
    assert (g["vessel_count"], g["blocked"], g["lead_call_sign"], g["lead_level"]) == (2, True, "B", "부적합")
    assert g["lead_reasons"] == ["2"] * 7


def test_persistent_unfit_on_berth_keeps_the_gate_beyond_six_hours():
    # ② — 7시간째 같은 '부적합'(새 행 없음). AIS 로 그 부두에 접안해 있으면 시간과 상관없이 잠근다.
    rows = gate_sources([_j("A", "SK6부두", "부적합", hours_ago=7)], {"A": ("BERTH", "SK6부두")}, NOW)
    assert _by_wharf(rows)["SK6부두"]["blocked"] is True


def test_newer_non_cargo_judgment_supersedes_old_cargo_judgment():
    # ③ — 함수는 배별 최신 판정만 받는다. 최신이 '접안직전'이면 하역 게이트에 넣지 않는다.
    rows = gate_sources([_j("A", "UTK 신항부두", "적합", stage="접안직전")], {"A": ("BERTH", "UTK 신항부두")}, NOW)
    assert rows == []


def test_vessel_seen_elsewhere_or_moving_is_excluded_even_if_recent():
    # 떠났다는 증거(AIS 상 다른 곳·항해 중)가 있으면 뺀다 — 근거가 틀린 인터락을 막는다.
    judgments = [_j("MOVING", "SK6부두", "판정불가"), _j("OTHER", "정일1부두", "부적합"), _j("ANCH", "6부두", "부적합")]
    presence = {"MOVING": ("UNDERWAY", "SK6부두"), "OTHER": ("BERTH", "UTT부두"), "ANCH": ("ANCHORAGE", None)}
    assert gate_sources(judgments, presence, NOW) == []


def test_no_ais_record_falls_back_to_the_six_hour_window():
    # AIS 기록이 없으면 떠났는지 알 수 없다 — 기존처럼 6시간 이내 판정만 반영한다(기존보다 나빠지지 않게).
    rows = gate_sources([_j("RECENT", "양곡부두", "판정불가", hours_ago=2), _j("OLD", "가스부두", "부적합", hours_ago=7)],
                        {}, NOW)
    assert list(_by_wharf(rows)) == ["양곡부두"]


def test_call_signs_are_compared_case_and_space_insensitively():
    rows = gate_sources([_j(" d7at ", "UTK 신항부두", "부적합", hours_ago=8)], {"D7AT": ("BERTH", "UTK 신항부두")}, NOW)
    assert _by_wharf(rows)["UTK 신항부두"]["blocked"] is True


def test_clear_wharf_is_listed_but_not_blocked():
    rows = gate_sources([_j("A", "4부두", "적합")], {"A": ("BERTH", "4부두")}, NOW)
    g = _by_wharf(rows)["4부두"]
    assert g["blocked"] is False and g["vessel_count"] == 1 and g["assessed_at_utc"] == NOW - timedelta(hours=1)


@pytest.mark.asyncio
async def test_snapshot_builds_on_live_data(db):
    # ① 실데이터 회귀 — 2026-10-12 로컬 DB 에서 사유 개수가 다른 2척 부두 5곳 때문에 스냅샷이 죽었다
    snapshot = await build_gate_snapshot(db)
    assert snapshot["assessment_connected"] is True
    for gate in snapshot["gates"]:
        assert {"gate_id", "state", "level", "call_sign", "vessel_count", "reasons"} <= set(gate)
