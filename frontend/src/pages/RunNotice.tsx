import { useMutation } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, ApiError } from '../api/client'
import { Icon } from '../components/Icon'
import styles from './RunNotice.module.css'

interface RunNoticeProps {
  procurementId: string
  message: string
  /** Запуск удался (или уже идёт) — уведомление больше не нужно. */
  onResolved: () => void
  /** Повторный запуск снова не удался: показываем новый текст ошибки. */
  onFailed: (message: string) => void
}

/** Поиск не запустился, хотя закупка создана: объясняем причину и даём повторить. */
export function RunNotice({ procurementId, message, onResolved, onFailed }: RunNoticeProps) {
  const retry = useMutation({
    mutationFn: () => api.runProcurement(procurementId),
    onSuccess: onResolved,
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) onResolved()
      else onFailed(e.message)
    },
  })

  return (
    <div className={styles.notice} role="alert">
      <Icon name="alert" />
      <p>{message}</p>
      <div className={styles.actions}>
        <Link to="/settings" className={styles.link}>
          Настройки
        </Link>
        <button type="button" className={styles.btn} disabled={retry.isPending} onClick={() => retry.mutate()}>
          Повторить запуск
        </button>
      </div>
    </div>
  )
}
