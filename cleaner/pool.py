"""Background loading that never runs far ahead of the work, so memory stays flat."""
import collections
from concurrent.futures import ThreadPoolExecutor


def prefetch(fn, items, ahead=16, threads=4):
    """Like ThreadPoolExecutor.map, but keeps at most `ahead` results waiting. Plain map() reads every
    photo up front, so memory grows with the library until the system kills the app."""
    items = iter(items)
    ex = ThreadPoolExecutor(threads)
    try:
        q = collections.deque(ex.submit(fn, x) for _, x in zip(range(ahead), items))
        while q:
            r = q.popleft().result()
            for x in items:
                q.append(ex.submit(fn, x))
                break
            yield r
    finally:
        ex.shutdown(wait=True, cancel_futures=True)
