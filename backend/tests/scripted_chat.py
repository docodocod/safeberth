"""테스트용 채팅 모델 — 정해 둔 AIMessage 를 차례로 돌려주고 받은 메시지를 기록한다 (2026-10-12).

tests/ 에는 __init__.py 가 없어 pytest 가 이 폴더를 sys.path 에 올린다 — 테스트에서 `from scripted_chat import ...`.
"""
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult


class ScriptedChat(BaseChatModel):
    replies: list
    cursor: int = 0
    seen: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.cursor >= len(self.replies):
            raise AssertionError("스크립트에 없는 모델 호출입니다")
        reply = self.replies[self.cursor]
        self.cursor += 1
        self.seen.append(list(messages))
        if isinstance(reply, Exception):
            raise reply
        return ChatResult(generations=[ChatGeneration(message=reply)])


def tool_call(name: str, args: dict, call_id: str = "c1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])
