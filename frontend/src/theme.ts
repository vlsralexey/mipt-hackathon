/** Цветовые темы. Переключатель временный: нужен, чтобы выбрать акцент на живых экранах. */
export type Theme = 'orange' | 'cherry'

export const themes: { id: Theme; label: string }[] = [
  { id: 'orange', label: 'Оранжевая' },
  { id: 'cherry', label: 'Вишнёвая' },
]

const KEY = 'nmck-theme'

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'cherry' ? 'cherry' : 'orange'
  } catch {
    return 'orange' // хранилище может быть закрыто настройками браузера
  }
}

export function applyTheme(theme: Theme) {
  if (theme === 'orange') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // тема просто не запомнится
  }
}
