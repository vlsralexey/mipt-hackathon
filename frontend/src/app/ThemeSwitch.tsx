import { useState } from 'react'
import { applyTheme, loadTheme, themes, type Theme } from '../theme'
import styles from './ThemeSwitch.module.css'

/** Два кружка внизу навигации: сравнить цветовые темы. После выбора акцента будет убран. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(loadTheme)

  function choose(next: Theme) {
    setTheme(next)
    applyTheme(next)
  }

  return (
    <div className={styles.switch} role="group" aria-label="Цветовая тема">
      {themes.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`${styles.swatch} ${styles[t.id]}`}
          aria-pressed={theme === t.id}
          aria-label={t.label}
          title={t.label}
          onClick={() => choose(t.id)}
        />
      ))}
    </div>
  )
}
