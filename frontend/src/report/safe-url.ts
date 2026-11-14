/** Ссылки на источники ведут только на http(s): остальное показываем текстом. */
export const isHttpUrl = (url: string) => /^https?:\/\//i.test(url)
