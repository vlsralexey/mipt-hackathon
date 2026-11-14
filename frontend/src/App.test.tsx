import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from './test/render'

const TITLE = /Поставка бумаги/

describe('оболочка', () => {
  it('показывает навигацию со списком закупок и подписью под названием', async () => {
    renderApp('/')
    const nav = screen.getByRole('navigation', { name: 'Закупки' })
    const item = await within(nav).findByRole('link', { name: TITLE })
    expect(item).toHaveAttribute('href', expect.stringMatching(/^\/p\//))
    // подпись: дата и время обновления, а не число позиций без обоснования
    expect(item).toHaveTextContent(/13 ноября.*10:20/)
    expect(item).not.toHaveTextContent(/обоснован/)
    expect(within(nav).getByRole('link', { name: /Новая закупка/ })).toHaveAttribute('href', '/new')
    expect(within(nav).getByRole('link', { name: /Настройки/ })).toHaveAttribute('href', '/settings')
    // по умолчанию открыта страница новой закупки
    expect(screen.getByRole('heading', { name: 'Новая закупка', level: 1 })).toBeInTheDocument()
    // цвет один, оранжевый: переключателя тем в навигации нет
    expect(within(nav).queryByRole('group', { name: 'Цветовая тема' })).not.toBeInTheDocument()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('открывает закупку по клику: заголовок чата, активный пункт, вкладки панели', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await user.click(await screen.findByRole('link', { name: TITLE }))

    expect(await screen.findByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: TITLE })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('region', { name: 'Чат с агентом' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Отчёт', selected: true })).toBeInTheDocument()
  })

  it('переключает вкладки «Отчёт» и «Браузер» мышью и стрелками', async () => {
    const user = userEvent.setup()
    const [{ id }] = await (await fetch('/api/procurements')).json()
    renderApp(`/p/${id}`)

    const report = await screen.findByRole('tab', { name: 'Отчёт' })
    const browser = screen.getByRole('tab', { name: 'Браузер' })
    await user.click(browser)
    expect(browser).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Браузер' })).toBeVisible()

    report.focus()
    await user.click(report)
    await user.keyboard('{ArrowRight}')
    expect(browser).toHaveAttribute('aria-selected', 'true')
    expect(browser).toHaveFocus()
  })

  it('говорит, что закупки нет, если открыт неизвестный адрес закупки', async () => {
    renderApp('/p/нет-такой')
    expect(await screen.findByRole('alert')).toHaveTextContent('Закупка не найдена')
  })

  it('открывает страницы «Новая закупка» и «Настройки»', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await user.click(screen.getByRole('link', { name: /Новая закупка/ }))
    expect(screen.getByRole('heading', { name: 'Новая закупка', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Техническое задание' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: /Настройки/ }))
    expect(screen.getByRole('heading', { name: 'Настройки', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Настройки/ })).toHaveAttribute('aria-current', 'page')
  })
})
