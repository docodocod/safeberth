from functools import lru_cache

from app.config import get_settings
from app.llm.base import LLMClient
from app.llm.embeddings import EmbeddingClient, OpenAiEmbeddingClient
from app.llm.openai_client import OpenAiClient


def _client_for(model: str) -> LLMClient:
    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY가 설정되지 않았습니다 (.env 확인).")
    return OpenAiClient(api_key=settings.openai_api_key, model=model)


@lru_cache
def get_llm_client() -> LLMClient:
    """기본 LLMClient. 모델은 settings.llm_model.

    [2026-10-11] Gemini 를 걷어내 provider 분기가 없다 — OpenAI 만 쓴다.
    """
    return _client_for(get_settings().llm_model)


@lru_cache
def get_chatbot_llm_client() -> LLMClient:
    """챗봇용 LLMClient. settings.chatbot_llm_model 이 있으면 그 모델, 없으면 llm_model."""
    settings = get_settings()
    return _client_for(settings.chatbot_llm_model or settings.llm_model)


@lru_cache
def get_safety_llm_client() -> LLMClient:
    """화물 혼재 심사(POST /safety/assess)용 LLMClient. safety_llm_model 이 있으면 그 모델, 없으면 llm_model.

    [2026-09-29] 종합 문장 품질 때문에 llm_model 을 mini 로 올리자 혼재 심사 화면(화물 특성·체크리스트만
    LLM)이 느려졌다 — 등급은 규칙엔진이 정하므로 이 서술은 작은 모델로 충분하다.
    """
    settings = get_settings()
    return _client_for(settings.safety_llm_model or settings.llm_model)


@lru_cache
def get_embedding_client() -> EmbeddingClient:
    """settings.embedding_provider 값에 따라 EmbeddingClient 구현체를 고른다.

    llm_provider와 별개로 관리한다(app/config.py 주석 참고). 챗봇 RAG 인덱스는
    적재/조회가 동일 모델이어야 하므로 provider 전환은 재적재를 동반해야 한다.
    """
    settings = get_settings()

    if settings.embedding_provider == "openai":
        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY가 설정되지 않았습니다 (.env 확인).")
        return OpenAiEmbeddingClient(
            api_key=settings.openai_api_key, model=settings.embedding_model
        )

    raise ValueError(f"지원하지 않는 embedding_provider: {settings.embedding_provider}")
