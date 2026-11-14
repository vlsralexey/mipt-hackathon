import type { Message } from '../api/types'

/** Подряд идущие сообщения пользователя (файл и подпись к нему) показываются одним блоком. */
export function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (last && message.role === 'user' && last[0].role === 'user') last.push(message)
    else groups.push([message])
  }
  return groups
}
