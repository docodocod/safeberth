"""도구 상자의 SQL 이 실제 스키마(로컬 개발 DB)에서 실행되는지 본다 (2026-10-12).

결과 행 수는 데이터에 따라 0 일 수 있다 — 컬럼 이름·타입·조인이 틀리면 여기서 깨진다.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.agents.orchestrator.schemas import OrchestratorRequest
from app.agents.safety.schemas import CargoRef
from app.agents.scheduling.schemas import VesselSpec
from app.agents.team import toolbox as tb
from app.agents.team.toolbox import Toolbox

NOW = datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_fetch_upcoming_arrivals_runs(db):
    rows = await tb._fetch_upcoming_arrivals(
        db, wharfs=["효성부두"], now=NOW - timedelta(days=60), until=NOW + timedelta(days=7), exclude_call_sign=None,
    )
    for r in rows:
        assert {"callsgn", "wharf_name", "arrival_at_utc", "departure_at_utc", "chem_ids", "cargo_names"} <= set(r)


@pytest.mark.asyncio
async def test_fetch_same_wharf_blocked_runs(db):
    rows = await tb._fetch_same_wharf_blocked(db, wharf="효성부두", exclude_call_sign="TEST", now=NOW)
    for r in rows:
        assert r["level"] in ("부적합", "판정불가") and r["call_sign"] != "TEST"


@pytest.mark.asyncio
async def test_fetch_wind_series_runs(db):
    rows = await tb._fetch_wind_series(db, since=NOW - timedelta(days=60), until=NOW)
    assert all(r["wind_speed_ms"] is not None for r in rows)


@pytest.mark.asyncio
async def test_tool_db_error_does_not_break_the_judgment_session(db, monkeypatch):
    # 최종 검토 Important 2 — 도구의 SQL 이 실패해도 판정이 같이 쓰는 세션은 계속 쓸 수 있어야 한다.
    # 아니면 다음 판정 노드가 InFailedSQLTransactionError 로 죽어 /assess 가 하한 판정 대신 500 이 된다.
    monkeypatch.setattr(tb, "_SQL_WIND_SERIES", text("SELECT * FROM no_such_table_20261012"))
    request = OrchestratorRequest(
        vessel=VesselSpec(draught_m=9.0, call_sign="TEST"), cargo=CargoRef(chem_id="001008"),
        window_start=NOW, window_end=NOW + timedelta(hours=24), assigned_wharf_name="효성부두",
    )
    wind = next(t for t in Toolbox(db, None, request, now=NOW).tools_for("기상") if t.name == "wind_trend")
    with pytest.raises(Exception):
        await wind.ainvoke({"hours": 1})
    assert (await db.execute(text("SELECT 1"))).scalar() == 1
