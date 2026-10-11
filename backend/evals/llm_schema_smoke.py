"""구조화 출력 스키마 스모크 — 실제 쓰는 스키마 5종이 새 OpenAiClient 로 도는지 실 API 로 확인한다.

**단위 테스트가 아니다.** OPENAI_API_KEY 가 필요하고 호출마다 과금된다. CI 에 넣지 말 것.
LangChain 의 json_schema 모드는 pydantic 스키마의 기본값·선택 필드를 openai SDK 의 responses.parse 와
다르게 다룰 수 있다(2026-10-11 이식 때 확인하려고 만든 도구). 스키마를 바꾸거나 모델을 바꿀 때도 돌려 본다.

실행:
    cd backend
    .venv/Scripts/python -m evals.llm_schema_smoke
"""
import asyncio
import io
import sys

from app.agents.chatbot.schemas import FollowUpPlan, LLMAnswer, QueryPlan
from app.agents.orchestrator.schemas import LLMSummary
from app.agents.safety.schemas import LLMAssessment
from app.config import get_settings
from app.llm.openai_client import OpenAiClient

_CASES = [
    (LLMSummary, "관제 화면의 종합 의견을 1문장으로 쓰세요.", "[등급 이유] 이 선석이 이 선박·화물 조건에 맞습니다"),
    (LLMAssessment, "화물 위험 서술 체크리스트를 쓰세요.", "[화물] 벤젠. 인접 화물 충돌 없음."),
    (QueryPlan, "질문을 분류하고 물질명을 뽑으세요.", "톨루엔과 벤젠을 같이 실어도 돼?"),
    (FollowUpPlan, "추가로 부를 도구를 고르세요. 필요 없으면 빈 배열.", "[질문] 벤젠 인화점은?"),
    (LLMAnswer, "근거만으로 답하세요.", "[근거] 벤젠 인화점 -11℃. [질문] 벤젠 인화점은?"),
]


async def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    settings = get_settings()
    client = OpenAiClient(api_key=settings.openai_api_key, model=settings.llm_model)
    failed = 0
    for schema, system, user in _CASES:
        try:
            out = await client.generate_structured(system_prompt=system, user_prompt=user, schema=schema)
            print(f"OK    {schema.__name__}: {out.model_dump_json()[:80]}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {schema.__name__}: {e}")
    return failed


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
