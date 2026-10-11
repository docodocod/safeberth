# -*- coding: utf-8 -*-
"""시연 전 캐시 워밍 — 첫 조회 지연(실측 58.7초)을 시연 전에 미리 치른다.

[왜 필요한가]
안전 에이전트는 MSDS 를 lazy-fetch 한다. 한 번도 조회한 적 없는 물질을
시연 중 처음 클릭하면 KOSHA API 수집 + LLM 근거 생성까지 1분 가까이 걸린다
(2026-08-04 실측: 에탄올 첫 조회 58.7s → 워밍 후 6~10s).
시연·영상 촬영(8/19) 직전에 이 스크립트를 한 번 돌리면 그 지연이 사라진다.

[무엇을 데우나]
  1) MSDS 상세  — 시나리오·위반 화물 전체 CAS
  2) 안전 판정  — 대시보드에서 선박 클릭 시 나가는 것과 동일한 페이로드 6건
  3) RAG 질의   — 질의응답 탭의 추천 질문 4건 (AgentConsole.SUGGESTED 와 동일)
  4) 기상 판정  — 선석군 전체

실행:  python warm_cache.py   (백엔드 8001 이 떠 있어야 한다)
"""
import json
import sys
import time
import urllib.request

# 한글 콘솔(cp949)에서 em-dash 같은 문자를 못 찍어 스크립트가 통째로 죽던 문제.
# 캐시 워밍은 시연 직전에 도는 스크립트라, 출력 한 줄 때문에 중단되면
# 첫 판정이 1분 가까이 걸리는 상태로 촬영에 들어가게 된다(2026-08-24 실측:
# [2/4] 단계 진입 직후 UnicodeEncodeError 로 종료).
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://localhost:8001/api/v1"

# 시나리오 6종 + 위반 시나리오 화물 (useOnsanApi.CARGO_CAS 와 동일 값)
CAS = {
    "에탄올": "64-17-5", "자일렌": "1330-20-7", "등유": "8008-20-6",
    "부타디엔": "106-99-0", "가솔린": "86290-81-5", "톨루엔": "108-88-3",
    "벤젠": "71-43-2", "메탄올": "67-56-1", "황산": "7664-93-9",
    "프로페인": "74-98-6", "원유": "8002-05-9", "LNG": "74-82-8",
}

# 대시보드 선박 클릭과 동일한 판정 페이로드 (ONSAN_ADJACENCY 기준 인접 배치)
CLICK_PAYLOADS = [
    ("에탄올", [("OTK 2부두", "부타디엔")]),
    ("부타디엔", [("OTK 1부두", "에탄올")]),
    ("자일렌", []),
    ("등유", [("S-Oil 2부두", "가솔린")]),
    ("가솔린", [("S-Oil 1부두", "등유")]),
    ("톨루엔", []),
]

# AgentConsole.SUGGESTED 와 동일해야 한다 — 추천 질문을 바꾸면 여기도 바꿀 것
SUGGESTED = [
    "벤젠 취급 시 착용해야 할 보호구는?",
    "메탄올이 누출되면 어떻게 대처하나요?",
    "황산은 어떤 물질과 함께 두면 안 되나요?",
    "톨루엔 인화점이 몇 도인가요?",
]

BERTH_GROUPS = [
    "OTK1/2부두(처용리)", "UTK부두(처용리)", "대한유화부두(처용리)",
    "정일1/2부두(산암리)", "효성부두(산암리)",
    "S-Oil1~4부두(산암리/원산리)", "한국석유공사원유부이",
]


def _call(method, path, body=None, timeout=300):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
        return time.time() - t0, None
    except Exception as e:  # 워밍은 실패해도 계속 — 남은 항목이라도 데운다
        return time.time() - t0, str(e)[:80]


# 안전 지수는 콜드 10초 걸린다(2026-08-25 실측). 시연 중 '불러오는 중…'이
# 화면에 남지 않도록 여기서 미리 계산시킨다.
EXTRA_GETS = ["/api/v1/dashboard/safety-index", "/api/v1/dashboard/alerts"]


def main():
    for p in EXTRA_GETS:
        try:
            t0 = time.time(); get(p); print(f"  {p} {time.time()-t0:.1f}s OK")
        except Exception as e:
            print(f"  {p} 실패: {e}")

    total_err = 0
    print("=" * 60)
    print("시연 캐시 워밍 시작 (백엔드 8001)")
    print("=" * 60)

    print("\n[1/4] MSDS 상세 (%d종)" % len(CAS))
    for name, cas in CAS.items():
        dt, err = _call("GET", f"/msds/{cas}")
        mark = "OK" if err is None else f"실패: {err}"
        total_err += 0 if err is None else 1
        print(f"  {name:6s} {dt:5.1f}s  {mark}")

    print("\n[2/4] 안전 판정 — 선박 클릭 페이로드 (%d건)" % len(CLICK_PAYLOADS))
    for cargo, adj in CLICK_PAYLOADS:
        body = {
            "target_cargo": {"cas_no": CAS[cargo], "name_hint": cargo},
            "adjacent_cargos": [
                {"berth_name": b, "cargo": {"cas_no": CAS[c], "name_hint": c}}
                for b, c in adj
            ],
        }
        dt, err = _call("POST", "/safety/assess", body)
        mark = "OK" if err is None else f"실패: {err}"
        total_err += 0 if err is None else 1
        print(f"  {cargo:6s} {dt:5.1f}s  {mark}")

    print("\n[3/4] RAG 질의 — 추천 질문 (%d건)" % len(SUGGESTED))
    for q in SUGGESTED:
        dt, err = _call("POST", "/rag/query", {"question": q})
        mark = "OK" if err is None else f"실패: {err}"
        total_err += 0 if err is None else 1
        print(f"  {q[:18]:18s} {dt:5.1f}s  {mark}")

    print("\n[4/4] 기상 판정 — 선석군 (%d곳)" % len(BERTH_GROUPS))
    for g in BERTH_GROUPS:
        dt, err = _call("POST", "/weather/assess",
                        {"berth_group": g, "precip_observed": False,
                         "extra_condition_active": False})
        mark = "OK" if err is None else f"실패: {err}"
        total_err += 0 if err is None else 1
        print(f"  {g[:16]:16s} {dt:5.1f}s  {mark}")

    print("\n" + "=" * 60)
    if total_err == 0:
        print("워밍 완료 — 모든 항목 성공. 시연 시작해도 됩니다.")
    else:
        print(f"워밍 완료 — 실패 {total_err}건. 위 목록에서 '실패' 항목을 확인하세요.")
    print("=" * 60)


if __name__ == "__main__":
    main()
