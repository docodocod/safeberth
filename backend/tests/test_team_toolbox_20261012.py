"""도구 상자 — 운영 조회 도구와 발견을 만드는 새 도구 (2026-10-12). DB·그래프 없이 조회 함수를 바꿔친다."""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.agents import tools as judgment_tools
from app.agents.orchestrator.schemas import OrchestratorRequest
from app.agents.safety.schemas import CargoRef, RiskLevel
from app.agents.scheduling.schemas import VesselSpec
from app.agents.team import toolbox as tb
from app.agents.team.toolbox import Toolbox

NOW = datetime(2026, 10, 12, 0, 0, tzinfo=timezone.utc)


def _request() -> OrchestratorRequest:
    return OrchestratorRequest(
        vessel=VesselSpec(draught_m=9.0, call_sign="TEST", name_hint="시험호"),
        cargo=CargoRef(chem_id="001008"),
        window_start=NOW, window_end=NOW + timedelta(hours=24),
        assigned_wharf_name="효성부두",
    )


def _box() -> Toolbox:
    return Toolbox(None, None, _request(), now=NOW)


def _tool(box: Toolbox, agent: str, name: str):
    return next(t for t in box.tools_for(agent) if t.name == name)


def _berth_now(neighbors=()) -> judgment_tools.BerthNow:
    vessel = judgment_tools.VesselNow(call_sign="D8MP", vessel_name="DEMO", zone="BERTH", place="효성부두")
    return judgment_tools.BerthNow(
        wharf_name="효성부두", vessels=[vessel],
        neighbors=[judgment_tools.NeighborNow(wharf_name=n, distance_m=300.0) for n in neighbors],
    )


def test_tools_per_agent():
    box = _box()
    assert [t.name for t in box.tools_for("선석")] == ["who_is_at", "where_is", "same_wharf_status"]
    assert [t.name for t in box.tools_for("기상")] == ["wind_trend"]
    assert [t.name for t in box.tools_for("혼재")] == ["who_is_at", "where_is", "upcoming_neighbor_conflicts"]


@pytest.mark.asyncio
async def test_who_is_at_returns_json_and_records_call(monkeypatch):
    async def fake(db, neo4j, *, wharf):
        return _berth_now()

    monkeypatch.setattr(judgment_tools, "who_is_at", fake)
    box = _box()
    out = await _tool(box, "선석", "who_is_at").ainvoke({"wharf": "효성부두"})
    assert "D8MP" in out and box.calls == ["who_is_at"] and box.findings == {}


@pytest.mark.asyncio
async def test_unknown_wharf_is_reported_not_raised(monkeypatch):
    async def fake(db, neo4j, *, wharf):
        return None

    monkeypatch.setattr(judgment_tools, "who_is_at", fake)
    assert "찾지 못했습니다" in await _tool(_box(), "혼재", "who_is_at").ainvoke({"wharf": "없는부두"})


@pytest.mark.asyncio
async def test_where_is_returns_matches(monkeypatch):
    async def fake(db, *, query):
        return [judgment_tools.VesselNow(call_sign="D8MP", vessel_name="DEMO", zone="UNDERWAY")]

    monkeypatch.setattr(judgment_tools, "where_is", fake)
    box = _box()
    out = await _tool(box, "혼재", "where_is").ainvoke({"query": "D8MP"})
    assert "UNDERWAY" in out and box.calls == ["where_is"]


@pytest.mark.asyncio
async def test_tools_never_use_the_db_session_concurrently(monkeypatch):
    # 검토 초점 7 — ToolNode 는 한 응답의 여러 도구 호출을 병렬로 돌릴 수 있다. AsyncSession 은 동시 사용이 안 된다
    active, peak = 0, 0

    async def fake(db, neo4j, *, wharf):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return _berth_now()

    monkeypatch.setattr(judgment_tools, "who_is_at", fake)
    who = _tool(_box(), "선석", "who_is_at")
    await asyncio.gather(*(who.ainvoke({"wharf": w}) for w in "ABC"))
    assert peak == 1


