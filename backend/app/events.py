from collections.abc import Awaitable, Callable
from typing import Literal

from app.models import DomainModel


class Event(DomainModel):
    type: Literal["progress", "question", "report", "error", "message"]
    data: dict


Emit = Callable[[Event], Awaitable[None]]


async def noop_emit(event: Event) -> None:
    pass
