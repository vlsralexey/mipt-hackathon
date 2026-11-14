// В окружении node нет страницы, от которой считаются относительные адреса.
// Задаём базу, как в браузере: клиент ходит на /api, MSW сопоставляет такие же пути.
if (typeof window === 'undefined') {
  const base = 'http://localhost:3000'
  const nativeFetch = globalThis.fetch
  ;(globalThis as { location?: unknown }).location = new URL(`${base}/`)
  globalThis.fetch = (input, init) =>
    nativeFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init)
}

export {}
