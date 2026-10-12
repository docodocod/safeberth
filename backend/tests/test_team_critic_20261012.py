"""코드 Critic — 이유 문장에 근거에 없는 숫자·호출부호가 있는가 (2026-10-12)."""
from app.agents.team.critic import ungrounded_tokens

SOURCES = ["같은 부두 '효성부두'의 옆배(OTHER7) 최신 판정 '부적합' (10/12 13:00 KST) — 이웃 화물과 혼재 충돌",
           "흘수 여유 3.00m"]


def test_grounded_reasoning_passes():
    assert ungrounded_tokens("옆배 OTHER7 의 최신 판정이 부적합이고 흘수 여유는 3.00m 입니다", SOURCES) == []


def test_invented_number_is_caught():
    # 2026-09-29 실측: 허술한 프롬프트는 없는 사실·수치를 만들었다
    assert ungrounded_tokens("풍속 25m/s 로 위험합니다", SOURCES) == ["25"]


def test_invented_call_sign_is_caught():
    assert ungrounded_tokens("D8MP 선박과 충돌 위험", SOURCES) == ["D8MP"]


def test_plain_words_and_short_codes_are_not_checked():
    # 숫자 없는 단어·3자 이하 코드는 대조하지 않는다(부두 약칭 등 오탐 방지)
    assert ungrounded_tokens("UTK 부두의 SK6 운영사 확인 필요", SOURCES) == []
