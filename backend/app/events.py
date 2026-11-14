import asyncio
from collections import defaultdict
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Literal

from app.models import DomainModel


class Event(DomainModel):
    type: Literal["progress", "question", "report", "error", "message", "agent", "procurement"]
    data: dict


Emit = Callable[[Event], Awaitable[None]]


async def noop_emit(event: Event) -> None:
    pass


class EventBus:
    """Медленный подписчик переподключается и перечитывает состояние через REST."""

    def __init__(self):
        self.subscribers = defaultdict(set)

    @asynccontextmanager
    async def subscribe(self, procurement_id):
        queue = asyncio.Queue(maxsize=256)
        self.subscribers[procurement_id].add(queue)
        try:
            yield queue
        finally:
            self.subscribers[procurement_id].discard(queue)
            if not self.subscribers[procurement_id]:
                self.subscribers.pop(procurement_id, None)

    async def publish(self, procurement_id, event):
        for queue in tuple(self.subscribers.get(procurement_id, ())):
            if queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(None)
                self.subscribers[procurement_id].discard(queue)
            else:
                queue.put_nowait(event)
