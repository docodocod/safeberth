"""OpenAI 단일 provider — Gemini 제거 (2026-10-11).

DB·네트워크 없이 설정·팩토리만 본다.
"""
import importlib.util
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.llm import factory

_REQUIRED = dict(database_url="x", neo4j_uri="x", neo4j_user="x", neo4j_password="x")


def test_gemini_provider_is_rejected_at_startup():
    # 옛 .env 에 LLM_PROVIDER=gemini 가 남아 있으면 조용히 다른 모델로 떨어지지 않고 기동 시 실패한다
    with pytest.raises(ValidationError):
        Settings(_env_file=None, llm_provider="gemini", **_REQUIRED)


def test_default_model_is_openai_model():
    s = Settings(_env_file=None, **_REQUIRED)
    assert s.llm_provider == "openai"
    assert s.llm_model.startswith("gpt-")


def test_gemini_client_module_is_gone():
    assert importlib.util.find_spec("app.llm.gemini_client") is None


def test_missing_openai_key_fails_with_clear_message(monkeypatch):
    monkeypatch.setattr(
        factory, "get_settings",
        lambda: SimpleNamespace(openai_api_key=None, llm_model="gpt-4.1-mini",
                                chatbot_llm_model=None, safety_llm_model=None),
    )
    for fn in (factory.get_llm_client, factory.get_chatbot_llm_client, factory.get_safety_llm_client):
        fn.cache_clear()
        with pytest.raises(RuntimeError, match="OPENAI_API_KEY가 설정되지 않았습니다"):
            fn()
        fn.cache_clear()


def test_models_are_chosen_per_role(monkeypatch):
    seen: list[str] = []

    class _Fake:
        def __init__(self, *, api_key, model):
            seen.append(model)

    monkeypatch.setattr(factory, "OpenAiClient", _Fake)
    monkeypatch.setattr(
        factory, "get_settings",
        lambda: SimpleNamespace(openai_api_key="sk-test", llm_model="main-model",
                                chatbot_llm_model="chat-model", safety_llm_model=None),
    )
    for fn in (factory.get_llm_client, factory.get_chatbot_llm_client, factory.get_safety_llm_client):
        fn.cache_clear()
        fn()
        fn.cache_clear()
    # 챗봇은 따로 정한 모델, 안전은 비어 있으니 llm_model
    assert seen == ["main-model", "chat-model", "main-model"]
