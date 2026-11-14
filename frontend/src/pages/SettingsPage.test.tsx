import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { db } from '../mocks/db'
import { server } from '../mocks/server'
import { renderApp } from '../test/render'

const exampleId = () => [...db.procurements.keys()][0]
const close = () => screen.getByRole('button', { name: 'Закрыть настройки' })

describe('настройки API', () => {
  it('сохраняет ключ и модель, очищает ключ после успеха', async () => {
    const user = userEvent.setup()
    const put = vi.spyOn(api, 'putSettings')
    renderApp('/settings')
    const key = await screen.findByLabelText('Ключ OpenRouter')
    await user.type(key, 'test-key')
    await screen.findByRole('option', { name: /OpenAI: GPT-4.1 Mini/ })
    await user.selectOptions(screen.getByLabelText('Модель'), 'openai/gpt-4.1-mini')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Настройки сохранены')).toBeInTheDocument()
    expect(put).toHaveBeenCalledWith({ openrouter_api_key: 'test-key', model: 'openai/gpt-4.1-mini' })
    expect(key).toHaveValue('')
    expect(screen.getByText('Ключ сохранён в настройках.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  })

  it('изменение модели с пустым полем ключа не удаляет ключ из окружения', async () => {
    db.settings = { has_api_key: true, key_source: 'env', model: 'old-model' }
    const put = vi.spyOn(api, 'putSettings')
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByRole('option', { name: /Anthropic: Claude Sonnet 4/ })
    await user.selectOptions(screen.getByLabelText('Модель'), 'anthropic/claude-sonnet-4')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Настройки сохранены')
    expect(put).toHaveBeenCalledWith({ model: 'anthropic/claude-sonnet-4' })
    expect(screen.getByText('Используется ключ из окружения сервера.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Удалить сохранённый ключ' })).not.toBeInTheDocument()
  })

  it('удаляет сохранённый ключ отдельной кнопкой', async () => {
    db.settings = { has_api_key: true, key_source: 'settings', model: 'm' }
    const put = vi.spyOn(api, 'putSettings')
    const user = userEvent.setup()
    renderApp('/settings')
    await user.click(await screen.findByRole('button', { name: 'Удалить сохранённый ключ' }))
    await screen.findByText('Настройки сохранены')
    expect(put).toHaveBeenCalledWith({ openrouter_api_key: '' })
    expect(screen.getByText(/Ключ не задан/)).toBeInTheDocument()
  })

  it('после ошибки сохранения сохраняет введённые значения для повторной попытки', async () => {
    server.use(http.put('/api/settings', () => HttpResponse.json({ detail: 'Ошибка сохранения' }, { status: 500 })))
    const user = userEvent.setup()
    renderApp('/settings')
    const key = await screen.findByLabelText('Ключ OpenRouter')
    await user.type(key, 'test-key')
    await screen.findByRole('option', { name: /OpenAI: GPT-4.1 Mini/ })
    await user.selectOptions(screen.getByLabelText('Модель'), 'openai/gpt-4.1-mini')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Ошибка сохранения')).toBeInTheDocument()
    expect(key).toHaveValue('test-key')
    expect(screen.getByLabelText('Модель')).toHaveValue('openai/gpt-4.1-mini')
  })

  it('ищет по названию и ID, сохраняя текущую модель вне результатов', async () => {
    db.settings = { has_api_key: false, key_source: null, model: 'old-model' }
    const user = userEvent.setup()
    renderApp('/settings')
    const search = await screen.findByRole('searchbox', { name: 'Поиск модели' })
    await waitFor(() => expect(search).toBeEnabled())
    expect(screen.getByLabelText('Модель')).toHaveValue('old-model')
    await user.type(search, 'SONNET')
    expect(screen.getByRole('option', { name: /Claude Sonnet/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /GPT-4.1/ })).not.toBeInTheDocument()
    await user.clear(search)
    await user.type(search, 'openai/')
    await user.selectOptions(screen.getByLabelText('Модель'), 'openai/gpt-4.1-mini')
    await user.clear(search)
    await user.type(search, 'несуществующая модель')
    expect(screen.getByText('Модели не найдены. Измените запрос.')).toBeInTheDocument()
    expect(screen.getByLabelText('Модель')).toHaveValue('openai/gpt-4.1-mini')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Настройки сохранены')
    expect(db.settings.model).toBe('openai/gpt-4.1-mini')
  })

  it('при ошибке каталога позволяет ввести ID вручную и повторить загрузку', async () => {
    server.use(http.get('/api/settings/models', () => HttpResponse.json({ detail: 'Каталог недоступен' }, { status: 502 })))
    db.settings = { has_api_key: false, key_source: null, model: 'saved-model' }
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByText('Каталог недоступен')
    const model = screen.getByLabelText('Модель')
    expect(model).toHaveValue('saved-model')
    await user.clear(model)
    await user.type(model, 'custom/model')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Настройки сохранены')
    expect(db.settings.model).toBe('custom/model')
    server.resetHandlers()
    await user.click(screen.getByRole('button', { name: 'Обновить список моделей' }))
    await screen.findByRole('option', { name: /OpenAI: GPT-4.1 Mini/ })
    expect(screen.getByLabelText('Модель')).toHaveValue('custom/model')
    expect(screen.queryByText('Каталог недоступен')).not.toBeInTheDocument()
  })

  it('при пустом каталоге сохраняет ручной ввод', async () => {
    server.use(http.get('/api/settings/models', () => HttpResponse.json([])))
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByText('В каталоге нет текстовых моделей. Укажите ID вручную.')
    await user.type(screen.getByLabelText('Модель'), 'custom/model')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Настройки сохранены')
    expect(db.settings.model).toBe('custom/model')
  })

  it('повторяет загрузку после потери связи', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.error()))
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByText(/Нет связи с сервером/)
    server.resetHandlers()
    await user.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(screen.getByLabelText('Ключ OpenRouter')).toBeInTheDocument())
  })
})

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
