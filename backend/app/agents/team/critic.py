"""코드 Critic — 에이전트 이유 문장의 숫자·호출부호가 근거에 실제로 있는가 (2026-10-12, 계획 3).

LLM Critic 보다 먼저 돈다. 같은 OpenAI 계열 LLM 은 오류가 겹친다(arXiv 2506.07962 — 둘 다 틀릴 때 60% 같은 답)라
LLM 의 '근거 있음'은 독립 검증이 아니다. 코드가 볼 수 있는 것 — 이유에 나온 수치와 선박 식별자가 근거 글에 있는가 —
는 코드가 먼저 본다. 2026-09-29 실측: 허술한 프롬프트로 쓴 종합 문장 31건 중 28건에 없는 사실이 들어갔다.
"""

import re

# 영문자·숫자 바로 뒤에 붙은 숫자는 식별자의 일부(D8MP 의 8, SK6 의 6)라 따로 세지 않는다 — 식별자는 아래 _IDENT 가 본다.
_NUMBER = re.compile(r"(?<![A-Za-z0-9])\d+(?:\.\d+)?")
# 호출부호 같은 식별자 — 숫자가 섞인 4자 이상 영숫자 대문자. 숫자 없는 약칭(UTK)·짧은 코드(SK6)는 오탐이 많아 보지 않는다.
_IDENT = re.compile(r"\b[A-Z0-9]{4,}\b")


def ungrounded_tokens(reasoning: str, sources: list[str]) -> list[str]:
    corpus = " ".join(sources)
    numbers = set(_NUMBER.findall(reasoning))
    idents = {t for t in _IDENT.findall(reasoning) if any(c.isdigit() for c in t) and not t.isdigit()}
    return sorted(t for t in numbers | idents if t not in corpus)
