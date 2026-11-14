import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, loadTheme } from '../theme'
import { renderApp } from '../test/render'

afterEach(() => {
  applyTheme('orange')
  localStorage.clear()
})

describe('переключатель темы', () => {
  it('по умолчанию оранжевая; вишнёвая включается, запоминается и возвращается обратно', async () => {
    const user = userEvent.setup()
    renderApp('/')
    const orange = screen.getByRole('button', { name: 'Оранжевая' })
    const cherry = screen.getByRole('button', { name: 'Вишнёвая' })
    expect(orange).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.dataset.theme).toBeUndefined()

    await user.click(cherry)
    expect(cherry).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.dataset.theme).toBe('cherry')
    expect(loadTheme()).toBe('cherry')

    await user.click(orange)
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(loadTheme()).toBe('orange')
  })

  it('неизвестное сохранённое значение даёт оранжевую тему', () => {
    localStorage.setItem('nmck-theme', 'пурпурная')
    expect(loadTheme()).toBe('orange')
  })
})
