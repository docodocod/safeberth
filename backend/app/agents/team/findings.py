"""발견(Finding) — 도구가 규칙·DB 로 계산한 사실. 에이전트 판정의 근거는 이것뿐이다 (2026-10-12, 계획 2).

LLM 의 해석이 아니라 코드가 만든 값이라 검사할 수 있다. tense 가 '현재'면 등급 상향의 근거가 되고, '예정'이면
조건의 근거만 된다(결정 7-1 — 미래의 불확실한 사건은 새 등급을 만들지 않는다). condition_text 는 조건 문장으로
쓸 글귀를 **코드가 사실로 만든 것**이다 — 모델이 쓴 문장을 조건으로 내보내지 않는다.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Finding(BaseModel):
    id: str
    kind: Literal["SAME_WHARF_BLOCKED", "UPCOMING_NEIGHBOR_CONFLICT"]
    tense: Literal["현재", "예정"]
    supports: Literal["주의", "부적합"] = Field(description="규칙이 계산한 등급. 팀 상향은 이 값과 TEAM_CAP 중 낮은 쪽까지")
    wharf_name: str = Field(description="발견이 가리키는 부두")
    call_sign: str | None = Field(default=None, description="발견이 가리키는 (다른) 선박")
    starts_at_utc: datetime | None = Field(default=None, description="'예정' 발견이 시작되는 시각(입항 예정 시각)")
    facts: list[str] = Field(default_factory=list)
    condition_text: str = ""
