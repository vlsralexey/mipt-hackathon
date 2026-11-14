import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { db } from '../mocks/db'
import { renderApp } from '../test/render'

const exampleId = () => [...db.procurements.keys()][0]
const close = () => screen.getByRole('button', { name: 'Закрыть настройки' })

describe('выход из настроек', () => {
  it('крестик возвращает на страницу закупки, откуда пришли', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await screen.findByRole('region', { name: 'Чат с агентом' })
    await user.click(screen.getByRole('link', { name: /Настройки/ }))
    expect(screen.getByRole('heading', { name: 'Настройки', level: 1 })).toBeInTheDocument()

    await user.click(close())
    expect(await screen.findByRole('region', { name: 'Чат с агентом' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Настройки' })).not.toBeInTheDocument()
  })

  it('возвращает на «Новую закупку», если пришли оттуда', async () => {
    const user = userEvent.setup()
    renderApp('/new')
    await user.click(screen.getByRole('link', { name: /Настройки/ }))
    await user.click(close())
    expect(screen.getByRole('heading', { name: 'Новая закупка', level: 1 })).toBeInTheDocument()
  })

  it('Esc делает то же, что крестик', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await screen.findByRole('region', { name: 'Чат с агентом' })
    await user.click(screen.getByRole('link', { name: /Настройки/ }))
    await user.keyboard('{Escape}')
    expect(await screen.findByRole('region', { name: 'Чат с агентом' })).toBeInTheDocument()
  })

  it('страница открыта напрямую: крестик ведёт на главную, а не из приложения', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    await user.click(close())
    expect(screen.getByRole('heading', { name: 'Выберите закупку' })).toBeInTheDocument()
  })

  it('несколько переходов подряд: крестик возвращает на один шаг, а не в начало', async () => {
    const user = userEvent.setup()
    renderApp(['/', `/p/${exampleId()}`])
    await screen.findByRole('region', { name: 'Чат с агентом' })
    await user.click(screen.getByRole('link', { name: /Настройки/ }))
    await user.click(close())
    expect(await screen.findByRole('region', { name: 'Чат с агентом' })).toBeInTheDocument()
  })
})
