# -*- coding: utf-8 -*-
"""종합 판정(오케스트레이터) 녹화 — 스냅샷 배포본에서도 대표 기능이 뜨게 한다.

왜 브라우저 없이 되는가:
    안전 심사는 '대상 화물 + 인접 선석 재항 화물' 조합이 키라, 화면이 만드는
    인접 목록을 그대로 재현해야 해서 브라우저로 녹화한다(record_agents.mjs).
    반면 종합 판정은 키가 **호출부호 하나**다(snapshotMode.js 참고). 그래서
    같은 호출부호로 API 를 직접 부르면 화면이 받는 것과 같은 답이 나온다.
    브라우저를 띄우지 않으므로 훨씬 빠르다.

전제: 백엔드(8001)가 떠 있을 것. make_snapshot.py 를 먼저 돌려 둘 것.
실행:  python scripts/record_orchestration.py [최대선박수]
"""
import datetime
import io
import json
import os
import sys
import urllib.error
import urllib.request

# 윈도우 콘솔 기본 인코딩(CP949)에서 한글/기호 출력이 깨지거나 죽는 것을 막는다
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP = os.path.join(BASE, "public", "snapshot", "snapshot.json")
BACKEND = "http://127.0.0.1:8001/api/v1"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 15


def get(path: str):
    with urllib.request.urlopen(BACKEND + path, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def post(path: str, body: dict):
    req = urllib.request.Request(
        BACKEND + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> None:
    vessels = get("/dashboard/vessels")
    cargos = get("/dashboard/berth-cargo")
    by_cs = {c["callsgn"]: c for c in cargos if c.get("callsgn")}

    # 화면(AgentConsole)이 종합 판정을 걸 수 있는 배와 같은 조건 —
    # 화물이 확인되고 흘수가 있는 배.
    targets = [
        v for v in vessels
        if v.get("callsgn") in by_cs and v.get("draught")
        and (by_cs[v["callsgn"]].get("cas_no") or by_cs[v["callsgn"]].get("chem_id"))
    ]

    # 승인 대기 중인 배를 앞으로 당긴다.
    #
    # 배포본에서 사용자가 실제로 판정을 여는 경로는 "배정현황 → 승인 대기 →
    # 협상 로그 →" 다. 그런데 targets 는 AIS 목록 순서라, 상한(LIMIT)에 걸리면
    # 정작 그 배들이 통째로 빠진다(2026-08-24 실측: 승인 대기 7척 중 녹화 0건 —
    # 배포본에서 전부 "판단 보류"로 보였다).
    #
    # 상한을 없애는 대신 순서를 바꾼다. 판정 1건마다 LLM 호출이 있어 상한 자체는
    # 필요하고, 화면이 지목하는 배가 먼저 담기면 상한이 남은 만큼만 잘린다.
    try:
        pending_cs = [p.get("call_sign") for p in get("/approvals/pending")]
    except Exception as exc:  # 승인 대기 조회 실패는 녹화를 막을 일이 아니다
        print(f"[경고] 승인 대기 조회 실패 - 기본 순서로 녹화합니다 ({exc})")
        pending_cs = []
    order = {cs: i for i, cs in enumerate(pending_cs) if cs}
    targets.sort(key=lambda v: order.get(v.get("callsgn"), len(order) + 1))
    if order:
        covered = sum(1 for v in targets[:LIMIT] if v.get("callsgn") in order)
        print(f"승인 대기 {len(order)}척 중 {covered}척을 우선 녹화합니다")

    now = datetime.datetime.now(datetime.timezone.utc)
    out, cands, seen = {}, {}, set()
    for v in targets:
        cs = v["callsgn"]
        if cs in seen or len(out) >= LIMIT:
            continue
        seen.add(cs)
        c = by_cs[cs]
        body = {
            # 콘솔이 보내는 것과 같은 모양 (useOnsanApi.orchestrate 참고).
            # dwt 는 실AIS 에 없어 콘솔도 null 을 보낸다.
            "vessel": {
                "draught_m": float(v["draught"]), "dwt_t": None,
                "name_hint": v.get("vessel_name"), "call_sign": cs,
            },
            "cargo": {"cas_no": c.get("cas_no"), "name_hint": c.get("cargo_name")},
            "window_start": now.isoformat().replace("+00:00", "Z"),
            "window_end": (now + datetime.timedelta(hours=8)).isoformat().replace("+00:00", "Z"),
        }
        try:
            out[cs] = post("/orchestrator/assess", body)
            print(f"[OK] {cs} {v.get('vessel_name')} -> {out[cs].get('overall_decision')}")
            # 선석 후보도 같은 자리에서 굳힌다 — 이쪽 키는 선명(name_hint)이라
            # 역시 브라우저 없이 재현할 수 있다(snapshotMode.js 참고).
            name = v.get("vessel_name")
            if name and name not in cands:
                cands[name] = post("/scheduling/candidates", {
                    "vessel": {"draught_m": float(v["draught"]), "name_hint": name},
                    "cargo": {"chem_id": c.get("chem_id"), "cas_no": c.get("cas_no"),
                              "name_hint": c.get("cargo_name")},
                    "window_start": now.isoformat().replace("+00:00", "Z"),
                    "window_end": (now + datetime.timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
                })
        except urllib.error.HTTPError as e:
            print(f"[실패] {cs}: HTTP {e.code} {e.read().decode('utf-8')[:120]}")
        except Exception as e:  # noqa: BLE001
            print(f"[실패] {cs}: {e}")

    if not out:
        sys.exit("녹화된 판정이 없습니다 - 백엔드가 떠 있는지 확인하세요")


    # 챗봇 추천 질문 4개 — 화면(AgentConsole.SUGGESTED)과 문구가 정확히 같아야
    # 배포본에서 그 버튼이 답을 찾는다. 바꿀 때 양쪽을 같이 바꿀 것.
    suggested = [
        "벤젠 취급 시 착용해야 할 보호구는?",
        "메탄올이 누출되면 어떻게 대처하나요?",
        "황산은 어떤 물질과 함께 두면 안 되나요?",
        "톨루엔 인화점이 몇 도인가요?",
    ]
    rag = {}
    for q in suggested:
        try:
            rag[q] = post("/rag/query", {"question": q})
            print(f"[OK] 챗봇: {q[:24]}...")
        except Exception as e:  # noqa: BLE001
            print(f"[챗봇 실패] {q[:20]}: {e}")

    with io.open(SNAP, encoding="utf-8") as f:
        snap = json.load(f)
    snap["/api/v1/orchestrator/assess"] = out
    if rag:
        snap["/api/v1/rag/query"] = rag
    # 브라우저 녹화분(record_agents.mjs)이 있으면 합치고, 없으면 새로 넣는다.
    if cands:
        merged = dict(snap.get("/api/v1/scheduling/candidates") or {})
        merged.update(cands)
        snap["/api/v1/scheduling/candidates"] = merged
    with io.open(SNAP, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False)

    size = os.path.getsize(SNAP)
    print(f"\n녹화 완료: 종합 판정 {len(out)}건 (대상 {len(targets)}척 중 상한 {LIMIT})")
    print(f"{SNAP} ({size:,} bytes)")
    print("녹화되지 않은 배는 배포본에서 판단 보류로 표시됩니다 (없는 판정을 지어내지 않음)")


if __name__ == "__main__":
    main()
