# -*- coding: utf-8 -*-
"""GET /api/dashboard 서버 — 두 트윈(React·Omniverse)의 공용 데이터 소스.

실수집 DB(smartport-postgres-dev, localhost:5433)가 켜져 있으면 실데이터를,
꺼져 있으면 mock 을 응답한다. 응답의 data_source 필드로 어느 쪽인지 표시.

  실데이터 사용 항목
  - weather      : mart.weather_now (기상청·조위·파고 실관측, 이영서 mart 뷰)
  - operations 중 접안 이력 : upa_port_call 온산 시설 실제 입출항 기록
  - stats        : 입출항 11,275건 등 수집 규모 통계
  mock 유지 항목
  - vessels      : 온산 데모 배치 (실 AIS 는 수집 시점 스냅샷이라 정적)
  - 진행 중 하역 작업 : 실시간 유량 센서 미수집 → 서버 시계 기반 mock 진행률

백엔드(FastAPI)가 완성되면 이 서버를 끄기만 하면 된다 (동일 계약).
실행: python dashboard_server.py  (포트 8000)
"""
import calendar
import json
import math
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import psycopg2
    HAS_PG = True
except ImportError:
    HAS_PG = False

START = time.time()
# 컨테이너에서는 .env 파일 대신 환경변수로 주입한다 (SMARTPORT_ENV_PATH 로 경로 변경 가능)
ENV_PATH = os.getenv(
    "SMARTPORT_ENV_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", ".env"),
)

_env_cache = None


