"""OpenAI 단일 provider — Gemini 제거 (2026-10-11).

DB·네트워크 없이 설정·팩토리만 본다.
"""
import importlib.util
from types import SimpleNamespace

import pytest
from pydantic import BaseModel, ValidationError

from app.config import Settings
from app.core.exceptions import LLMGenerationError
from app.llm import factory, openai_client

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


class _Out(BaseModel):
    text: str


class _FakeStructured:
    """with_structured_output 이 돌려주는 실행기 — 정해 둔 응답을 차례로 낸다."""

    def __init__(self, replies):
        self.replies, self.calls = list(replies), 0

    async def ainvoke(self, messages):
        self.calls += 1
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class _FakeChat:
    def __init__(self, replies):
        self.structured = _FakeStructured(replies)

    def with_structured_output(self, schema, **_):
        return self.structured


def _client(monkeypatch, replies):
    async def _no_sleep(_):
        return None

    monkeypatch.setattr(openai_client.asyncio, "sleep", _no_sleep)
    client = openai_client.OpenAiClient(api_key="sk-test", model="gpt-4.1-mini")
    client._chat = _FakeChat(replies)
    return client


@pytest.mark.asyncio
async def test_structured_output_is_returned(monkeypatch):
    client = _client(monkeypatch, [_Out(text="ok")])
    out = await client.generate_structured(system_prompt="s", user_prompt="u", schema=_Out)
    assert out.text == "ok"


@pytest.mark.asyncio
async def test_empty_parse_is_retried_then_succeeds(monkeypatch):
    # 2026-08-22 실측: HTTP 200 인데 구조화 출력만 비어 오는 간헐 실패(53회 중 4회) — 같은 요청을 다시 보내면 대부분 성공
    client = _client(monkeypatch, [None, _Out(text="ok")])
    out = await client.generate_structured(system_prompt="s", user_prompt="u", schema=_Out)
    assert out.text == "ok" and client._chat.structured.calls == 2


@pytest.mark.asyncio
async def test_exception_is_retried_like_empty_parse(monkeypatch):
    client = _client(monkeypatch, [RuntimeError("rate limit"), _Out(text="ok")])
    out = await client.generate_structured(system_prompt="s", user_prompt="u", schema=_Out)
    assert out.text == "ok"


@pytest.mark.asyncio
async def test_gives_up_after_three_attempts(monkeypatch):
    client = _client(monkeypatch, [None, None, None])
    with pytest.raises(LLMGenerationError):
        await client.generate_structured(system_prompt="s", user_prompt="u", schema=_Out)
    assert client._chat.structured.calls == 3   # 무한 대기하지 않는다


def test_chat_model_is_exposed_for_agents():
    client = openai_client.OpenAiClient(api_key="sk-test", model="gpt-4.1-mini")
    assert client.chat_model() is client._chat
