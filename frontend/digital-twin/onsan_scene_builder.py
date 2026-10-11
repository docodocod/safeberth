# -*- coding: utf-8 -*-
"""온산항 액체화물 부두 USD 장면 빌더 (frontend React 트윈과 동일한 실측 배치).

- 좌표계: 1 유닛 ≈ 2.2 m (1도 = 50000 유닛, 중심 35.45N / 129.35E)
- 생성물: 육지·안벽·잔교 11기·탱크팜·플레어·VTS타워·방파제·등대·항로부표·
          KNOC SPM 부이 + 계류 VLCC·선박 6척(실비율, frontend mock과 동일 배치)
- 사용: python onsan_scene_builder.py [출력경로]  (기본 D:/omniverse/UlsanScene/Final_Scene.usda)
"""
import math
import os
import sys

from pxr import Usd, UsdGeom, UsdLux, Gf

CENTER_LAT, CENTER_LON, SCALE = 35.45, 129.35, 50000.0


def proj(lat, lon):
    return ((lon - CENTER_LON) * SCALE, -(lat - CENTER_LAT) * SCALE)


# ── 해안 접선/법선 (처용리 UTK → 산암리 정일, 수역은 북동측) ──
P_UTK = proj(35.46225, 129.34753)
P_JI = proj(35.43778, 129.36694)
_dx, _dz = P_JI[0] - P_UTK[0], P_JI[1] - P_UTK[1]
_len = math.hypot(_dx, _dz)
T = (_dx / _len, _dz / _len)          # 해안 접선 (남동 방향)
N = (T[1], -T[0])                      # 수역(만) 방향 법선
YAW_T = math.degrees(math.atan2(T[0], T[1]))   # +Z 축을 T 로 돌리는 yaw


def shift(p, t_amt=0.0, n_amt=0.0):
    return (p[0] + T[0] * t_amt + N[0] * n_amt, p[1] + T[1] * t_amt + N[1] * n_amt)


# 선석: id → (대표점, 접선방향 이격)
_P_OTK = proj(35.45661, 129.35119)
_P_DHY = proj(35.45417, 129.35194)
_P_SO = proj(35.451, 129.356)
_P_HS = proj(35.44239, 129.35778)
BERTHS = {
    "UTK": (P_UTK, 0), "OTK1": (_P_OTK, -80), "OTK2": (_P_OTK, 80), "DHY": (_P_DHY, 110),
    "SO1": (_P_SO, -240), "SO2": (_P_SO, -80), "SO3": (_P_SO, 80), "SO4": (_P_SO, 240),
    "HS": (_P_HS, 0), "JI1": (P_JI, -80), "JI2": (P_JI, 80),
}
MOOR_N = 28  # 계류점: 잔교에서 만 방향 이격

# 선박 6척 (frontend useSensorStore mock 과 동일)
VESSELS = [
    # (id, berth or None, (lat,lon) if underway, yaw°, hull색)
    ("HMM_GOODWILL", "OTK1", None, None, (0.36, 0.10, 0.10)),
    ("WOOYANG_CHEMI", "JI1", None, None, (0.36, 0.10, 0.10)),
    ("PACIFIC_GLORY", "SO1", None, None, (0.10, 0.18, 0.36)),
    ("GAS_UTOPIA", None, (35.4250, 129.3900), 315.0, (0.45, 0.20, 0.45)),
    ("ULSAN_PIONEER", None, (35.4320, 129.3780), 160.0, (0.13, 0.35, 0.22)),
    ("SUN_VENUS", None, (35.4280, 129.4050), 70.0, (0.55, 0.45, 0.12)),
]


