import type { Message } from '../api/types'

/**
 * Вставляет сообщение или заменяет существующее с тем же `id` (docs/api.md §4).
 * Порядок — по `created_at`; при равных датах сохраняется порядок поступления,
 * поэтому повторная доставка события безопасна.
 */
export function mergeMessage(messages: Message[], incoming: Message): Message[] {
  const index = messages.findIndex((m) => m.id === incoming.id)
  if (index !== -1) return messages.map((m, i) => (i === index ? incoming : m))
  const time = Date.parse(incoming.created_at)
  // вставляем после последнего сообщения, которое не новее входящего
  let at = messages.length
  while (at > 0 && Date.parse(messages[at - 1].created_at) > time) at -= 1
  return [...messages.slice(0, at), incoming, ...messages.slice(at)]
}
