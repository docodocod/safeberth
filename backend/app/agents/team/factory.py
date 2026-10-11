"""에이전트 팀 생성 — 플래그와 클라이언트를 확인한다 (2026-10-12, 계획 2)."""

from neo4j import AsyncDriver
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.orchestrator.schemas import OrchestratorRequest
from app.config import get_settings
from app.llm.base import LLMClient

from .team import Team
from .toolbox import Toolbox


def build_team(
    db: AsyncSession, neo4j_driver: AsyncDriver, llm_client: LLMClient, request: OrchestratorRequest,
) -> Team | None:
    """AGENT_TEAM_ENABLED 가 꺼져 있거나 클라이언트에 chat_model() 이 없으면(NullLLMClient) None — 기존 동작 그대로."""
    if not get_settings().agent_team_enabled:
        return None
    chat_model = getattr(llm_client, "chat_model", None)
    if chat_model is None:
        return None
    return Team(chat_model=chat_model(), toolbox=Toolbox(db, neo4j_driver, request))