@pytest.mark.asyncio
async def test_long_results_are_truncated(monkeypatch):
    big = judgment_tools.BerthNow(
        wharf_name="효성부두",
        vessels=[judgment_tools.VesselNow(call_sign=f"S{i:04d}", vessel_name="X" * 40, zone="BERTH") for i in range(200)],
    )

    async def fake(db, neo4j, *, wharf):
        return big

    monkeypatch.setattr(judgment_tools, "who_is_at", fake)
    assert len(await _tool(_box(), "선석", "who_is_at").ainvoke({"wharf": "효성부두"})) <= 1500


@pytest.mark.asyncio
async def test_same_wharf_blocked_vessel_makes_a_present_finding(monkeypatch):
    async def fake(db, *, wharf, exclude_call_sign, now):
        assert (wharf, exclude_call_sign, now) == ("효성부두", "TEST", NOW)   # 자기 자신은 조회에서 뺀다
        return [{"call_sign": "OTHER", "vessel_name": "옆배", "level": "부적합", "reason": "기상 조건이 작업 한계를 넘었습니다",
                 "assessed_at_utc": NOW - timedelta(hours=1)}]

    monkeypatch.setattr(tb, "_fetch_same_wharf_blocked", fake)
    box = _box()
    out = await _tool(box, "선석", "same_wharf_status").ainvoke({})
    f = box.findings["F1"]
    assert (f.kind, f.tense, f.supports, f.wharf_name, f.call_sign) == ("SAME_WHARF_BLOCKED", "현재", "주의", "효성부두", "OTHER")
    assert "F1" in json.loads(out)["findings"][0]["id"]


@pytest.mark.asyncio
async def test_same_wharf_clear_makes_no_finding(monkeypatch):
    async def fake(db, **_):
        return []

    monkeypatch.setattr(tb, "_fetch_same_wharf_blocked", fake)
    box = _box()
    out = await _tool(box, "선석", "same_wharf_status").ainvoke({})
    assert box.findings == {} and "없습니다" in out


def _patch_upcoming(monkeypatch, arrivals, risk, baseline=RiskLevel.SAFE):
    seen = {}

    async def fake_who(db, neo4j, *, wharf):
        return _berth_now(neighbors=["A부두"])

    async def fake_arrivals(db, *, wharfs, now, until, exclude_call_sign):
        seen.update(wharfs=wharfs, now=now, until=until, exclude=exclude_call_sign)
        return arrivals

    async def fake_verdict(db, neo4j, req):
        seen.setdefault("pairs", []).append([a.cargo.chem_id for a in req.adjacent_cargos])
        # 이웃 없이(기준선) 물으면 대상 배 자체의 등급, 입항 예정선 화물을 넣어 물으면 risk
        return SimpleNamespace(risk_level=baseline if not req.adjacent_cargos else risk)

    monkeypatch.setattr(judgment_tools, "who_is_at", fake_who)
    monkeypatch.setattr(tb, "_fetch_upcoming_arrivals", fake_arrivals)
    monkeypatch.setattr(tb, "assess_verdict", fake_verdict)
    return seen


def _arrival(chem_ids=("000756",), departure=None):
    return {"callsgn": "INCOMING", "wharf_name": "A부두", "arrival_at_utc": NOW + timedelta(hours=6),
            "departure_at_utc": departure, "chem_ids": list(chem_ids), "cargo_names": ["톨루엔"]}


@pytest.mark.asyncio
async def test_upcoming_conflict_makes_an_expected_finding_with_condition_text(monkeypatch):
    seen = _patch_upcoming(monkeypatch, [_arrival()], RiskLevel.DANGER)
    box = _box()
    await _tool(box, "혼재", "upcoming_neighbor_conflicts").ainvoke({})
    assert seen["wharfs"] == ["효성부두", "A부두"] and seen["exclude"] == "TEST"
    assert seen["now"] == NOW and seen["until"] == NOW + timedelta(hours=24)
    f = box.findings["F1"]
    assert (f.kind, f.tense, f.supports, f.wharf_name, f.call_sign) == ("UPCOMING_NEIGHBOR_CONFLICT", "예정", "주의", "A부두", "INCOMING")
    assert "INCOMING" in f.condition_text and "재확인" in f.condition_text


