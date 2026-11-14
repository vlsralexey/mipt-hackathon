import asyncio


async def gather_cancel(*coroutines):
    """При отказе одного задания не оставляем остальных работать без владельца."""
    tasks = [asyncio.create_task(coro) for coro in coroutines]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
