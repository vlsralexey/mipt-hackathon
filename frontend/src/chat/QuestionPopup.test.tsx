import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { Message } from '../api/types'
import { db } from '../mocks/db'
import { server } from '../mocks/server'
import { renderApp } from '../test/render'

const exampleId = () => [...db.procurements.keys()][0]

const question = (n: number, over: Partial<{ answer: string | null }> = {}): Message => ({
  id: `m_q${n}`,
  created_at: new Date(Date.now() + n).toISOString(),
  role: 'agent',
  kind: 'question',
  text: null,
  data: {
    id: `q2-${n}`,
    position_index: 2,
    text: `Искать на маркетплейсах? (${n})`,
    hint: null,
    options: ['Да', 'Нет'],
    default_answer: 'Да',
    answer: over.answer ?? null,
  },
})

/** Открывает закупку и ждёт, пока чат подключится к потоку событий. */
async function open() {
  renderApp(`/p/${exampleId()}`)
  await screen.findByText('Версия 1', { selector: 'b' })
  // событие open потока означает, что подписка уже работает
  await waitFor(() => expect(db.procurements.get(exampleId())).toBeDefined())
  await new Promise((r) => setTimeout(r, 60))
}

describe('всплывающий вопрос', () => {
  it('новый вопрос всплывает окошком с кнопками и не дублируется в ленте', async () => {
    await open()
    db.addMessage(exampleId(), question(1))

    const dialog = await screen.findByRole('dialog', { name: 'Вопрос агента' })
    expect(within(dialog).getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Да' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeInTheDocument()
    expect(screen.getAllByText('Искать на маркетплейсах? (1)')).toHaveLength(1)
  })

  it('ответ из окошка закрывает его, в ленте остаётся карточка с ответом', async () => {
    const user = userEvent.setup()
    const answer = vi.spyOn(api, 'answerQuestion')
    await open()
    db.addMessage(exampleId(), question(1))
    const dialog = await screen.findByRole('dialog', { name: 'Вопрос агента' })
    await user.click(within(dialog).getByRole('button', { name: 'Нет' }))

    expect(answer).toHaveBeenCalledWith(exampleId(), 'q2-1', 'Нет')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('button', { name: 'Нет', pressed: true })).toBeInTheDocument()
    expect(screen.getAllByText('Искать на маркетплейсах? (1)')).toHaveLength(1)
  })

  it('крестик закрывает окошко без ответа, вопрос появляется в ленте с ответом по умолчанию', async () => {
    const user = userEvent.setup()
    const answer = vi.spyOn(api, 'answerQuestion')
    await open()
    db.addMessage(exampleId(), question(1))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Закрыть' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(answer).not.toHaveBeenCalled()
    expect(screen.getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    // у каждой карточки с вопросом своя подпись: этот вопрос и вопрос из примера
    expect(screen.getAllByText('По умолчанию: Да')).toHaveLength(1)
  })

  it('Esc тоже закрывает окошко', async () => {
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    const dialog = await screen.findByRole('dialog')
    within(dialog).getByRole('button', { name: 'Да' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
  })

  it('вопросы идут по очереди: пока открыт первый, второй ждёт и в ленте не виден', async () => {
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    db.addMessage(exampleId(), question(2))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(screen.queryByText('Искать на маркетплейсах? (2)')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Закрыть' }))
    expect(await screen.findByText('Искать на маркетплейсах? (2)')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByText('Искать на маркетплейсах? (2)')).toBeInTheDocument()
    // закрытый первый теперь в ленте
    expect(screen.getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
  })

  it('вопрос, который уже был в чате при открытии, не всплывает', async () => {
    await open()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const chat = within(screen.getByRole('region', { name: 'Чат с агентом' }))
    expect(chat.getByText(/Учитывать аналоги без марки/)).toBeInTheDocument()
  })

  it('вопрос, на который уже ответили, не всплывает', async () => {
    await open()
    db.addMessage(exampleId(), question(1, { answer: 'Нет' }))
    expect(await screen.findByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('если ответ не принят, окошко остаётся и показывает причину', async () => {
    server.use(
      http.post('/api/procurements/:id/questions/:qid/answer', () =>
        HttpResponse.json({ detail: 'Вопрос уже закрыт' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Да' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Вопрос уже закрыт')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
