"""도구 상자의 SQL 이 실제 스키마(로컬 개발 DB)에서 실행되는지 본다 (2026-10-12).

결과 행 수는 데이터에 따라 0 일 수 있다 — 컬럼 이름·타입·조인이 틀리면 여기서 깨진다.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.agents.team import toolbox as tb

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
