import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { Message } from '../api/types'
import { db } from '../mocks/db'
import { mockTiming } from '../mocks/handlers'
import { server } from '../mocks/server'
import { renderApp } from '../test/render'

const exampleId = () => [...db.procurements.keys()][0]
const chat = () => screen.findByRole('region', { name: 'Чат с агентом' })

beforeEach(() => {
  mockTiming.agentReplyMs = 20
  mockTiming.stepMs = 20
})

describe('история чата из примера контракта', () => {
  it('показывает все виды сообщений', async () => {
    renderApp(`/p/${exampleId()}`)
    const region = within(await chat())

    // файл и подпись пользователя
    expect(await region.findByText('ТЗ поставка бумаги.docx')).toBeInTheDocument()
    expect(region.getByText('42 КБ')).toBeInTheDocument()
    expect(region.getByText('Обоснуй НМЦК по этому ТЗ.')).toBeInTheDocument()
    // разбор ТЗ: пояснение и позиции с количеством
    expect(region.getByText(/В ТЗ две позиции/)).toBeInTheDocument()
    const positions = region.getByRole('list', { name: 'Позиции ТЗ' })
    expect(within(positions).getAllByRole('listitem')).toHaveLength(2)
    expect(positions).toHaveTextContent(/2\s500\s·\sпачка/)
    // пояснение к вопросу не выводится текстом, оно только подсказка при наведении
    expect(region.queryByText(/Марка названа в ТЗ/)).not.toBeInTheDocument()
    expect(region.getByText(/Учитывать аналоги без марки/)).toHaveAttribute('title', expect.stringMatching(/Марка названа в ТЗ/))
    // вопрос с вариантами и ответом по умолчанию
    expect(region.getByText(/Учитывать аналоги без марки/)).toBeInTheDocument()
    expect(region.getByRole('button', { name: 'Да, учитывать аналоги' })).toHaveAttribute('aria-pressed', 'false')
    expect(region.getByText('По умолчанию: Нет, только SvetoCopy')).toBeInTheDocument()
    // ход поиска: итог строкой, источники в раскрывающемся списке
    expect(region.getByText('Проверено 3 источника, подходят 6 цен')).toBeInTheDocument()
    expect(region.getByText('ЕИС Закупки')).toBeInTheDocument()
    // карточка версии
    expect(region.getByText('Версия 1')).toBeInTheDocument()
    expect(region.getByText(/761\s250,00\s₽/)).toBeInTheDocument()
    expect(region.getByText(/недостаточно цен/)).toBeInTheDocument()
    // причина «Первый прогон» ничего не добавляет, и её в карточке нет
    expect(region.queryByText('Первый прогон')).not.toBeInTheDocument()
    // у первого прогона нет «Отменить»
    expect(region.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument()
    // ответ агента
    expect(region.getByText(/Позиция 1 посчитана/)).toBeInTheDocument()
  })
})

describe('ответ на вопрос кнопкой', () => {
  it('отправляет ответ и подсвечивает выбранный вариант по событию SSE', async () => {
    const user = userEvent.setup()
    const answer = vi.spyOn(api, 'answerQuestion')
    const id = exampleId()
    renderApp(`/p/${id}`)
    const button = await screen.findByRole('button', { name: 'Да, учитывать аналоги' })
    await user.click(button)

    expect(answer).toHaveBeenCalledWith(id, 'q1-1', 'Да, учитывать аналоги')
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.queryByText(/По умолчанию:/)).not.toBeInTheDocument()
  })

  it('показывает свой текст ответа под вопросом', async () => {
    const id = exampleId()
    const question = db.procurements.get(id)!.messages.find((m) => m.kind === 'question')!
    db.addMessage(id, { ...question, data: { ...(question.data as object), answer: 'Только 80 г/м²' } } as Message)
    renderApp(`/p/${id}`)
    expect(await screen.findByText('Ваш ответ: Только 80 г/м²')).toBeInTheDocument()
  })

  it('при ошибке показывает текст из API', async () => {
    server.use(
      http.post('/api/procurements/:id/questions/:qid/answer', () =>
        HttpResponse.json({ detail: 'Вопрос уже закрыт' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await user.click(await screen.findByRole('button', { name: 'Да, учитывать аналоги' }))
    expect(await screen.findByText('Вопрос уже закрыт')).toBeInTheDocument()
  })
})

describe('сообщения пользователя', () => {
  it('отправляет с версией отчёта, показывает сразу, ответ агента приходит по SSE', async () => {
    mockTiming.agentReplyMs = 400 // индикатор должен успеть показаться
    const user = userEvent.setup()
    const send = vi.spyOn(api, 'sendMessage')
    const id = exampleId()
    renderApp(`/p/${id}`)
    const field = await screen.findByRole('textbox', { name: 'Сообщение агенту' })
    await user.type(field, 'Исключи контракт 3810{Enter}')

    expect(send).toHaveBeenCalledWith(id, 'Исключи контракт 3810', 1)
    expect(field).toHaveValue('')
    const region = within(await chat())
    expect(await region.findByText('Исключи контракт 3810')).toBeInTheDocument()
    // индикатор «агент думает» появляется и исчезает вместе с ответом
    expect(await region.findByText(/Агент думает/)).toBeInTheDocument()
    expect(await region.findByText(/ответ-заглушка/)).toBeInTheDocument()
    await waitFor(() => expect(region.queryByText(/Агент думает/)).not.toBeInTheDocument())
    // сообщение пользователя не задвоилось после SSE
    expect(region.getAllByText('Исключи контракт 3810')).toHaveLength(1)
  })

  it('можно писать, пока агент занят', async () => {
    db.procurements.get(exampleId())!.agent_busy = true
    renderApp(`/p/${exampleId()}`)
    expect(await screen.findByText(/Агент думает/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Сообщение агенту' })).toBeEnabled()
  })

  it('при ошибке возвращает текст в поле и показывает причину', async () => {
    server.use(
      http.post('/api/procurements/:id/messages', () =>
        HttpResponse.json({ detail: 'Пустое сообщение' }, { status: 400 }),
      ),
    )
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    const field = await screen.findByRole('textbox', { name: 'Сообщение агенту' })
    await user.type(field, 'вопрос{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Пустое сообщение')
    expect(field).toHaveValue('вопрос')
  })
})

describe('события SSE', () => {
  it('новая версия с кнопкой «Отменить» отменяет все свои правки', async () => {
    const user = userEvent.setup()
    const cancel = vi.spyOn(api, 'cancelEdits')
    const id = exampleId()
    renderApp(`/p/${id}`)
    await screen.findByText('Версия 1')

    db.addMessage(id, {
      id: 'm_v2',
      created_at: new Date().toISOString(),
      role: 'system',
      kind: 'version',
      text: null,
      data: {
        version: 2,
        cause: 'Исключено: Дистрибьютор «Регион», каталог, «поставка б/у»',
        edit_ids: ['ed_01'],
        cancellable: true,
        diff: {
          from_version: 1,
          to_version: 2,
          total: { before: null, after: null },
          total_justified: { before: '761250.00', after: null },
          positions: [],
          offers_moved: [
            {
              offer_id: 'o1',
              label: '1.5',
              caption: 'Дистрибьютор «Регион», каталог',
              position_index: 1,
              to: 'excluded',
              reason: 'Исключено вами: поставка б/у',
            },
          ],
          edits_added: ['ed_01'],
          edits_cancelled: [],
          rules_changed: [],
        },
      },
    })

    expect(await screen.findByText('Версия 2')).toBeInTheDocument()
    // у следующих версий причина показана
    expect(screen.getByText(/Исключено: Дистрибьютор «Регион», каталог, «поставка б\/у»/, { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(/761\s250,00\s₽\s→\sнет/)).toBeInTheDocument()
    expect(screen.getByText(/Исключено: 1\.5 Дистрибьютор/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(cancel).toHaveBeenCalledWith(id, ['ed_01'])
  })

  it('заменяет сообщение на месте: ход поиска обновляется без дубля', async () => {
    const id = exampleId()
    renderApp(`/p/${id}`)
    await screen.findByText('Проверено 3 источника, подходят 6 цен')
    const run = db.procurements.get(id)!.messages.find((m) => m.kind === 'run')!
    db.addMessage(id, { ...run, data: { ...(run.data as object), summary: 'Проверено 4 источника' } } as Message)
    expect(await screen.findByText('Проверено 4 источника')).toBeInTheDocument()
    expect(screen.queryByText('Проверено 3 источника, подходят 6 цен')).not.toBeInTheDocument()
  })

  it('на каждое подключение заново запрашивает закупку', async () => {
    const get = vi.spyOn(api, 'getProcurement')
    renderApp(`/p/${exampleId()}`)
    await screen.findByText('Версия 1')
    // загрузка при открытии и повторный запрос по событию open потока
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('после обрыва SSE получает пропущенную версию уже открытого отчёта', async () => {
    const source = Object.assign(new EventTarget(), { close: vi.fn() })
    vi.spyOn(globalThis, 'EventSource').mockImplementation(function () {
      return source as unknown as EventSource
    })
    const id = exampleId()
    renderApp(`/p/${id}`)
    await screen.findByRole('option', { name: 'Версия 1' })
    // Сервер закончил правку, пока клиент не получал события.
    db.reports.get(id)!.push({ ...structuredClone(db.reports.get(id)![0]), version: 2 })
    db.procurements.get(id)!.latest_version = 2
    act(() => source.dispatchEvent(new Event('open')))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Версия отчёта' })).toHaveValue('2'))
    expect(screen.getByRole('option', { name: 'Версия 2' })).toBeInTheDocument()
  })

  it('сообщение неизвестного вида и ошибка прогона не ломают чат', async () => {
    const id = exampleId()
    renderApp(`/p/${id}`)
    await screen.findByText('Версия 1')
    db.addMessage(id, {
      id: 'm_x',
      created_at: new Date().toISOString(),
      role: 'agent',
      kind: 'future_kind',
      text: 'Новое сообщение',
      data: {},
    } as unknown as Message)
    db.addMessage(id, {
      id: 'm_e',
      created_at: new Date().toISOString(),
      role: 'system',
      kind: 'error',
      text: 'Ключ OpenRouter недействителен',
      data: { code: 'llm_auth' },
    })
    expect(await screen.findByText('Новое сообщение')).toBeInTheDocument()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Ключ OpenRouter недействителен')
    expect(within(alert).getByRole('link', { name: 'Открыть настройки' })).toHaveAttribute('href', '/settings')
  })
})

describe('первый прогон на моках', () => {
  it('разбор ТЗ → ход поиска → версия 1 приходят по SSE, закупка становится готовой', async () => {
    db.settings = { has_api_key: true, key_source: 'settings', model: 'm' }
    const user = userEvent.setup()
    renderApp('/new')
    await user.type(screen.getByRole('textbox', { name: 'Техническое задание' }), 'Бумага А4')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    const region = within(await chat())
    expect(await region.findByText('Версия 1', undefined, { timeout: 3000 })).toBeInTheDocument()
    expect(region.getByRole('list', { name: 'Позиции ТЗ' })).toBeInTheDocument()
    expect(region.getByText('Проверено 3 источника, подходят 6 цен')).toBeInTheDocument()
    expect(region.getAllByText(/Проверено|Ищу/)).toHaveLength(1)
    // в навигации у закупки уже подпись по итогам, а не «Идёт поиск»
    const nav = screen.getByRole('navigation', { name: 'Закупки' })
    await waitFor(() => expect(within(nav).queryByText('Идёт поиск')).not.toBeInTheDocument())
  })
})
