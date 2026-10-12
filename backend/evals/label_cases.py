"""라벨 양식 내보내기·채점 — 팀 판정이 규칙보다 나은지 사람의 정답으로 잰다 (2026-10-12, 계획 3).

**단위 테스트가 아니다**(채점 함수만 테스트한다). export 는 라이브 DB 가 필요하고 --with-team 이면 **유료 호출**이 있다.
CI 에 넣지 말 것. 라벨 파일은 선박 호출부호가 든 운영성 데이터라 기본 위치를 evals/results/(gitignore)로 둔다.

사용:
    cd backend
    .venv/Scripts/python -m evals.label_cases export --out evals/results/labels.csv --limit 30 --with-team
    (사람이 label_level 에 적합·주의·부적합·판정불가 중 하나, label_conditions_ok 에 예/아니오, label_note 에 이유를 적는다)
    .venv/Scripts/python -m evals.label_cases score evals/results/labels.csv
"""
import argparse
import asyncio
import csv
import io
import sys

LEVELS = ("적합", "주의", "부적합", "판정불가")
_RANK = {"적합": 0, "주의": 1, "부적합": 2}
FIELDS = ["case_id", "call_sign", "vessel", "wharf", "rule_level", "rule_headline", "team_level", "team_reason",
          "team_conditions", "deliberation", "label_level", "label_conditions_ok", "label_note"]


def case_row(case_id: str, request, plain, team_result) -> dict:
    raised = [o for o in (team_result.opinions if team_result else []) if o.floor_level and o.level != o.floor_level]
    return {
        "case_id": case_id, "call_sign": request.vessel.call_sign or "", "vessel": request.vessel.name_hint or "",
        "wharf": request.assigned_wharf_name, "rule_level": plain.level, "rule_headline": plain.headline,
        "team_level": team_result.level if team_result else "", "team_reason": " / ".join(o.rationale for o in raised),
        "team_conditions": " / ".join(c for c in (team_result.conditions if team_result else []) if c not in plain.conditions),
        "deliberation": " / ".join(team_result.deliberation) if team_result else "",
        "label_level": "", "label_conditions_ok": "", "label_note": "",
    }


def score(rows: list[dict]) -> dict:
    s = dict(labeled=0, skipped=0, rule_correct=0, team_correct=0, team_raised=0, team_raised_correct=0,
             false_alarms=0, misses=0)
    for r in rows:
        label = (r.get("label_level") or "").strip()
        if label not in LEVELS:
            s["skipped"] += 1
            continue
        s["labeled"] += 1
        rule, team = r["rule_level"], r.get("team_level") or r["rule_level"]
        s["rule_correct"] += rule == label
        s["team_correct"] += team == label
        if team in _RANK and rule in _RANK and _RANK[team] > _RANK[rule]:
            s["team_raised"] += 1
            s["team_raised_correct"] += team == label
            s["false_alarms"] += team != label and label in _RANK and _RANK[label] <= _RANK[rule]
        if label in _RANK and team in _RANK and _RANK[label] > _RANK[team]:
            s["misses"] += 1
    return s


async def _export(out: str, limit: int, with_team: bool) -> int:
    from app.agents.orchestrator.service import orchestrate
    from app.agents.team.team import Team
    from app.agents.team.toolbox import Toolbox
    from app.config import get_settings
    from app.database import AsyncSessionFactory
    from app.llm.null_client import NullLLMClient
    from app.llm.openai_client import OpenAiClient
    from app.neo4j_client import neo4j_client
    from evals.team_compare import _requests

    requests = await _requests(None, limit)
    client = OpenAiClient(api_key=get_settings().openai_api_key, model=get_settings().llm_model) if with_team else None
    rows = []
    for i, request in enumerate(requests, start=1):
        async with AsyncSessionFactory() as db:
            plain = await orchestrate(db, neo4j_client.driver, NullLLMClient(), request)
        team_result = None
        if client is not None:
            async with AsyncSessionFactory() as db:
                team = Team(chat_model=client.chat_model(), toolbox=Toolbox(db, neo4j_client.driver, request))
                team_result = await orchestrate(db, neo4j_client.driver, NullLLMClient(), request, team=team)
        rows.append(case_row(f"C{i:03d}", request, plain, team_result))
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)}건 저장: {out} — label_level·label_conditions_ok·label_note 를 채워 score 로 채점하세요")
    return 0


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--out", required=True)
    e.add_argument("--limit", type=int, default=30)
    e.add_argument("--with-team", action="store_true")
    s = sub.add_parser("score")
    s.add_argument("path")
    args = parser.parse_args()
    if args.cmd == "export":
        return asyncio.run(_export(args.out, args.limit, args.with_team))
    with open(args.path, encoding="utf-8-sig") as f:
        result = score(list(csv.DictReader(f)))
    for k, v in result.items():
        print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