class Builder:
    def __init__(self, path):
        if os.path.exists(path):
            os.remove(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.stage = Usd.Stage.CreateNew(path)
        root = UsdGeom.Xform.Define(self.stage, "/World")
        self.stage.SetDefaultPrim(root.GetPrim())
        self.i = 0

    def _xf(self, prim, pos, scale, yaw=0.0, color=None):
        api = UsdGeom.XformCommonAPI(prim)
        api.SetTranslate(Gf.Vec3d(pos[0], pos[1], pos[2]))
        api.SetRotate(Gf.Vec3f(0, yaw, 0))
        api.SetScale(Gf.Vec3f(scale[0], scale[1], scale[2]))
        if color:
            prim.GetDisplayColorAttr().Set([Gf.Vec3f(*color)])

    def cube(self, path, pos, scale, yaw=0.0, color=(0.5, 0.5, 0.5)):
        c = UsdGeom.Cube.Define(self.stage, path)
        c.GetSizeAttr().Set(2.0)
        self._xf(c, pos, scale, yaw, color)
        return c

    def cyl(self, path, pos, radius, height, color=(0.7, 0.7, 0.7), axis_z=False):
        c = UsdGeom.Cylinder.Define(self.stage, path)
        c.GetRadiusAttr().Set(1.0)
        c.GetHeightAttr().Set(2.0)
        api = UsdGeom.XformCommonAPI(c)
        api.SetTranslate(Gf.Vec3d(*pos))
        if axis_z:
            api.SetRotate(Gf.Vec3f(90, 0, 0))
        api.SetScale(Gf.Vec3f(radius, height / 2.0, radius))
        c.GetDisplayColorAttr().Set([Gf.Vec3f(*color)])
        return c

    # ── 환경 ──
    def environment(self):
        sun = UsdLux.DistantLight.Define(self.stage, "/World/Env/Sun")
        sun.GetIntensityAttr().Set(3000.0)
        sun.GetColorAttr().Set(Gf.Vec3f(1.0, 0.92, 0.82))
        UsdGeom.XformCommonAPI(sun).SetRotate((-42, 40, 0))
        dome = UsdLux.DomeLight.Define(self.stage, "/World/Env/Sky")
        dome.GetIntensityAttr().Set(600.0)
        # 바다
        self.cube("/World/Env/Ocean", (0, -0.15, 0), (12000, 0.15, 12000), 0, (0.05, 0.17, 0.30))

    # ── 육지/안벽/도로 ──
    def landmass(self):
        mid = shift(((P_UTK[0] + P_JI[0]) / 2, (P_UTK[1] + P_JI[1]) / 2), 0, -830)
        self.cube("/World/Land/Main", (mid[0], 1.0, mid[1]), (2400, 1.5, 800), YAW_T, (0.22, 0.26, 0.31))
        apron = shift(((P_UTK[0] + P_JI[0]) / 2, (P_UTK[1] + P_JI[1]) / 2), 0, -18)
        self.cube("/World/Land/Apron", (apron[0], 2.2, apron[1]), (2100, 0.8, 22), YAW_T, (0.28, 0.32, 0.38))
        road = shift(((P_UTK[0] + P_JI[0]) / 2, (P_UTK[1] + P_JI[1]) / 2), 0, -60)
        self.cube("/World/Land/Road", (road[0], 2.6, road[1]), (2100, 0.3, 10), YAW_T, (0.12, 0.14, 0.17))

    # ── 잔교식 부두 ──
    def berth(self, bid, anchor, t_shift):
        base = shift(anchor, t_shift, 0)
        root = f"/World/Berths/{bid}"
        UsdGeom.Xform.Define(self.stage, root)
        # 잔교 데크 (안벽에서 만 방향으로 돌출)
        deck = shift(base, 0, 6)
        self.cube(f"{root}/Deck", (deck[0], 2.5, deck[1]), (14, 1.2, 20), YAW_T, (0.24, 0.27, 0.32))
        # 로딩암 타워 2기 (노랑)
        for k, off in enumerate((-6, 6)):
            p = shift(base, off, 10)
            self.cube(f"{root}/MLA_{k}", (p[0], 7.0, p[1]), (1.6, 4.5, 1.6), YAW_T, (0.92, 0.70, 0.03))
        # 계류 돌핀 + 캣워크
        for k, off in enumerate((-28, 28)):
            d = shift(base, off, 14)
            self.cube(f"{root}/Dolphin_{k}", (d[0], 2.0, d[1]), (5, 1.6, 5), YAW_T, (0.30, 0.33, 0.38))
            c = shift(base, off / 2, 12)
            self.cube(f"{root}/Catwalk_{k}", (c[0], 2.8, c[1]), (14, 0.25, 1.4), YAW_T, (0.55, 0.58, 0.62))
        # 접근 트레슬 (육지 연결)
        tr = shift(base, 0, -8)
        self.cube(f"{root}/Trestle", (tr[0], 2.2, tr[1]), (4, 0.9, 14), YAW_T, (0.30, 0.34, 0.40))

    # ── 탱크팜 (S-Oil 배후) ──
    def tank_farm(self):
        base = shift(_P_SO, -60, -260)
        self.cube("/World/TankFarm/Pad", (base[0], 2.0, base[1]), (170, 0.5, 110), YAW_T, (0.26, 0.30, 0.36))
        n = 0
        for r in range(2):
            for c in range(5):
                p = shift(base, (c - 2) * 62, (r - 0.5) * 84)
                self.cyl(f"/World/TankFarm/Tank_{n}", (p[0], 14, p[1]), 26, 24, (0.82, 0.84, 0.86))
                n += 1
        # 플레어 스택
        fp = shift(base, 200, 30)
        self.cyl("/World/TankFarm/FlareStack", (fp[0], 30, fp[1]), 2.2, 60, (0.45, 0.48, 0.52))
        flame = UsdGeom.Sphere.Define(self.stage, "/World/TankFarm/Flame")
        UsdGeom.XformCommonAPI(flame).SetTranslate(Gf.Vec3d(fp[0], 63, fp[1]))
        UsdGeom.XformCommonAPI(flame).SetScale(Gf.Vec3f(4, 5, 4))
        flame.GetDisplayColorAttr().Set([Gf.Vec3f(1.0, 0.45, 0.1)])

    # ── 배후 시설 ──
    def facilities(self):
        # 창고/건물
        for k, (t_amt, n_amt, sc) in enumerate([
            (-450, -160, (48, 8, 26)), (-150, -200, (40, 10, 22)),
            (350, -170, (52, 9, 26)), (700, -150, (36, 7, 20)),
        ]):
            mid = shift(((P_UTK[0] + P_JI[0]) / 2, (P_UTK[1] + P_JI[1]) / 2), t_amt, n_amt)
            self.cube(f"/World/Fac/Bldg_{k}", (mid[0], sc[1] + 1, mid[1]), sc, YAW_T, (0.33, 0.37, 0.44))
        # VTS 관제탑 (대한유화 배후 고지)
        vp = shift(_P_DHY, -60, -140)
        self.cyl("/World/Fac/VTS_Tower", (vp[0], 26, vp[1]), 4, 52, (0.85, 0.88, 0.92))
        self.cyl("/World/Fac/VTS_Deck", (vp[0], 54, vp[1]), 9, 6, (0.25, 0.30, 0.38))
        # 방파제 + 등대 (정일 남동)
        for k in range(8):
            p = shift(P_JI, 180, 30 + k * 34)
            self.cube(f"/World/Fac/Breakwater_{k}", (p[0], 2.5, p[1]), (9, 2.2, 15), YAW_T, (0.32, 0.35, 0.40))
        lp = shift(P_JI, 180, 30 + 8 * 34)
        self.cyl("/World/Fac/Lighthouse", (lp[0], 9, lp[1]), 2.4, 18, (0.95, 0.96, 0.97))
        self.cyl("/World/Fac/LighthouseTop", (lp[0], 19.5, lp[1]), 1.6, 3, (0.85, 0.15, 0.15))

    # ── 항로 부표 ──
    def fairway(self):
        for k, t_amt in enumerate((-500, -100, 300, 700, 1100)):
            for side, (n_amt, color) in enumerate([(380, (0.06, 0.60, 0.40)), (500, (0.87, 0.16, 0.16))]):
                p = shift(((P_UTK[0] + P_JI[0]) / 2, (P_UTK[1] + P_JI[1]) / 2), t_amt, n_amt)
                self.cyl(f"/World/Fairway/Buoy_{k}_{side}", (p[0], 1.5, p[1]), 2.2, 3, color)

    # ── KNOC SPM 부이 + 계류 VLCC ──
    def knoc(self):
        bp = proj(35.38633, 129.393)
        self.cyl("/World/KNOC/Buoy", (bp[0], 1.5, bp[1]), 8, 3, (0.95, 0.45, 0.10))
        # VLCC (부이에 선수 계류, 실비율 약 330m ≈ 150유닛)
        vx, vz = bp[0] - 95, bp[1] + 40
        yaw = math.degrees(math.atan2(bp[0] - vx, bp[1] - vz))
        root = "/World/KNOC/VLCC"
        UsdGeom.Xform.Define(self.stage, root)
        self._vessel_body(root, (vx, vz), yaw, (0.30, 0.11, 0.11), scale=2.1)

    # ── 선박 (실비율: 케미컬 탱커 약 160m ≈ 72유닛) ──
    def _vessel_body(self, root, pos, yaw, color, scale=1.0):
        s = scale
        hull = self.cube(f"{root}/Hull", (0, 3.2 * s, 0), (9 * s, 3.2 * s, 36 * s), 0, color)
        self.cube(f"{root}/Deck", (0, 6.6 * s, 0), (8.6 * s, 0.25 * s, 34 * s), 0, (0.30, 0.33, 0.38))
        self.cube(f"{root}/Bridge", (0, 9.5 * s, -26 * s), (7 * s, 3.2 * s, 5 * s), 0, (0.92, 0.93, 0.95))
        for i in range(4):
            self.cyl(f"{root}/DeckTank_{i}", (0, 7.8 * s, (i - 1.5) * 14 * s), 3.2 * s, 2.4 * s, (0.75, 0.77, 0.80))
        api = UsdGeom.XformCommonAPI(UsdGeom.Xform.Get(self.stage, root))
        api.SetTranslate(Gf.Vec3d(pos[0], 0, pos[1]))
        api.SetRotate(Gf.Vec3f(0, yaw, 0))

    def vessels(self):
        UsdGeom.Xform.Define(self.stage, "/World/Vessels")
        for vid, berth, latlon, yaw, color in VESSELS:
            root = f"/World/Vessels/{vid}"
            UsdGeom.Xform.Define(self.stage, root)
            if berth:
                anchor, t_shift = BERTHS[berth]
                p = shift(anchor, t_shift, MOOR_N)
                self._vessel_body(root, p, YAW_T, color)
            else:
                p = proj(*latlon)
                self._vessel_body(root, p, yaw, color)

    def save(self):
        self.stage.Save()


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "D:/omniverse/UlsanScene/Final_Scene.usda"
    b = Builder(out)
    b.environment()
    b.landmass()
    for bid, (anchor, t_shift) in BERTHS.items():
        b.berth(bid, anchor, t_shift)
    b.tank_farm()
    b.facilities()
    b.fairway()
    b.knoc()
    b.vessels()
    b.save()

    stage = Usd.Stage.Open(out)
    prims = list(stage.Traverse())
    print(f"OK: {out}")
    print(f"prims: {len(prims)}, size: {os.path.getsize(out)} bytes")


if __name__ == "__main__":
    main()
