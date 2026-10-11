"""판정 리플레이 — 지금 판정 대상 전체를 LLM 없이 돌려 결과를 JSON 으로 남기고 전후를 비교한다.

**단위 테스트가 아니다.** 라이브 PostgreSQL·Neo4j 가 필요하다. CI 에 넣지 말 것.
오케스트레이터 내부 구조(함수 → LangGraph)를 바꿀 때 "등급이 그대로인가"를 보는 용도다. 기상·AIS 관측은
계속 변하므로 전후 실행 간격을 짧게(몇 분) 둔다. 차이가 나오면 먼저 관측이 바뀐 것인지 가린다.

실행:
    cd backend
    .venv/Scripts/python -m evals.judgment_replay --out evals/results/replay_before.json
    .venv/Scripts/python -m evals.judgment_replay --compare evals/results/replay_before.json
"""
import argparse
import asyncio
import io
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.agents.orchestrator.schemas import OrchestratorRequest
from app.agents.orchestrator.service import orchestrate
from app.agents.safety.schemas import CargoRef
from app.agents.scheduling.schemas import VesselSpec
from app.database import AsyncSessionFactory
from app.jobs.arrival_watcher import (
    _QUERY_ASSESSMENT_TARGETS,
    DEFAULT_WINDOW_HOURS,
    MIN_FORWARD_HOURS,
    PRESENCE_GRACE_HOURS,
    _target_wharf,
)
from app.llm.null_client import NullLLMClient
from app.neo4j_client import neo4j_client


def summarize(result) -> dict:
    """비교에 쓰는 필드만 — 문장(summary)은 LLM 을 안 쓰므로 템플릿이라 비교 가치가 낮다."""
    return {
        "level": result.level,
        "overall_decision": result.overall_decision.value,
        "headline": result.headline,
        "axes": {o.axis: o.level for o in result.opinions},
        "conditions": list(result.conditions),
        "needs_check": list(result.needs_check),
        "alternatives": [c.wharf_name for c in result.suggested_alternatives],
    }


def diff(before: dict, after: dict) -> list[str]:
    lines: list[str] = []
    for key in sorted(before.keys() | after.keys()):
        if key not in after:
            lines.append(f"{key}: 이번 실행에 없음")
        elif key not in before:
            lines.append(f"{key}: 이전 실행에 없음")
        else:
            for field in sorted(before[key].keys() | after[key].keys()):
                b, a = before[key].get(field), after[key].get(field)
                if b != a:
                    lines.append(f"{key}.{field}: {b!r} → {a!r}")
    return lines


def _request_from_row(row: dict) -> OrchestratorRequest | None:
    """watch_arrivals 가 판정 전에 거르는 조건과 같다 — 판정불가 갈래의 행은 오케스트레이터에 가지 않는다."""
    target, source = _target_wharf(row)
    if target is None or not row.get("chem_ids") or not row.get("draught_m") or float(row["draught_m"]) <= 0:
        return None
    now = datetime.now(timezone.utc)
    window_start = row.get("arrival_at_utc") or now
    dwell_h = row.get("median_dwell_hours") or DEFAULT_WINDOW_HOURS
    window_end = max(
        window_start + timedelta(hours=float(dwell_h)),
        now + timedelta(hours=MIN_FORWARD_HOURS),
    )
    return OrchestratorRequest(
        vessel=VesselSpec(
            draught_m=row["draught_m"], dwt_t=None, name_hint=row.get("vessel_name"), call_sign=row["callsgn"],
        ),
        cargo=CargoRef(chem_id=row["chem_ids"][0]),
        cargos=[CargoRef(chem_id=c) for c in row["chem_ids"][1:]],
        window_start=window_start,
        window_end=window_end,
        assigned_wharf_name=target,
        target_source=source,
        reported_wharf_name=row.get("assigned_facility_name"),
    )


async def _run() -> dict:
    async with AsyncSessionFactory() as db:
        rows = [
            dict(r)
            for r in (await db.execute(_QUERY_ASSESSMENT_TARGETS, {"grace_hours": PRESENCE_GRACE_HOURS})).mappings().all()
        ]
    out: dict = {}
    for row in rows:
        request = _request_from_row(row)
        if request is None:
            continue
        try:
            async with AsyncSessionFactory() as db:
                result = await orchestrate(db, neo4j_client.driver, NullLLMClient(), request)
            out[row["callsgn"]] = summarize(result)
        except Exception as e:  # noqa: BLE001 - 한 척의 실패가 나머지 기록을 막지 않게 한다
            out[row["callsgn"]] = {"error": repr(e)}
    return out


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", help="결과를 이 JSON 파일로 저장")
    parser.add_argument("--compare", help="이 JSON 과 지금 결과를 비교")
    args = parser.parse_args()

    current = asyncio.run(_run())
    print(f"판정 {len(current)}척 (오류 {sum('error' in v for v in current.values())}척)")
    if args.out:
        Path(args.out).write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"저장: {args.out}")
    if args.compare:
        before = json.loads(Path(args.compare).read_text(encoding="utf-8"))
        lines = diff(before, current)
        print("\n".join(lines) if lines else "차이 없음")
        return 1 if lines else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
