"""LLM 프로바이더 공통 인터페이스.

에이전트 코드(app/agents/*)는 이 인터페이스에 의존한다. 구현체는 OpenAiClient 하나다
(2026-10-11 Gemini 제거). 호출을 바꾸려면 app.llm.factory 의 반환 구현체만 바꾼다.
"""

from abc import ABC, abstractmethod
from typing import TypeVar

from pydantic import BaseModel

SchemaT = TypeVar("SchemaT", bound=BaseModel)


class LLMClient(ABC):
    """구조화 출력(JSON schema 강제)만 지원하는 최소 인터페이스."""

    @abstractmethod
    async def generate_structured(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: type[SchemaT],
    ) -> SchemaT:
        """system/user 프롬프트를 보내고, 주어진 Pydantic 스키마로 파싱된 결과를 반환한다."""
        raise NotImplementedError
