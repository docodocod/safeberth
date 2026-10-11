import asyncio
import logging
import math
import os
try:
    from pxr import Usd, UsdGeom, UsdLux, Gf, Sdf
    HAS_USD = True
except ImportError:
    HAS_USD = False

logger = logging.getLogger(__name__)

class OmniverseConnector:
    def __init__(self, usd_path: str = "C:/Users/hwham/Documents/Final_Scene.usda"):
        self.usd_path = usd_path
        self.initialized = False
        self.stage = None

    def _create_cinematic_environment(self):
        """영화 CG급 조명과 바다 평면 생성"""
        # 1. 태양광 (DistantLight)
        sun_path = '/World/Environment/Sun'
        if not self.stage.GetPrimAtPath(sun_path):
            sun = UsdLux.DistantLight.Define(self.stage, sun_path)
            sun.GetIntensityAttr().Set(3000.0)
            sun.GetAngleAttr().Set(0.53) # 실제 태양 크기
            sun.GetColorAttr().Set(Gf.Vec3f(1.0, 0.9, 0.8))
            UsdGeom.XformCommonAPI(sun).SetRotate(( -45, 45, 0 ))

        # 2. 돔 라이트 (하늘 반사용)
        dome_path = '/World/Environment/Sky'
        if not self.stage.GetPrimAtPath(dome_path):
            dome = UsdLux.DomeLight.Define(self.stage, dome_path)
            dome.GetIntensityAttr().Set(500.0)

        # 3. 거대한 바다 평면 (Ocean Plane - Cube를 얇게 펴서 사용)
        ocean_path = '/World/Environment/Ocean'
        if not self.stage.GetPrimAtPath(ocean_path):
            ocean = UsdGeom.Cube.Define(self.stage, ocean_path)
            UsdGeom.XformCommonAPI(ocean).SetScale((10000, 0.1, 10000))
            UsdGeom.XformCommonAPI(ocean).SetTranslate((0, -0.1, 0))
            ocean.GetDisplayColorAttr().Set([(0.05, 0.15, 0.3)]) # 딥블루 해양 색상

    def _create_procedural_tanker(self, vessel_id: str):
        """파이썬 코드로 거대한 유조선 형태 조립"""
        vessel_path = f"/World/Vessels/{vessel_id}"
        if self.stage.GetPrimAtPath(vessel_path):
            return UsdGeom.Xform.Get(self.stage, vessel_path)

        vessel = UsdGeom.Xform.Define(self.stage, vessel_path)

        # 1. 선체 (거대하게 키움: 길이 100m)
        hull = UsdGeom.Cube.Define(self.stage, f"{vessel_path}/Hull")
        UsdGeom.XformCommonAPI(hull).SetScale((100.0, 30.0, 500.0))
        UsdGeom.XformCommonAPI(hull).SetTranslate((0, 15.0, 0))
        hull.GetDisplayColorAttr().Set([(0.6, 0.2, 0.2)])

        # 2. 선교
        bridge = UsdGeom.Cube.Define(self.stage, f"{vessel_path}/Bridge")
        UsdGeom.XformCommonAPI(bridge).SetScale((80.0, 50.0, 60.0))
        UsdGeom.XformCommonAPI(bridge).SetTranslate((0, 70.0, -200.0))
        bridge.GetDisplayColorAttr().Set([(0.9, 0.9, 0.9)])

        # 3. 유류 탱크들
        for i in range(4):
            tank = UsdGeom.Cylinder.Define(self.stage, f"{vessel_path}/Tank_{i}")
            UsdGeom.XformCommonAPI(tank).SetScale((35.0, 35.0, 35.0))
            UsdGeom.XformCommonAPI(tank).SetRotate((90, 0, 0))
            UsdGeom.XformCommonAPI(tank).SetTranslate((0, 45.0, 150 - (i * 100)))
            tank.GetDisplayColorAttr().Set([(0.7, 0.7, 0.7)])

        return vessel

    def _create_procedural_berths(self):
        """항만의 여러 부두(Berth)들을 절차적으로 생성"""
        # 간단한 직육면체들로 항만 인프라 구축
        terminals = [
            {"name": "OTK_Terminal", "x": -2000, "z": -1500, "color": [(0.8, 0.8, 0.8)]},
            {"name": "Jeongil_Terminal", "x": 0, "z": -1800, "color": [(0.7, 0.7, 0.9)]},
            {"name": "SK_Energy_Terminal", "x": 2000, "z": -1200, "color": [(0.9, 0.4, 0.4)]},
            {"name": "S_OIL_Terminal", "x": 4000, "z": -1000, "color": [(0.9, 0.9, 0.4)]},
        ]
        
        for term in terminals:
            path = f"/World/Environment/Berths/{term['name']}"
            if not self.stage.GetPrimAtPath(path):
                berth = UsdGeom.Cube.Define(self.stage, path)
                # 길이 800m, 너비 200m 부두
                UsdGeom.XformCommonAPI(berth).SetScale((800.0, 10.0, 200.0))
                UsdGeom.XformCommonAPI(berth).SetTranslate((term['x'], 5.0, term['z']))
                berth.GetDisplayColorAttr().Set(term['color'])

    async def initialize(self):
        """Initializes the USD Stage."""
        if not HAS_USD:
            logger.error("usd-core package is not installed. Cannot connect to Omniverse USD.")
            return

        logger.info(f"Preparing local USD stage at {self.usd_path}...")
        os.makedirs(os.path.dirname(self.usd_path), exist_ok=True)

        try:
            if os.path.exists(self.usd_path):
                if os.path.getsize(self.usd_path) == 0:
                    os.remove(self.usd_path)
                    self.stage = Usd.Stage.CreateNew(self.usd_path)
                else:
                    self.stage = Usd.Stage.Open(self.usd_path)
                    if not self.stage:
                        raise Exception("Failed to open stage")
            else:
                self.stage = Usd.Stage.CreateNew(self.usd_path)
        except Exception as e:
            if os.path.exists(self.usd_path):
                os.remove(self.usd_path)
            self.stage = Usd.Stage.CreateNew(self.usd_path)
            
        if not self.stage.GetDefaultPrim():
            root_prim = UsdGeom.Xform.Define(self.stage, '/World')
            self.stage.SetDefaultPrim(root_prim.GetPrim())

        self._create_cinematic_environment()
        self._create_procedural_berths()
            
        self.initialized = True
        logger.info("Local USD Stage ready for live-sync.")

    async def update_vessel_position(self, vessel_id: str, lat: float, lon: float, heading: float, color: list = None):
        if not self.initialized or not self.stage:
            return
            
        vessel = self._create_procedural_tanker(vessel_id)
        
        if color:
            # 선체 색상 변경으로 다양한 선박 표현
            hull_path = f"/World/Vessels/{vessel_id}/Hull"
            hull = UsdGeom.Cube.Get(self.stage, hull_path)
            if hull:
                hull.GetDisplayColorAttr().Set([color])
        
        # 좌표 변환 (울산항 기준 위경도 -> 3D 로컬 좌표)
        x = (lon - 129.35) * 50000
        z = (lat - 35.45) * -50000
        
        transform_api = UsdGeom.XformCommonAPI(vessel)
        transform_api.SetTranslate((x, 0, z))
        transform_api.SetRotate((0, heading, 0))
        
    async def flush_changes(self):
        """여러 선박 업데이트 후 한 번에 저장"""
        if self.initialized and self.stage:
            self.stage.Save()

    async def shutdown(self):
        if self.initialized:
            self.initialized = False