@pytest.mark.asyncio
async def test_upcoming_blocked_pair_supports_unfit(monkeypatch):
    _patch_upcoming(monkeypatch, [_arrival()], RiskLevel.BLOCKED)
    box = _box()
    await _tool(box, "혼재", "upcoming_neighbor_conflicts").ainvoke({})
    assert box.findings["F1"].supports == "부적합"


@pytest.mark.asyncio
async def test_upcoming_safe_pair_makes_no_finding(monkeypatch):
    _patch_upcoming(monkeypatch, [_arrival()], RiskLevel.SAFE)
    box = _box()
    out = await _tool(box, "혼재", "upcoming_neighbor_conflicts").ainvoke({})
    assert box.findings == {} and "안전" in out


@pytest.mark.asyncio
async def test_upcoming_without_msds_match_is_noted_without_finding(monkeypatch):
    # 검토 초점 8 — 화물이 MSDS 와 매칭되지 않으면 혼재 판정을 하지 않고, 발견도 만들지 않는다
    seen = _patch_upcoming(monkeypatch, [_arrival(chem_ids=())], RiskLevel.DANGER)
    box = _box()
    out = await _tool(box, "혼재", "upcoming_neighbor_conflicts").ainvoke({})
    assert box.findings == {} and "판정 불가" in out and "pairs" not in seen


@pytest.mark.asyncio
async def test_wind_trend_is_information_only(monkeypatch):
    async def fake(db, *, since, until):
        assert until == NOW and since == NOW - timedelta(hours=24)       # 상한 24시간으로 자른다
        return [{"observed_at_utc": NOW - timedelta(hours=1), "station_name": "울산", "wind_speed_ms": 7.5}]

    monkeypatch.setattr(tb, "_fetch_wind_series", fake)
    box = _box()
    out = await _tool(box, "기상", "wind_trend").ainvoke({"hours": 99})
    assert "7.5" in out and box.findings == {}


@pytest.mark.asyncio
async def test_finding_ids_are_sequential_across_tools(monkeypatch):
    async def blocked(db, **_):
        return [{"call_sign": "OTHER", "vessel_name": "옆배", "level": "판정불가", "reason": "x", "assessed_at_utc": NOW}]

    monkeypatch.setattr(tb, "_fetch_same_wharf_blocked", blocked)
    _patch_upcoming(monkeypatch, [_arrival()], RiskLevel.CAUTION)
    box = _box()
    await _tool(box, "선석", "same_wharf_status").ainvoke({})
    await _tool(box, "혼재", "upcoming_neighbor_conflicts").ainvoke({})
    assert list(box.findings) == ["F1", "F2"]


@pytest.mark.asyncio
async def test_risk_already_present_without_the_arrival_is_not_blamed_on_it(monkeypatch):
    # 최종 검토 Important 3 — 대상 배 자체가 이미 '주의'(같은 배 화물끼리 충돌 등)면, 입항 예정선을 넣어도 같은 '주의'는
    # 그 배 때문이 아니다. 발견을 만들면 조건 문장이 엉뚱한 배를 가리킨다.
    _patch_upcoming(monkeypatch, [_arrival()], RiskLevel.CAUTION, baseline=RiskLevel.CAUTION)
    box = _box()
    out = await _tool(box, "혼재", "upcoming_neighbor_conflicts").ainvoke({})
    assert box.findings == {} and "자체 등급" in out


@pytest.mark.asyncio
async def test_arrival_that_raises_risk_above_the_vessels_own_level_is_a_finding(monkeypatch):
    _patch_upcoming(monkeypatch, [_arrival()], RiskLevel.DANGER, baseline=RiskLevel.CAUTION)
    box = _box()
    await _tool(box, "혼재", "upcoming_neighbor_conflicts").ainvoke({})
    assert box.findings["F1"].supports == "주의"
