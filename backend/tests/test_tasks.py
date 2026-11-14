import asyncio

import pytest

from app.tasks import gather_cancel


async def test_gather_cancels_remaining_work_on_error():
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def failing():
        await started.wait()
        raise ValueError("отказ")

    async def slow():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    with pytest.raises(ValueError, match="отказ"):
        await gather_cancel(failing(), slow())
    assert cancelled.is_set()
