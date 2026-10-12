"""에이전트 팀 측정 — 실제 판정 대상을 팀 꺼짐/켜짐으로 돌려 규칙 위반·발견 커버리지·채택률을 본다 (2026-10-12).

**단위 테스트가 아니다.** 라이브 PostgreSQL·Neo4j 와 OPENAI_API_KEY 가 필요하고 **유료 호출**이 있다(1척당 축마다
모델 호출 1회 이상). CI 에 넣지 말 것. 정답 라벨이 없어 정답률은 재지 못한다 — 라벨 없이 계산되는 지표와, 사람이 읽을
상향·조건 이유를 출력한다. 데이터가 오래됐으면(입항 예정이 0건 등) 발견 커버리지가 0 으로 나온다 — 먼저 data-pipeline
수집이 최신인지 확인한다.

실행:
    cd backend
    .venv/Scripts/python -m evals.team_compare --limit 5
    .venv/Scripts/python -m evals.team_compare --call-sign D8MP
"""
import argparse
import asyncio
import io
import sys
from collections import Counter

from app.agents.orchestrator.service import orchestrate
from app.agents.team.levels import RANK, TEAM_CAP
from app.agents.team.team import Team
from app.agents.team.toolbox import Toolbox
from app.config import get_settings
from app.database import AsyncSessionFactory
from app.jobs.arrival_watcher import _QUERY_ASSESSMENT_TARGETS, PRESENCE_GRACE_HOURS
from app.llm.null_client import NullLLMClient
from app.llm.openai_client import OpenAiClient
from app.neo4j_client import neo4j_client
from evals.judgment_replay import _request_from_row


async def _requests(call_sign: str | None, limit: int | None):
    async with AsyncSessionFactory() as db:
        rows = [
            dict(r)
            for r in (await db.execute(_QUERY_ASSESSMENT_TARGETS, {"grace_hours": PRESENCE_GRACE_HOURS})).mappings().all()
        ]
    out = [req for row in rows if not call_sign or row["callsgn"] == call_sign if (req := _request_from_row(row))]
    return out[:limit] if limit else out


async def main(call_sign: str | None, limit: int | None) -> int:
    requests = await _requests(call_sign, limit)
    if not requests:
        print("판정할 대상이 없습니다")
        return 1
    settings = get_settings()
    client = OpenAiClient(api_key=settings.openai_api_key, model=settings.llm_model)

    violations: list[str] = []
    kinds: Counter = Counter()
    present_vessels = raised_vessels = expected_total = conditions_total = errors = 0
    for request in requests:
        cs = request.vessel.call_sign
        try:
            async with AsyncSessionFactory() as db:
                plain = await orchestrate(db, neo4j_client.driver, NullLLMClient(), request)
            async with AsyncSessionFactory() as db:
                toolbox = Toolbox(db, neo4j_client.driver, request)
                team = Team(chat_model=client.chat_model(), toolbox=toolbox)
                with_team = await orchestrate(db, neo4j_client.driver, NullLLMClient(), request, team=team)
        except Exception as e:  # noqa: BLE001 - 한 척의 실패가 나머지 측정을 막지 않게 한다
            errors += 1
            print(f"오류 {cs}: {e!r}")
            continue

        findings = list(toolbox.findings.values())
        kinds.update(f.kind for f in findings)
        has_present = any(f.tense == "현재" for f in findings)
        present_vessels += has_present
        expected_total += sum(f.tense == "예정" for f in findings)

        if plain.level in RANK and with_team.level in RANK and RANK[with_team.level] < RANK[plain.level]:
            violations.append(f"하향 {cs}: {plain.level} → {with_team.level}")
        for o in with_team.opinions:
            if o.floor_level in RANK and o.level in RANK and RANK[o.level] > RANK[o.floor_level]:
                raised_vessels += 1
                if RANK[o.level] > RANK[TEAM_CAP]:
                    violations.append(f"상한 초과 {cs} [{o.axis}] {o.floor_level}→{o.level}")
                if not o.evidence_refs:
                    violations.append(f"근거 없는 상향 {cs} [{o.axis}]")
                print(f"  상향 {cs} [{o.axis}] {o.floor_level}→{o.level} 근거 {o.evidence_refs} · {o.rationale}")
            for c in o.conditions:
                conditions_total += 1
                print(f"  조건 {cs} [{o.axis}] {c}  · 이유: {o.rationale}")
            if o.clamped:
                print(f"  보정 {cs} [{o.axis}] {o.clamped}")
        for line in with_team.deliberation:
            print(f"  회의록 {cs} | {line}")

    n = len(requests) - errors
    print(f"\n선박 {n}척 측정 (오류 {errors}척)")
    print(f"발견(종류별): {dict(kinds) or '없음'}")
    print(f"현재 발견이 있던 선박 {present_vessels}척 · 팀 상향 {raised_vessels}건")
    print(f"예정 발견 {expected_total}건 · 붙인 조건 {conditions_total}건")
    if violations:
        print(f"\n*** 규칙 위반 {len(violations)}건 ***")
        print("\n".join(f"  {v}" for v in violations))
    return 2 if violations else 0


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--call-sign")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.call_sign, args.limit)))
