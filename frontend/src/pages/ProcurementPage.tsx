import { useQuery } from '@tanstack/react-query'
import { useRef, useState, type KeyboardEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { BrowserPanel } from '../browser/BrowserPanel'
import { LocalSettingsPanel } from '../settings/LocalSettingsPanel'
import { VersionComparison } from '../report/VersionComparison'
import { api } from '../api/client'
import { Chat } from '../chat/Chat'
import { ReportControls } from '../report/ReportControls'
import { ReportPanel } from '../report/ReportPanel'
import { useReport } from '../report/useReport'
import type { RunNoticeState } from './NewProcurementPage'
import { RunNotice } from './RunNotice'
import styles from './ProcurementPage.module.css'

type Tab = 'report' | 'browser' | 'settings'

/** Плавно, но без анимации тем, кто отключил её в системе. */
function scrollToTop(el: HTMLElement | null) {
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
  else el.scrollTop = 0
}
const tabs: { id: Tab; label: string }[] = [
  { id: 'report', label: 'Отчёт' },
  { id: 'browser', label: 'Браузер' },
  { id: 'settings', label: 'Правила' },
]

/** Экран закупки: чат слева, панель «Отчёт / Браузер» справа. */
export function ProcurementPage() {
  const { id = '' } = useParams()
  // key: при переходе к другой закупке сбрасываются вкладка и уведомление о запуске
  return <ProcurementView key={id} id={id} />
}

function ProcurementView({ id }: { id: string }) {
  const procurement = useQuery({
    queryKey: ['procurement', id],
    queryFn: () => api.getProcurement(id),
  })
  const [tab, setTab] = useState<Tab>('report')
  // Версия в панели отчёта: null — следить за последней. Её же получает чат как viewing_version.
  const [viewing, setViewing] = useState<number | null>(null)
  const [comparing, setComparing] = useState(false)
  const hasReport = (procurement.data?.latest_version ?? null) !== null
  const reports = useReport(id, hasReport, viewing)
  const shownVersion = reports.report.data?.version ?? procurement.data?.latest_version ?? null

  const reportPanel = useRef<HTMLDivElement>(null)

  /** «Открыть» в карточке версии: показать версию и вернуть отчёт к началу, даже если он уже открыт. */
  function openVersion(version: number) {
    setViewing(version === procurement.data?.latest_version ? null : version)
    setTab('report')
    // после перерисовки: вкладка может быть скрыта, а отчёт прокручен вниз
    requestAnimationFrame(() => scrollToTop(reportPanel.current))
  }

  // Ошибка запуска приходит из формы новой закупки через состояние маршрута.
  const location = useLocation()
  const navigate = useNavigate()
  const [runError, setRunError] = useState<string | null>(
    (location.state as RunNoticeState | null)?.runError ?? null,
  )
  function resolveRunError() {
    setRunError(null)
    void navigate(location.pathname, { replace: true, state: null })
  }

  function onTabKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const next = tabs[(tabs.findIndex((t) => t.id === tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id
    setTab(next)
    document.getElementById(`tab-${next}`)?.focus()
  }

  if (procurement.isError) {
    return (
      <div className={styles.state} role="alert">
        <h1>{procurement.error.message}</h1>
        <p>Выберите закупку в списке слева или создайте новую.</p>
      </div>
    )
  }

  return (
    <div className={styles.workspace}>
      <section className={styles.chat} aria-label="Чат с агентом">
        <div className={styles.head}>
          <h1>{procurement.data?.title ?? ' '}</h1>
        </div>
        {runError && (
          <RunNotice
            procurementId={id}
            message={runError}
            onResolved={resolveRunError}
            onFailed={setRunError}
          />
        )}
        {procurement.data ? (
          // key: у каждой закупки свой чат и своё окно вопросов, состояние не переносится
          <Chat key={procurement.data.id} procurement={procurement.data} viewingVersion={shownVersion} onOpenVersion={openVersion} onOpenBrowser={() => setTab('browser')} />
        ) : (
          <p className={styles.loading}>Загрузка…</p>
        )}
      </section>

      <section className={styles.side} aria-label="Отчёт и браузер">
        <div className={styles.head}>
          <div className={styles.tabs} role="tablist" onKeyDown={onTabKeyDown}>
            {tabs.map((t) => (
              <button
                key={t.id}
                id={`tab-${t.id}`}
                type="button"
                role="tab"
                className={styles.tab}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'report' && reports.versions.data && reports.report.data && (
            <ReportControls
              procurementId={id}
              versions={reports.versions.data}
              report={reports.report.data}
              latest={reports.latest}
              onViewingChange={setViewing}
              onCompare={() => {
                setComparing(true)
                scrollToTop(reportPanel.current)
              }}
            />
          )}
        </div>
        <div
          id="panel-report"
          ref={reportPanel}
          role="tabpanel"
          aria-labelledby="tab-report"
          className={styles.panel}
          hidden={tab !== 'report'}
        >
          {comparing && reports.versions.data && (
            <VersionComparison procurementId={id} versions={reports.versions.data} onClose={() => setComparing(false)} />
          )}
          {procurement.data && (
            <ReportPanel
              query={reports}
              hasReport={hasReport}
              status={procurement.data.status}
              viewing={viewing}
              onViewingChange={setViewing}
            />
          )}
        </div>
        <div
          id="panel-browser"
          role="tabpanel"
          aria-labelledby="tab-browser"
          className={styles.panel}
          hidden={tab !== 'browser'}
        >
          <BrowserPanel procurementId={id} active={tab === 'browser'} />
        </div>
        <div id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" className={styles.panel} hidden={tab !== 'settings'}><LocalSettingsPanel procurementId={id} active={tab === 'settings'} /></div>
      </section>
    </div>
  )
}
