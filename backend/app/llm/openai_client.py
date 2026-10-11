"""OpenAI 기반 LLMClient 구현체 — LangChain ChatOpenAI 위에 얹었다.

[2026-10-11] 직접 `openai` SDK(responses.parse)를 부르던 것을 LangChain `ChatOpenAI` 로 옮겼다.
이유: 계획 2 부터 전문 에이전트가 같은 모델 객체에 도구를 바인딩(`chat_model().bind_tools`)해 ReAct 루프를
돌려야 하는데, 도구 호출은 LangChain 메시지·도구 규약을 쓴다. `generate_structured` 계약은 그대로라 기존 호출부
(챗봇·안전 서술·종합 문장)는 수정하지 않았다.
"""

import asyncio
import logging

from langchain_openai import ChatOpenAI

from app.core.exceptions import LLMGenerationError
from app.llm.base import LLMClient, SchemaT

logger = logging.getLogger(__name__)

# 재시도 정책 (2026-08-22 성능 측정에서 추가, 이식 후에도 유지).
#
# 왜 필요한가: `POST /api/v1/rag/query` 53회 실측에서 4회(7.5%)가 구조화 출력이 비어 돌아와 502가 났다.
# 업스트림은 HTTP 200을 주는데 구조화 출력만 비어 오는 간헐적 현상이라, 같은 요청을 그대로 다시 보내면
# 대부분 성공한다(같은 프롬프트를 인프로세스로 12회 돌렸을 때는 0회 실패).
#
# 예외(네트워크·레이트리밋)와 파싱 실패를 **같이** 재시도한다. ChatOpenAI 의 자체 재시도(max_retries)는
# 예외만 다루므로 0 으로 두고 이 루프 하나로 합친다 — 두 겹이면 시도 횟수가 곱해진다.
_MAX_ATTEMPTS = 3
_BACKOFF_BASE_SECONDS = 0.5


class OpenAiClient(LLMClient):
    def __init__(self, *, api_key: str, model: str) -> None:
        # use_responses_api: 기존 구현(responses.parse)과 같은 API 를 유지해 응답 동작이 달라지지 않게 한다.
        self._chat = ChatOpenAI(model=model, api_key=api_key, max_retries=0, use_responses_api=True)

    def chat_model(self) -> ChatOpenAI:
        """도구를 바인딩해 쓰는 에이전트용 모델 객체(계획 2)."""
        return self._chat

    async def generate_structured(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: type[SchemaT],
    ) -> SchemaT:
        structured = self._chat.with_structured_output(schema, method="json_schema")
        messages = [("system", system_prompt), ("human", user_prompt)]
        last_reason = ""
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                parsed = await structured.ainvoke(messages)
            except Exception as e:  # noqa: BLE001 - 업스트림 SDK 예외를 하나의 도메인 예외로 통일
                last_reason = str(e)
            else:
                if isinstance(parsed, schema):
                    return parsed
                last_reason = "응답을 스키마로 파싱하지 못했습니다 (parsed 가 비어 있음)."

            if attempt < _MAX_ATTEMPTS:
                delay = _BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                logger.warning(
                    "openai generate_structured 실패 (%d/%d, schema=%s): %s — %.1fs 후 재시도",
                    attempt, _MAX_ATTEMPTS, schema.__name__, last_reason, delay,
                )
                await asyncio.sleep(delay)

        raise LLMGenerationError(
            provider="openai",
            reason=f"{_MAX_ATTEMPTS}회 시도 후에도 실패했습니다: {last_reason}",
        )
