import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db } from './mocks/db'
import { renderApp } from './test/render'

// Правило проекта: длинные тире (— и –) в интерфейсе не используем. Тексты от бэкенда
// приходят готовыми, поэтому проверяем и данные примеров контракта.
const DASH = /[—–]/

describe('интерфейс без длинных тире', () => {
  it('экран закупки: чат и отчёт целиком, со всеми раскрытыми разделами', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${[...db.procurements.keys()][0]}`)
    await screen.findByRole('article', { name: 'Отчёт' })
    for (const summary of document.querySelectorAll('summary')) await user.click(summary)
    expect(document.body.textContent).not.toMatch(DASH)
  })

  it('пустые значения и новая закупка', async () => {
    const id = [...db.procurements.keys()][0]
    db.reports.get(id)![0].positions[1].included[0].offer.price_date = null
    db.reports.get(id)![0].total = null
    renderApp(`/p/${id}`)
    await screen.findByRole('article', { name: 'Отчёт' })
    await waitFor(() => expect(document.body.textContent).toContain('нет'))
    expect(document.body.textContent).not.toMatch(DASH)
  })

  it('стартовый экран', () => {
    renderApp('/new')
    expect(document.body.textContent).not.toMatch(DASH)
  })
})