def db_config():
    global _env_cache
    if _env_cache is None:
        env = {}
        try:
            with open(ENV_PATH, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if "=" in line and not line.startswith("#"):
                        k, v = line.split("=", 1)
                        env[k] = v
        except OSError:
            pass
        # 파일에 없는 값은 환경변수에서 채운다 (컨테이너는 .env 파일이 없다)
        for k in ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"):
            if not env.get(k) and os.getenv(k):
                env[k] = os.environ[k]
        _env_cache = env
    e = _env_cache
    if not e.get("POSTGRES_DB"):
        return None
    # 컨테이너 배포에서는 DB 가 다른 호스트에 있다 (로컬 실행은 기존 값 그대로).
    return dict(host=os.getenv("PGHOST", "localhost"),
                port=int(os.getenv("PGPORT", "5433")),
                dbname=e["POSTGRES_DB"],
                user=e["POSTGRES_USER"], password=e["POSTGRES_PASSWORD"], connect_timeout=2)


# ─── mock 선박 (온산 데모 배치 — 지도/트윈 움직임용) ───
VESSELS = [
    {"port_call_id": "D7ABC_2026_001", "callsgn": "D7ABC", "vessel_name": "HMM GOODWILL",
     "mmsi": 440559000, "is_liquid_cargo_vessel": True, "latitude": 35.45661, "longitude": 129.35119,
     "sog": 0.1, "nav_status_category": "MOORED", "arrival_at_utc": "2026-07-18T22:40:00Z",
     "cargo": {"name": "에탄올", "un_no": "UN1170"}, "berth": "OTK 1부두"},
    {"port_call_id": "D8XYZ_2026_014", "callsgn": "D8XYZ", "vessel_name": "WOOYANG CHEMI",
     "mmsi": 440112000, "is_liquid_cargo_vessel": True, "latitude": 35.43778, "longitude": 129.36694,
     "sog": 0.0, "nav_status_category": "MOORED", "arrival_at_utc": "2026-07-19T01:10:00Z",
     "cargo": {"name": "자일렌", "un_no": "UN1307"}, "berth": "정일 1부두"},
    {"port_call_id": "V7GAS_2026_007", "callsgn": "V7GAS", "vessel_name": "GAS UTOPIA",
     "mmsi": 538007123, "is_liquid_cargo_vessel": True, "latitude": 35.4250, "longitude": 129.3900,
     "sog": 11.4, "nav_status_category": "UNDER_WAY", "arrival_at_utc": "2026-07-24T09:30:00Z",
     "cargo": {"name": "부타디엔", "un_no": "UN1010"}, "berth": "OTK 2부두"},
    {"port_call_id": "SUNVN_2026_003", "callsgn": "3FQP8", "vessel_name": "SUN VENUS",
     "mmsi": 371234000, "is_liquid_cargo_vessel": True, "latitude": 35.4280, "longitude": 129.4050,
     "sog": 0.2, "nav_status_category": "AT_ANCHOR", "arrival_at_utc": "2026-07-23T15:00:00Z",
     "cargo": {"name": "톨루엔", "un_no": "UN1294"}, "berth": None, "anchorage": "E2"},
    {"port_call_id": "ULPIO_2026_021", "callsgn": "D9PIO", "vessel_name": "ULSAN PIONEER",
     "mmsi": 440778000, "is_liquid_cargo_vessel": True, "latitude": 35.4320, "longitude": 129.3780,
     "sog": 8.6, "nav_status_category": "UNDER_WAY", "arrival_at_utc": "2026-07-22T20:00:00Z",
     "cargo": {"name": "가솔린", "un_no": "UN1203"}, "berth": "S-Oil 2부두"},
    {"port_call_id": "PGLRY_2026_009", "callsgn": "9VPG7", "vessel_name": "PACIFIC GLORY",
     "mmsi": 563556000, "is_liquid_cargo_vessel": True, "latitude": 35.45100, "longitude": 129.35600,
     "sog": 0.0, "nav_status_category": "MOORED", "arrival_at_utc": "2026-07-23T06:20:00Z",
     "cargo": {"name": "등유", "un_no": "UN1223"}, "berth": "S-Oil 1부두"},
    {"port_call_id": "KRSTU_2026_030", "callsgn": "9WKR3", "vessel_name": "KOTA RESTU",
     "mmsi": 533445000, "is_liquid_cargo_vessel": False, "latitude": 35.31, "longitude": 129.48,
     "sog": 13.8, "nav_status_category": "UNDER_WAY", "arrival_at_utc": "2026-07-24T11:00:00Z",
     "cargo": None},
    {"port_call_id": "SVSTR_2026_012", "callsgn": "HLSV2", "vessel_name": "SILVER STAR",
     "mmsi": 440334000, "is_liquid_cargo_vessel": False, "latitude": 35.40, "longitude": 129.47,
     "sog": 0.3, "nav_status_category": "AT_ANCHOR", "arrival_at_utc": "2026-07-23T10:45:00Z",
     "cargo": None},
]

MOCK_WEATHER = {
    "wind_speed_ms": 6.2, "wind_dir_deg": 335, "wave_height_sig_m": 0.8,
    "tide_level_cm": 120, "visibility_m": 19.8, "observed_at_utc": "2026-07-24T02:00:00Z",
}

ALERTS = [
    {"level": "DANGER", "type": "SEGREGATION",
     "message": "OTK 1부두: 메탄올-황산 혼재금지 (IMDG 격리 위반)",
     "port_call_id": "D7ABC_2026_001", "created_at_utc": "2026-07-24T01:55:00Z"},
    {"level": "WARNING", "type": "WEATHER",
     "message": "풍속 상승 추세 (현재 6.2m/s, 임계 14m/s)",
     "port_call_id": None, "created_at_utc": "2026-07-24T02:00:00Z"},
]

# ─── 진행 중 하역 작업 (mock — 실시간 유량 센서 미수집) ───
# begin_off/duration: 서버 기동 시각 기준 (시간). 진행률은 요청 시점 계산.
MOCK_JOBS = [
    {"job_id": "OP-2026-101", "vessel_name": "HMM GOODWILL", "berth": "OTK 1부두",
     "cargo": "에탄올", "un_no": "UN1170", "planned_tons": 12000, "begin_off": -3.0, "duration_h": 8.0},
    {"job_id": "OP-2026-102", "vessel_name": "WOOYANG CHEMI", "berth": "정일 1부두",
     "cargo": "자일렌", "un_no": "UN1307", "planned_tons": 7500, "begin_off": -1.5, "duration_h": 6.0},
    {"job_id": "OP-2026-103", "vessel_name": "PACIFIC GLORY", "berth": "S-Oil 1부두",
     "cargo": "등유", "un_no": "UN1223", "planned_tons": 9800, "begin_off": 2.0, "duration_h": 7.0},
]

# ─────────────────────────────────────────────
# 시나리오 배역 — "실제로 온산에 떠 있는 배"에 화물·선석을 부여한다.
#
# 왜: 지도의 실 AIS 선박과 시나리오 선박이 따로 놀면 실시간 연동의 의미가 없다.
#     선박명·호출부호·MMSI·위치·속력은 실측(upa_vessel_position)을 그대로 쓰고,
#     화물(UN번호)·선석·하역작업만 가정값으로 얹는다.
#     → 화물은 upa_cargo_manifest(업체코드 필수)를 못 받아 아직 실데이터가 없기 때문.
#        manifest 확보 시 cargo_source 만 REAL 로 바뀌면 된다.
#
# need: MOORED(계류) | ANCHOR(정박대기) | UNDERWAY(항해중) — 실선박 상태로 매칭
SCENARIO = [
    {"need": "MOORED", "cargo": {"name": "에탄올", "un_no": "UN1170"}, "berth": "OTK 1부두",
     "job": {"planned_tons": 12000, "begin_off": -3.0, "duration_h": 8.0}},
    {"need": "MOORED", "cargo": {"name": "자일렌", "un_no": "UN1307"}, "berth": "정일 1부두",
     "job": {"planned_tons": 7500, "begin_off": -1.5, "duration_h": 6.0}},
    {"need": "MOORED", "cargo": {"name": "등유", "un_no": "UN1223"}, "berth": "S-Oil 1부두",
     "job": {"planned_tons": 9800, "begin_off": 2.0, "duration_h": 7.0}},
    {"need": "UNDERWAY", "cargo": {"name": "부타디엔", "un_no": "UN1010"}, "berth": "OTK 2부두"},
    {"need": "UNDERWAY", "cargo": {"name": "가솔린", "un_no": "UN1203"}, "berth": "S-Oil 2부두"},
    {"need": "ANCHOR", "cargo": {"name": "톨루엔", "un_no": "UN1294"}, "berth": None,
     "anchorage": "E2"},
]

# 온산항 일대 (선박 후보 추출 범위)
ONSAN_BOX = (35.39, 35.50, 129.29, 129.44)   # lat_min, lat_max, lon_min, lon_max

# 선석 실측 좌표 (frontend/src/utils/geoUtils.js ONSAN_BERTHS 와 동일)
BERTH_POS = {
    "OTK 1부두": (35.45661, 129.35119),
    "정일 1부두": (35.43778, 129.36694),
    "S-Oil 1부두": (35.45100, 129.35600),
}
ANCHOR_POS = (35.428, 129.405)      # E2 묘박지 근사 위치

# 선종 데이터(ship_type)가 전 행 결측이라 흘수로 대형 상선을 근사 식별한다.
# 6 m 이상이면 도선선·예선·관공선 등 소형 서비스선은 사실상 배제된다.
MIN_DRAUGHT_M = 6.0
SERVICE_CRAFT = ("PILOT", "TUG", "도선", "예선", "예인", "방제", "해경", "경비", "소방", "항무")


def _dist_km(a_lat, a_lon, b_lat, b_lon):
    """짧은 거리용 평면 근사 (온산 위도에서 오차 무시 가능)."""
    dy = (a_lat - b_lat) * 111.0
    dx = (a_lon - b_lon) * 111.0 * math.cos(math.radians(a_lat))
    return math.hypot(dx, dy)


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def jobs_for(vessels):
    """하역 작업을 '지도에 뜬 그 선박' 기준으로 생성.

    시나리오 배역 중 job 정의가 있는 것만 작업으로 만든다. 선박명·선석이
    지도 마커와 동일해야 Gantt·CCTV·상세패널이 같은 배를 가리킨다.
    """
    if not vessels or vessels[0].get("position_source") != "REAL_AIS":
        return mock_jobs_now()
    now, out = time.time(), []
    for i, role in enumerate(SCENARIO):
        j = role.get("job")
        if not j or i >= len(vessels):
            continue
        v = vessels[i]
        begin = START + j["begin_off"] * 3600
        end = begin + j["duration_h"] * 3600
        progress = max(0.0, min(1.0, (now - begin) / (end - begin)))
        status = "PLANNED" if now < begin else ("COMPLETED" if now >= end else "IN_PROGRESS")
        out.append({
            "job_id": "OP-2026-%d" % (101 + i),
            "vessel_name": v["vessel_name"], "berth": role.get("berth"),
            "cargo": role["cargo"]["name"], "un_no": role["cargo"]["un_no"],
            "planned_tons": j["planned_tons"],
            "done_tons": round(j["planned_tons"] * progress),
            "progress_pct": round(progress * 100, 1),
            "status": status,
            "begin_utc": iso(begin), "end_utc": iso(end),
            "is_real_record": False,
        })
    return out


def mock_jobs_now():
    now = time.time()
    out = []
    for j in MOCK_JOBS:
        begin = START + j["begin_off"] * 3600
        end = begin + j["duration_h"] * 3600
        progress = max(0.0, min(1.0, (now - begin) / (end - begin)))
        status = "PLANNED" if now < begin else ("COMPLETED" if now >= end else "IN_PROGRESS")
        out.append({
            "job_id": j["job_id"], "vessel_name": j["vessel_name"], "berth": j["berth"],
            "cargo": j["cargo"], "un_no": j["un_no"],
            "planned_tons": j["planned_tons"],
            "done_tons": round(j["planned_tons"] * progress),
            "progress_pct": round(progress * 100, 1),
            "status": status,
            "begin_utc": iso(begin), "end_utc": iso(end),
            "is_real_record": False,
        })
    return out


def fetch_real():
    """DB 에서 실데이터 조회. 실패 시 예외."""
    cfg = db_config()
    if not (HAS_PG and cfg):
        raise RuntimeError("db unavailable")
    conn = psycopg2.connect(**cfg)
    try:
        cur = conn.cursor()

        # 실관측 기상 (mart.weather_now — 이영서 mart 뷰)
        cur.execute("""SELECT wind_speed_ms, wind_dir_deg, wave_height_sig_m,
                              tide_level_cm, visibility_m, weather_observed_at_utc
                       FROM mart.weather_now""")
        w = cur.fetchone()
        weather = None
        if w and w[0] is not None:
            weather = {
                "wind_speed_ms": float(w[0]), "wind_dir_deg": int(w[1]),
                "wave_height_sig_m": float(w[2]) if w[2] is not None else None,
                "tide_level_cm": float(w[3]) if w[3] is not None else None,
                "visibility_m": float(w[4]) if w[4] is not None else None,
                "observed_at_utc": w[5].strftime("%Y-%m-%dT%H:%M:%SZ") if w[5] else None,
            }

        # 온산 선석 실제 접안 이력 (upa_port_call)
        cur.execute("""
            SELECT COALESCE(NULLIF(vessel_name, ''), NULLIF(vessel_name_en, ''), '(선명 미상)'),
                   facility_name, arrival_at_utc, departure_at_utc
            FROM upa_port_call
            WHERE (facility_name LIKE %s OR facility_name LIKE %s OR facility_name LIKE %s)
              AND arrival_at_utc IS NOT NULL AND departure_at_utc IS NOT NULL
              AND departure_at_utc > arrival_at_utc
            ORDER BY departure_at_utc DESC LIMIT 7
        """, ("%온산%", "%정일%", "%OTK%"))
        history = []
        for i, (vn, fac, arr, dep) in enumerate(cur.fetchall()):
            history.append({
                "job_id": f"REAL-{i}", "vessel_name": vn, "berth": fac,
                "cargo": None, "un_no": None, "planned_tons": None, "done_tons": None,
                "progress_pct": 100.0, "status": "COMPLETED",
                "begin_utc": arr.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end_utc": dep.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "is_real_record": True,
            })

        # 액체화물선 호출부호 (PORT-MIS 공식 선종코드 기준) — 지도 AIS 레이어 강조용
        cur.execute("""SELECT DISTINCT callsgn FROM portmis_vessel
                       WHERE is_liquid_cargo_vessel AND callsgn IS NOT NULL""")
        liquid_callsgns = [r[0] for r in cur.fetchall()]

        # 수집 규모 통계
        cur.execute("SELECT COUNT(*) FROM upa_port_call")
        total_calls = cur.fetchone()[0]
        cur.execute("""SELECT COUNT(*) FROM upa_port_call
                       WHERE facility_name LIKE %s OR facility_name LIKE %s OR facility_name LIKE %s""",
                    ("%온산%", "%정일%", "%OTK%"))
        onsan_calls = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM ais_vessel_position")
        ais_rows = cur.fetchone()[0]
        stats = {"total_port_calls": total_calls, "onsan_port_calls": onsan_calls,
                 "ais_position_rows": ais_rows, "liquid_callsgns": liquid_callsgns}

        # 데이터 신선도 (mart.pipeline_health — 이영서 수집기 생존 신호)
        # "수집기가 죽었는가"와 "원천(공공데이터포털)이 멈췄는가"를 구분한다.
        # 2026-08-04 실증: 포털 무응답 8.8일간 수집기는 OK, 원천만 정지 —
        # 이 구분 없이는 시연 중 "왜 배가 안 움직이죠?"에 답할 수 없다.
        try:
            cur.execute("""SELECT pipeline_state, collect_age_min, source_age_min,
                                  last_source_at_utc
                           FROM mart.pipeline_health""")
            ph = cur.fetchone()
            if ph:
                stats["pipeline_health"] = {
                    "state": ph[0],
                    "collect_age_min": int(ph[1]) if ph[1] is not None else None,
                    "source_age_min": int(ph[2]) if ph[2] is not None else None,
                    "last_source_at_utc": ph[3].strftime("%Y-%m-%dT%H:%M:%SZ") if ph[3] else None,
                }
        except Exception:
            conn.rollback()  # 뷰가 아직 없는 환경(구 DB)에서도 나머지 응답은 유지

        alerts = real_alerts(cur, conn, stats.get("pipeline_health"), weather)

        return weather, history, stats, alerts
    finally:
        conn.close()


def real_alerts(cur, conn, health, weather):
    """실데이터에서 경고를 만든다 (하드코딩 경고 대체).

    원칙: **여기서 새로 판정하지 않는다.** 이미 다른 곳이 내린 결론(mart 뷰의
    draught_verdict, pipeline_health)과 관측 시각만 읽어서 문장으로 옮긴다.
    혼재금지(IMDG) 판정은 백엔드 안전 에이전트가 유일한 권위이므로, 여기서는
    "같은 부두에 등급이 다른 위험물이 함께 있다"는 사실만 알리고 판정은 하지 않는다.
    위험이 없으면 빈 목록이 정상이다 (없는 경고를 지어내지 않는다).
    """
    out = []
    try:
        cur.execute("""SELECT callsgn, facility_name, ukc_m, draught_verdict
                       FROM mart.berth_draught_check
                       WHERE draught_verdict IN ('NOT_ALLOWED', 'MARGINAL')
                       ORDER BY ukc_m NULLS LAST LIMIT 5""")
        for callsgn, facility, ukc, verdict in cur.fetchall():
            danger = verdict == "NOT_ALLOWED"
            ukc_txt = f"UKC {ukc:.2f} m" if ukc is not None else "UKC 산출 불가"
            out.append({
                "level": "DANGER" if danger else "WARNING",
                "type": "DRAUGHT",
                "message": f"{facility or '부두 미상'}: {callsgn} 흘수 여유 부족 "
                           f"({ukc_txt}, {verdict})",
                "port_call_id": None,
                "created_at_utc": _utc_now(),
            })
    except Exception:
        conn.rollback()

    try:
        cur.execute("""SELECT facility_name, count(DISTINCT imdg_class)
                       FROM mart.berth_current_cargo
                       WHERE imdg_class IS NOT NULL AND facility_name IS NOT NULL
                       GROUP BY facility_name HAVING count(DISTINCT imdg_class) > 1
                       ORDER BY 2 DESC LIMIT 3""")
        for facility, n in cur.fetchall():
            out.append({
                "level": "WARNING",
                "type": "SEGREGATION",
                "message": f"{facility}: IMDG 등급 {n}종 동시 재항 — 혼재 판정 확인 필요",
                "port_call_id": None,
                "created_at_utc": _utc_now(),
            })
    except Exception:
        conn.rollback()

    # 수집 상태·관측 노후는 화면 신뢰도에 직결되므로 경고로 올린다
    if health and health.get("state") and health["state"] != "OK":
        out.append({
            "level": "WARNING", "type": "PIPELINE",
            "message": f"데이터 수집 상태: {health['state']} "
                       f"(수집 {health.get('collect_age_min')}분 전)",
            "port_call_id": None, "created_at_utc": _utc_now(),
        })
    if weather and weather.get("observed_at_utc"):
        age_h = (time.time() - _epoch(weather["observed_at_utc"])) / 3600
        if age_h > 3:
            out.append({
                "level": "WARNING", "type": "WEATHER",
                "message": f"기상 관측값이 {age_h:.0f}시간 전 값입니다 "
                           f"(원천 관측소 결측 — 판정 시 참고)",
                "port_call_id": None, "created_at_utc": _utc_now(),
            })
    return out


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _epoch(iso_utc):
    return calendar.timegm(time.strptime(iso_utc, "%Y-%m-%dT%H:%M:%SZ"))


def fetch_onsan_vessels():
    """온산 일대 실선박의 최신 위치 1건씩 (upa_vessel_position). 실패 시 예외."""
    cfg = db_config()
    if not (HAS_PG and cfg):
        raise RuntimeError("db unavailable")
    conn = psycopg2.connect(**cfg)
    try:
        cur = conn.cursor()
        # 주의: 박스 필터를 DISTINCT 보다 먼저 걸면 "온산에 있었을 때의 옛 위치"가
        # 최신으로 뽑혀 실 AIS 레이어와 좌표가 어긋난다. 반드시 선박별 최신 1건을
        # 먼저 고른 뒤 현재 온산에 있는 배만 남긴다.
        # PORT-MIS 선종코드(공식 51종 표)로 액체화물선 여부를 확정 조인한다.
        # AIS ship_type 이 전 행 결측이라 예전엔 흘수로만 추정했는데, 이제
        # 실제 선종 정보가 있으면 그걸 우선 쓴다(2026-07-26 이영서 코드표 반영).
        cur.execute("""
            SELECT latest.*, pm.is_liquid, pm.ship_kind
            FROM (
                SELECT DISTINCT ON (callsgn)
                       callsgn, vessel_name, mmsi, latitude, longitude,
                       sog, cog, heading, draught, received_at_utc
                FROM upa_vessel_position
                WHERE callsgn IS NOT NULL AND callsgn NOT IN ('', '0', '0000')
                  AND vessel_name IS NOT NULL AND vessel_name <> ''
                  AND latitude IS NOT NULL AND longitude IS NOT NULL
                  AND draught >= %s
                ORDER BY callsgn, received_at_utc DESC
            ) latest
            LEFT JOIN (
                SELECT callsgn,
                       bool_or(is_liquid_cargo_vessel) AS is_liquid,
                       min(ship_kind_nm)               AS ship_kind
                FROM portmis_vessel
                WHERE callsgn IS NOT NULL
                GROUP BY callsgn
            ) pm ON pm.callsgn = latest.callsgn
            WHERE latitude BETWEEN %s AND %s AND longitude BETWEEN %s AND %s
        """, (MIN_DRAUGHT_M,) + ONSAN_BOX)
        rows = cur.fetchall()
    finally:
        conn.close()

    out = []
    for cs, name, mmsi, lat, lon, sog, cog, hdg, drft, rec, is_liquid, ship_kind in rows:
        up = (name or "").upper()
        if any(k in up for k in SERVICE_CRAFT):
            continue                      # 도선선·예선 등 서비스선 제외
        sog, lat, lon = float(sog or 0), float(lat), float(lon)
        near_berth = min(_dist_km(lat, lon, *p) for p in BERTH_POS.values())
        out.append({
            "callsgn": cs, "vessel_name": name, "mmsi": int(mmsi) if mmsi else None,
            "latitude": lat, "longitude": lon, "sog": sog,
            "vessel_heading": int(hdg or cog or 0), "draught_m": float(drft or 0),
            "is_liquid": bool(is_liquid), "ship_kind": ship_kind,
            "received_at_utc": rec.strftime("%Y-%m-%dT%H:%M:%SZ") if rec else None,
            # 정지(<0.5kn) 상태에서 선석에 붙어 있으면 계류, 멀리 있으면 묘박 대기로 본다.
            "_state": ("UNDERWAY" if sog >= 1.5 else
                       ("MOORED" if near_berth <= 1.5 else "ANCHOR")),
            "_near_berth_km": near_berth,
        })
    out.sort(key=lambda v: v["callsgn"])   # 매번 같은 배가 뽑히도록 결정적 정렬
    return out


# 배역 배정은 한 번 정하면 유지한다(폴링마다 배가 바뀌면 시연이 어지럽다).
# 위치·속력은 매 갱신 시 실측으로 다시 채운다.
_cast = {"t": 0.0, "map": None}          # map: scenario index -> callsgn


def scenario_vessels():
    """실선박에 시나리오(화물·선석)를 얹어 반환. DB 불가 시 None."""
    try:
        pool = fetch_onsan_vessels()
    except Exception:
        return None
    if len(pool) < len(SCENARIO):
        return None

    by_cs = {v["callsgn"]: v for v in pool}
    # 30분마다(또는 배정된 배가 사라지면) 재배정
    stale = time.time() - _cast["t"] > 1800
    if _cast["map"] is None or stale or any(cs not in by_cs for cs in _cast["map"].values()):
        used, mapping = set(), {}
        for i, role in enumerate(SCENARIO):
            cand = [v for v in pool if v["_state"] == role["need"] and v["callsgn"] not in used]
            if not cand:   # 해당 상태의 배가 없으면 아무 배나 (상태는 실측값 그대로 표시)
                cand = [v for v in pool if v["callsgn"] not in used]
            if not cand:
                return None
            # PORT-MIS 선종으로 액체화물선이 확인된 배가 있으면 그쪽을 우선한다
            # (화물 시나리오를 얹는 배이므로 실제 탱커일수록 자연스럽다)
            liquid = [v for v in cand if v.get("is_liquid")]
            if liquid:
                cand = liquid
            # 계류 역할은 '그 선석에 가장 가까운 배', 묘박 대기는 '선석에서 가장 먼 배'를
            # 골라 지도상 배치가 이야기와 어긋나지 않게 한다.
            target = BERTH_POS.get(role.get("berth") or "")
            if role["need"] == "MOORED" and target:
                pick = min(cand, key=lambda v: _dist_km(v["latitude"], v["longitude"], *target))
            elif role["need"] == "ANCHOR":
                pick = max(cand, key=lambda v: v["_near_berth_km"])
            else:
                pick = cand[i % len(cand)]
            used.add(pick["callsgn"])
            mapping[i] = pick["callsgn"]
        _cast["map"], _cast["t"] = mapping, time.time()

    out = []
    for i, role in enumerate(SCENARIO):
        v = by_cs[_cast["map"][i]]
        state = v["_state"]
        out.append({
            "port_call_id": "%s_2026_S%d" % (v["callsgn"], i + 1),
            "callsgn": v["callsgn"], "vessel_name": v["vessel_name"], "mmsi": v["mmsi"],
            "latitude": v["latitude"], "longitude": v["longitude"],
            "sog": v["sog"], "vessel_heading": v["vessel_heading"],
            "nav_status_category": {"MOORED": "MOORED", "ANCHOR": "AT_ANCHOR"}.get(state, "UNDER_WAY"),
            "arrival_at_utc": v["received_at_utc"],
            "is_liquid_cargo_vessel": True,
            # 선종 출처 구분: PORT-MIS 실선종 확인분인지, 흘수 추정분인지
            "ship_kind": v.get("ship_kind"),
            "vessel_type_source": "PORT-MIS 실선종" if v.get("is_liquid") else "흘수 추정",
            "cargo": role["cargo"],
            "berth": role.get("berth"),
            "anchorage": role.get("anchorage"),
            # 출처 표기 — 화면에서 '가정' 배지로 노출
            "position_source": "REAL_AIS",
            "cargo_source": "ASSUMED",
        })
    return out


def current_vessels():
    """실선박 기반 시나리오 우선, DB 불가 시 기존 데모 배치로 폴백."""
    real = scenario_vessels()
    if real:
        return real
    t = time.time() - START
    u = (t % 1500.0) / 1500.0
    out = []
    for v in VESSELS:
        v2 = dict(v)
        v2["position_source"] = "DEMO"
        v2["cargo_source"] = "DEMO"
        if v["nav_status_category"] == "UNDER_WAY":
            v2["latitude"] = round(v["latitude"] + (35.452 - v["latitude"]) * u, 5)
            v2["longitude"] = round(v["longitude"] + (129.360 - v["longitude"]) * u, 5)
        out.append(v2)
    return out


_cache = {"t": 0.0, "payload": None}


def build_payload():
    if time.time() - _cache["t"] < 10 and _cache["payload"]:
        # 진행률·선박 위치는 캐시와 무관하게 갱신
        p = dict(_cache["payload"])
        p["vessels"] = current_vessels()
        p["operations"] = jobs_for(p["vessels"]) + p.get("history_ops", [])
        return p
    weather, history, stats, src = None, [], None, {"weather": "MOCK", "history": "NONE",
                                                    "stats": "NONE", "alerts": "MOCK"}
    alerts = None
    try:
        weather, history, stats, alerts = fetch_real()
        src = {"weather": "REAL" if weather else "MOCK",
               "history": "REAL" if history else "NONE",
               "stats": "REAL" if stats else "NONE",
               # 실경고가 0건인 것과 DB 를 못 읽은 것은 다르다 — 0건도 REAL 이다
               "alerts": "REAL" if alerts is not None else "MOCK"}
    except Exception:
        pass
    payload = {
        "weather": weather or MOCK_WEATHER,
        "alerts": ALERTS if alerts is None else alerts,
        "stats": stats,
        "data_source": src,
        "history_ops": history,
        # 지도 AIS 레이어에서 액체화물선을 붉게 강조하기 위한 호출부호 목록
        "liquid_callsgns": (stats or {}).get("liquid_callsgns", []),
    }
    _cache["t"] = time.time()
    _cache["payload"] = payload
    p = dict(payload)
    p["vessels"] = current_vessels()
    p["operations"] = jobs_for(p["vessels"]) + history
    src["vessels"] = "REAL_AIS+가정화물" if p["vessels"] and p["vessels"][0].get(
        "position_source") == "REAL_AIS" else "DEMO"
    return p


# ─────────────────────────────────────────────
# 물리 시뮬레이션 준정적 근사식 (8월 시나리오 S1·S2)
# 상수·수식은 digital-twin/physics/mooring_berthing_sim.py 의 PhysX
# 동역학 검증 스크립트와 동일 — 그쪽 결과로 이 근사식을 검증한다.
# 시나리오 입력=실측(풍속·파고·DWT), 물리 상수=공개 문헌(OCIMF 계열) 근사.
# ─────────────────────────────────────────────
def _vessel_particulars(dwt):
    loa = 8.6 * dwt ** 0.316
    freeboard = 0.02 * loa + 3.0
    return dict(loa=loa, area=0.75 * loa * (freeboard + 4.0), mass=dwt * 1000 * 1.35)


def _line_mbl_kn(dwt):
    return 392.0 if dwt < 20000 else (588.0 if dwt < 60000 else 784.0)


def sim_mooring(dwt, wind_ms, wave_m):
    p = _vessel_particulars(dwt)
    force = 0.5 * 1.225 * 1.0 * p["area"] * wind_ms ** 2
    eff = 2 * 0.9 + 4 * 0.25            # 계류삭 6가닥 횡하중 유효 분담
    daf = 1.0 + 0.35 * wave_m           # 파랑 동적증폭
    t_line_kn = force * daf / eff / 1000
    mbl = _line_mbl_kn(dwt)
    pct = t_line_kn / mbl * 100
    if pct < 30:
        verdict, action = "정상", "하역 계속 가능"
    elif pct < 50:
        verdict, action = "주의", "하역 중단 검토 (라인 텐딩 강화)"
    elif pct < 70:
        verdict, action = "경고", "이안 준비 권고"
    else:
        verdict, action = "위험", "즉시 호스분리·비상 이안"
    # 정상 한계 풍속 (장력 30% 도달 풍속 역산) [m/s]
    safe_wind = math.sqrt(0.30 * mbl * 1000 * eff /
                          (0.5 * 1.225 * p["area"] * daf))
    return {
        "line_tension_kn": round(t_line_kn, 1), "mbl_kn": mbl,
        "tension_pct": round(pct, 1), "verdict": verdict, "action": action,
        "safe_wind_limit_ms": round(safe_wind, 1),
        "model": "준정적 근사 (OCIMF 계열) — PhysX 검증 스크립트와 동일 상수",
    }


def sim_berthing(dwt, speed_ms):
    p = _vessel_particulars(dwt)
    energy_kj = 0.5 * 1.8 * p["mass"] * speed_ms ** 2 / 1000
    # 콘 펜더 정격 흡수에너지 근사: 2만 DWT급 ≈ 500 kJ 스케일
    cap_kj = 0.5 * dwt ** 0.7
    ratio = energy_kj / cap_kj * 100
    safe_v = math.sqrt(2 * cap_kj * 1000 / (1.8 * p["mass"]))
    verdict = "안전" if ratio < 60 else ("주의" if ratio < 100 else "펜더 용량 초과")
    return {
        "berthing_energy_kj": round(energy_kj, 1), "fender_capacity_kj": round(cap_kj, 1),
        "ratio_pct": round(ratio, 1), "safe_speed_ms": round(safe_v, 2),
        "safe_speed_kn": round(safe_v * 1.944, 2), "verdict": verdict,
        "model": "berthing energy 근사 (Cm=1.8)",
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/dashboard"):
            p = build_payload()
            p.pop("history_ops", None)
            self._send(200, p)
        else:
            self._send(404, {"detail": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"detail": "invalid json"})
            return

        if self.path.startswith("/api/v1/sim/mooring"):
            self._send(200, sim_mooring(
                float(body.get("dwt", 20000)),
                float(body.get("wind_speed", 10)),
                float(body.get("wave_height", 0.5)),
            ))
        elif self.path.startswith("/api/v1/sim/berthing"):
            self._send(200, sim_berthing(
                float(body.get("dwt", 20000)),
                float(body.get("speed_ms", 0.15)),
            ))
        else:
            self._send(404, {"detail": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    # 로컬은 127.0.0.1 고정(외부 노출 없음). 컨테이너는 다른 컨테이너가 붙어야 하므로
    # BIND_HOST=0.0.0.0 으로 띄운다 — 인터넷 노출은 앞단 nginx 만 담당한다.
    host = os.getenv("BIND_HOST", "127.0.0.1")
    port = int(os.getenv("BIND_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"dashboard server: http://{host}:{port}/api/dashboard (실DB 연결 시 실데이터)")
    server.serve_forever()
