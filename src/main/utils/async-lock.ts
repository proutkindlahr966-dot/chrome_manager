/**
 * Hàng đợi async tuần tự — tránh race khi nhiều Chrome song song
 * dùng chung tài nguyên (clipboard OS, cấp port...).
 */
export function createAsyncLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()

  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/** Lock theo key (vd. profileId) — các key khác vẫn chạy song song */
export function createKeyedAsyncLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()

  return function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}
