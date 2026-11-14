import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { db } from '../mocks/db'
import { mockTiming } from '../mocks/handlers'
import { server } from '../mocks/server'
import { renderApp } from '../test/render'

const exampleId = () => [...db.procurements.keys()][0]
const close = () => screen.getByRole('button', { name: 'Закрыть настройки' })
const modelButton = () => screen.findByRole('button', { name: /Модель агента/ })
const replyMs = mockTiming.agentReplyMs
afterEach(() => { mockTiming.agentReplyMs = replyMs })

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await modelButton()
  await waitFor(() => expect(trigger).toBeEnabled())
  await user.click(trigger)
  return trigger
}

describe('ключ OpenRouter', () => {
  it('без ключа сразу показывает поле; сохраняет ключ и очищает поле', async () => {
    const user = userEvent.setup()
    const put = vi.spyOn(api, 'putSettings')
    renderApp('/settings')
    const key = await screen.findByLabelText('Ключ OpenRouter')
    expect(screen.getByText('Не задан')).toBeInTheDocument()
    await user.type(key, 'test-key')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText(/сохранён в настройках/)
    expect(put).toHaveBeenCalledWith({ openrouter_api_key: 'test-key' })
    expect(screen.queryByLabelText('Ключ OpenRouter')).not.toBeInTheDocument()
    expect(screen.getByText('Не проверен')).toBeInTheDocument()
  })

  it('сохранённый ключ не подгружается: «Заменить ключ» открывает пустое поле, «Отмена» и Esc закрывают', async () => {
    db.settings = { has_api_key: true, key_source: 'env', model: 'm' }
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByText(/из окружения сервера/)
    expect(screen.queryByRole('button', { name: 'Удалить сохранённый ключ' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Заменить ключ' }))
    const key = screen.getByLabelText('Ключ OpenRouter')
    expect(key).toHaveValue('')
    expect(key).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(screen.queryByLabelText('Ключ OpenRouter')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Заменить ключ' }))
    await user.type(screen.getByLabelText('Ключ OpenRouter'), 'x{Escape}')
    expect(screen.queryByLabelText('Ключ OpenRouter')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Настройки', level: 1 })).toBeInTheDocument()
  })

  it('проверка показывает результат в строке статуса', async () => {
    db.settings = { has_api_key: true, key_source: 'env', model: 'm' }
    const user = userEvent.setup()
    renderApp('/settings')
    await user.click(await screen.findByRole('button', { name: 'Проверить' }))
    expect(await screen.findByText('Работает')).toBeInTheDocument()
    server.use(http.post('/api/settings/check', () => HttpResponse.json({ ok: false, detail: 'Ключ отклонён' })))
    await user.click(screen.getByRole('button', { name: 'Проверить' }))
    expect(await screen.findByText('Ключ отклонён')).toBeInTheDocument()
  })

  it('удаляет сохранённый ключ отдельной кнопкой', async () => {
    db.settings = { has_api_key: true, key_source: 'settings', model: 'm' }
    const put = vi.spyOn(api, 'putSettings')
    const user = userEvent.setup()
    renderApp('/settings')
    await user.click(await screen.findByRole('button', { name: 'Удалить сохранённый ключ' }))
    await screen.findByText('Не задан')
    expect(put).toHaveBeenCalledWith({ openrouter_api_key: '' })
    expect(screen.getByLabelText('Ключ OpenRouter')).toHaveValue('')
  })

  it('после ошибки сохранения ключ остаётся в поле', async () => {
    server.use(http.put('/api/settings', () => HttpResponse.json({ detail: 'Ошибка сохранения' }, { status: 500 })))
    const user = userEvent.setup()
    renderApp('/settings')
    const key = await screen.findByLabelText('Ключ OpenRouter')
    await user.type(key, 'test-key{Enter}')
    expect(await screen.findByText('Ошибка сохранения')).toBeInTheDocument()
    expect(key).toHaveValue('test-key')
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

describe('выбор модели', () => {
  it('выбор мышью сохраняется сразу и не трогает ключ', async () => {
    db.settings = { has_api_key: true, key_source: 'env', model: 'openai/gpt-4.1-mini' }
    const put = vi.spyOn(api, 'putSettings')
    const user = userEvent.setup()
    renderApp('/settings')
    const trigger = await openPicker(user)
    expect(trigger).toHaveAccessibleName(/OpenAI: GPT-4.1 Mini/)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('option', { name: /Claude Sonnet 4/ }))
    expect(await screen.findByText('Сохранено')).toBeInTheDocument()
    expect(put).toHaveBeenCalledWith({ model: 'anthropic/claude-sonnet-4' })
    expect(db.settings.model).toBe('anthropic/claude-sonnet-4')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
    expect(screen.getByText(/из окружения сервера/)).toBeInTheDocument()
  })

  it('клавиатура: стрелки, Home/End, поиск по названию и ID, Enter выбирает', async () => {
    db.settings = { has_api_key: false, key_source: null, model: 'old-model' }
    const user = userEvent.setup()
    renderApp('/settings')
    const trigger = await modelButton()
    await waitFor(() => expect(trigger).toBeEnabled())
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    const search = screen.getByRole('combobox', { name: 'Найти модель' })
    expect(search).toHaveFocus()
    // Текущая модель вне каталога показана первой и активна
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('old-model')
    await user.keyboard('{End}')
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('openai/gpt-4.1-mini')
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { selected: true }).id)
    await user.keyboard('{Home}{ArrowDown}')
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('anthropic/claude-sonnet-4')
    await user.type(search, 'SONNET')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.clear(search)
    await user.type(search, 'несуществующая')
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument()
    await user.clear(search)
    await user.type(search, 'openai/')
    await user.keyboard('{Enter}')
    await screen.findByText('Сохранено')
    expect(db.settings.model).toBe('openai/gpt-4.1-mini')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('Esc закрывает только список, а не страницу', async () => {
    const put = vi.spyOn(api, 'putSettings')
    const user = userEvent.setup()
    renderApp('/settings')
    const trigger = await openPicker(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Настройки', level: 1 })).toBeInTheDocument()
    expect(put).not.toHaveBeenCalled()
  })

  it('ошибка сохранения видна, на кнопке остаётся прежняя модель', async () => {
    db.settings = { has_api_key: false, key_source: null, model: 'openai/gpt-4.1-mini' }
    server.use(http.put('/api/settings', () => HttpResponse.json({ detail: 'Ошибка сохранения' }, { status: 500 })))
    const user = userEvent.setup()
    renderApp('/settings')
    const trigger = await openPicker(user)
    await user.click(screen.getByRole('option', { name: /Claude Sonnet 4/ }))
    expect(await screen.findByText('Ошибка сохранения')).toBeInTheDocument()
    expect(trigger).toHaveAccessibleName(/GPT-4.1 Mini/)
  })

  it('при ошибке каталога позволяет ввести ID вручную и повторить загрузку', async () => {
    server.use(http.get('/api/settings/models', () => HttpResponse.json({ detail: 'Каталог недоступен' }, { status: 502 })))
    db.settings = { has_api_key: false, key_source: null, model: 'saved-model' }
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByText('Каталог недоступен')
    const model = screen.getByLabelText('Модель агента')
    expect(model).toHaveValue('saved-model')
    await user.clear(model)
    await user.type(model, 'custom/model{Enter}')
    await screen.findByText('Сохранено')
    expect(db.settings.model).toBe('custom/model')
    server.resetHandlers()
    await user.click(screen.getByRole('button', { name: 'Обновить список моделей' }))
    const trigger = await modelButton()
    expect(trigger).toHaveAccessibleName(/custom\/model/)
    expect(screen.queryByText('Каталог недоступен')).not.toBeInTheDocument()
  })

  it('при пустом каталоге сохраняет ручной ввод', async () => {
    server.use(http.get('/api/settings/models', () => HttpResponse.json([])))
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByText('В каталоге нет текстовых моделей. Укажите ID вручную.')
    await user.type(screen.getByLabelText('Модель агента'), 'custom/model')
    await user.click(screen.getAllByRole('button', { name: 'Сохранить' }).at(-1)!)
    await screen.findByText('Сохранено')
    expect(db.settings.model).toBe('custom/model')
  })
})

describe('правила, источники и агент', () => {
  it('правила и источники видны сразу, человеческими фразами, без длинных тире', async () => {
    const user = userEvent.setup()
    renderApp('/settings')
    const rules = await screen.findByRole('region', { name: 'Правила расчёта' })
    await waitFor(() => expect(rules).toHaveTextContent('Не меньше 3 цен, разброс не выше 33 %'))
    expect(rules).toHaveTextContent('От 5 цен: IQR × 1,5. Меньше: отклонение от медианы до 50 %')
    expect(rules).toHaveTextContent('По ИПЦ для цен старше 6 месяцев')
    expect(rules).toHaveTextContent('3 года')
    expect(rules).toHaveTextContent('Если цен меньше 3 или они неоднородны')
    expect(rules).toHaveTextContent(/8 страниц на источник, 15\s000 символов со страницы/)
    expect(rules).not.toHaveTextContent('Методика')
    await user.click(screen.getByRole('button', { name: 'все' }))
    expect(rules).toHaveTextContent('wildberries.ru')
    const sources = screen.getByRole('region', { name: 'Источники' })
    expect(sources).toHaveTextContent('ЕИС')
    expect(sources).toHaveTextContent('Реестр контрактов')
    expect(sources).toHaveTextContent('komus.ru')
    expect(document.body.textContent).not.toMatch(/[—–]/)
  })

  it('неизвестное правило показывается отдельной строкой', async () => {
    db.config.rules.push({ key: 'future_rule', title: 'Новое правило', value: 7, display: '7', description: '' })
    renderApp('/settings')
    const rules = await screen.findByRole('region', { name: 'Правила расчёта' })
    await waitFor(() => expect(rules).toHaveTextContent('Новое правило7'))
  })

  it('подсказка подставляет текст; предложение применяется, попадает в историю и отменяется', async () => {
    mockTiming.agentReplyMs = 10
    const user = userEvent.setup()
    renderApp('/settings')
    await screen.findByRole('complementary', { name: 'Изменить правила' })
    await user.click(screen.getByRole('button', { name: 'Разброс не выше 25 %' }))
    const field = screen.getByRole('textbox', { name: 'Сообщение агенту настроек' })
    expect(field).toHaveValue('Разброс не выше 25 %')
    expect(field).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Применить' }))
    expect(await screen.findByText('Применено')).toBeInTheDocument()
    const history = screen.getByRole('region', { name: 'История' })
    await waitFor(() => expect(history).toHaveTextContent('33 % → 25 %'))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Правила расчёта' })).toHaveTextContent('разброс не выше 25 %'))
    await user.click(screen.getByRole('button', { name: 'Отменить изменение: Порог разброса' }))
    await waitFor(() => expect(history).toHaveTextContent('Отменено'))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Правила расчёта' })).toHaveTextContent('разброс не выше 33 %'))
  })

  it('отклонённое предложение не меняет правила', async () => {
    mockTiming.agentReplyMs = 10
    const user = userEvent.setup()
    renderApp('/settings')
    await user.type(await screen.findByRole('textbox', { name: 'Сообщение агенту настроек' }), 'Порог 40{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Отклонить' }))
    expect(await screen.findByText('Отклонено')).toBeInTheDocument()
    expect(db.config.rules.find((r) => r.key === 'cv_threshold')!.display).toBe('33 %')
    expect(screen.getByText('Общие правила ещё не менялись.')).toBeInTheDocument()
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
