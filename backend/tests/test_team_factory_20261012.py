"""팀 팩토리·API 연결 — 플래그가 꺼져 있으면 기존 동작 그대로다 (2026-10-12). DB·네트워크 없음."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from scripted_chat import ScriptedChat

from app.agents.orchestrator.schemas import OrchestratorRequest
from app.agents.safety.schemas import CargoRef
from app.agents.scheduling.schemas import VesselSpec
from app.agents.team import factory
from app.agents.team.team import Team
from app.api.v1 import orchestrator as api
from app.llm.null_client import NullLLMClient

NOW = datetime.now(timezone.utc)


def _request() -> OrchestratorRequest:
    return OrchestratorRequest(
        vessel=VesselSpec(draught_m=9.0, call_sign="TEST"), cargo=CargoRef(chem_id="001008"),
        window_start=NOW, window_end=NOW + timedelta(hours=24),
        assigned_wharf_name="효성부두", reported_wharf_name="효성부두",   # API 의 DB 조회 분기를 건너뛴다
    )


class _ClientWithChat:
    def chat_model(self):
        return ScriptedChat(replies=[])


def _flag(monkeypatch, enabled: bool):
    monkeypatch.setattr(factory, "get_settings", lambda: SimpleNamespace(agent_team_enabled=enabled))


def test_flag_off_builds_no_team(monkeypatch):
    _flag(monkeypatch, False)
    assert factory.build_team(None, None, _ClientWithChat(), _request()) is None


def test_flag_on_with_chat_model_builds_team(monkeypatch):
    _flag(monkeypatch, True)
    assert isinstance(factory.build_team(None, None, _ClientWithChat(), _request()), Team)


def test_flag_on_but_client_has_no_chat_model_builds_no_team(monkeypatch):
    # 검토 초점 11
    _flag(monkeypatch, True)
    assert factory.build_team(None, None, NullLLMClient(), _request()) is None


def test_setting_defaults_to_off():
    from app.config import Settings

    s = Settings(_env_file=None, database_url="x", neo4j_uri="x", neo4j_user="x", neo4j_password="x")
    assert s.agent_team_enabled is False


@pytest.mark.asyncio
async def test_only_assess_endpoint_uses_team(monkeypatch):
    seen = []

    async def fake_orchestrate(db, driver, llm, request, **kwargs):
        seen.append(kwargs.get("team"))
        return "결과"

    sentinel = object()
    monkeypatch.setattr(api, "orchestrate", fake_orchestrate)
    monkeypatch.setattr(api, "build_team", lambda *a, **k: sentinel)
    await api.assess(_request(), db=None, llm_client=None)
    assert seen == [sentinel]
    seen.clear()
    await api._orchestrate_or_http(None, None, _request())        # 기록 경로 등 기본값은 팀을 쓰지 않는다
    assert seen == [None]
