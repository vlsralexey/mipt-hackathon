import type { Message } from '../../api/types'
import { Icon } from '../../components/Icon'
import { formatSize } from '../../format'
import { Markdown } from '../Markdown'
import { ErrorCard, ProposalCard, SourceBlockedCard } from './NoteCards'
import { QuestionCard } from './QuestionCard'
import { RunCard } from './RunCard'
import { TzSummaryCard } from './TzSummaryCard'
import { VersionCard } from './VersionCard'
import styles from '../Thread.module.css'

/** Одно сообщение чата. Текст агента — пояснение над карточкой, если она есть. */
export function ChatMessage({ message }: { message: Message }) {
  switch (message.kind) {
    case 'text':
      return message.role === 'user' ? (
        <div className={styles.bubble}>{message.text}</div>
      ) : (
        <div className={styles.agent}>{message.text && <Markdown text={message.text} />}</div>
      )
    case 'file':
      return (
        <div className={styles.attach}>
          <Icon name="doc" />
          <span>
            <span className={styles.attachName}>{message.data.filename}</span>
            <span className={styles.attachSize}>{formatSize(message.data.size_bytes)}</span>
          </span>
        </div>
      )
    case 'tz_summary':
      return (
        <div className={styles.agent}>
          {message.text && <Markdown text={message.text} />}
          <TzSummaryCard data={message.data} />
        </div>
      )
    case 'question':
      return (
        <div className={styles.agent}>
          {message.text && <Markdown text={message.text} />}
          <QuestionCard data={message.data} />
        </div>
      )
    case 'run':
      return (
        <div className={styles.agent}>
          <RunCard data={message.data} />
          {message.text && <Markdown text={message.text} />}
        </div>
      )
    case 'version':
      return (
        <div className={styles.agent}>
          <VersionCard data={message.data} />
        </div>
      )
    case 'error':
      return <ErrorCard text={message.text} data={message.data} />
    case 'proposal':
      return <ProposalCard text={message.text} data={message.data} />
    case 'source_blocked':
      return <SourceBlockedCard text={message.text} data={message.data} />
    default:
      // сообщение неизвестного вида: показываем текст, если он есть, но не падаем
      return <FallbackMessage message={message} />
  }
}

function FallbackMessage({ message }: { message: Message }) {
  const text = (message as { text?: string | null }).text
  return text ? (
    <div className={styles.agent}>
      <Markdown text={text} />
    </div>
  ) : null
}
