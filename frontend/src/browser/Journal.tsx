import type { BrowserTab, JournalEvent } from '../api/types'
import { Icon } from '../components/Icon'
import styles from './BrowserPanel.module.css'

const SHOWN = 6
const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** «Ход поиска»: последние события журнала по позиции выбранной вкладки. */
export function Journal({ events, tabs, position }: { events: JournalEvent[]; tabs: BrowserTab[]; position: number | undefined }) {
  const shown = (position ? events.filter((e) => e.position_index === position || e.position_index == null) : events).slice(-SHOWN)
  if (shown.length === 0) return null
  const active = new Set(tabs.filter((t) => t.state === 'loading' || t.state === 'reading').map((t) => t.id))
  const lastOpened = new Map(shown.filter((e) => e.tab_id).map((e) => [e.tab_id, e.id]))
  return (
    <section className={styles.journal} aria-label="Ход поиска">
      <div className={styles.journalHead}>
        <h3>Ход поиска</h3>
        {position ? <span>позиция {position}</span> : null}
      </div>
      <ol>
        {shown.map((event) => {
          const live = event.kind === 'opened' && event.tab_id && active.has(event.tab_id) && lastOpened.get(event.tab_id) === event.id
          const quiet = event.kind === 'skipped' || event.kind === 'error'
          return (
            <li key={event.id} className={quiet ? styles.quiet : live ? styles.live : undefined}>
              <time dateTime={event.at}>{time.format(new Date(event.at))}</time>
              <JournalIcon kind={event.kind} live={Boolean(live)} />
              <span>{event.text}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function JournalIcon({ kind, live }: { kind: JournalEvent['kind']; live: boolean }) {
  if (live) return <Icon name="spin" className={styles.spin} />
  if (kind === 'found' || kind === 'resolved') return <Icon name="check" />
  if (kind === 'skipped' || kind === 'error') return <Icon name="x" />
  if (kind === 'waiting') return <span className={styles.helpDot} aria-hidden="true" />
  return <span className={styles.openDot} aria-hidden="true" />
}
