import { Link } from 'react-router'
import type { ErrorData, Proposal, SourceBlocked } from '../../api/types'
import { Icon } from '../../components/Icon'
import styles from './cards.module.css'

/** Ошибка прогона. Для неверного ключа сразу ведём в настройки. */
export function ErrorCard({ text, data }: { text: string | null; data: ErrorData }) {
  return (
    <div className={styles.note} role="alert">
      <Icon name="alert" />
      <p>{text ?? 'Что-то пошло не так.'}</p>
      {data.code === 'llm_auth' && (
        <div className={styles.actions}>
          <Link to="/settings">Открыть настройки</Link>
        </div>
      )}
    </div>
  )
}

/** Заготовка P1: карточка подтверждения без кнопок. Кнопки — этап 7. */
export function ProposalCard({ text, data }: { text: string | null; data: Proposal }) {
  return (
    <div className={styles.ask}>
      <div className={styles.q}>{text ?? data.text}</div>
    </div>
  )
}

/** Заготовка P1: источнику нужна капча или вход. Кнопки и браузер — этап 7. */
export function SourceBlockedCard({ text, data }: { text: string | null; data: SourceBlocked }) {
  return (
    <div className={styles.note}>
      <Icon name="alert" />
      <p>{text ?? `${data.name} просит подтвердить, что вы не робот.`}</p>
    </div>
  )
}
