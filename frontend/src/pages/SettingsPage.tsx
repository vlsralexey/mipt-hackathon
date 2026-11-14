import { useEffect } from 'react'
import { Icon } from '../components/Icon'
import { useGoBack } from '../useGoBack'
import styles from './SettingsPage.module.css'

/** Настройки: пока заглушка (этап 5), но колонка, заголовок и выход назад уже на месте. */
export function SettingsPage() {
  const goBack = useGoBack()

  // Esc закрывает страницу, если его не обработали раньше (например, список или поле)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) goBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBack])

  return (
    <div className={styles.page}>
      <button type="button" className={styles.close} aria-label="Закрыть настройки" title="Закрыть (Esc)" onClick={goBack}>
        <Icon name="x" />
      </button>
      <div className={styles.scroll}>
        <div className={styles.column}>
          <h1>Настройки</h1>
          <p>Ключ OpenRouter и модель появятся на этапе настроек.</p>
        </div>
      </div>
    </div>
  )
}
