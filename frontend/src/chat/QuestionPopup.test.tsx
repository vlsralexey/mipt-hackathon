import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { Message } from '../api/types'
import { db } from '../mocks/db'
import { server } from '../mocks/server'
import { renderApp } from '../test/render'
import { waitingLabel } from './waiting'

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

function analog(n: number): Message {
  const message = question(n)
  if (message.kind !== 'question') throw new Error('Expected question')
  return { ...message, data: { ...message.data, position_index: n, text: 'Допускается ли замена бумаги SvetoCopy на аналоги?' } }
}

/** Отвечает на вопросы из примера, чтобы проверять окно только на новых вопросах. */
function answerHistory() {
  for (const m of db.procurements.get(exampleId())!.messages) {
    if (m.kind === 'question' && m.data.answer === null) m.data.answer = m.data.default_answer
  }
}

/** Открывает закупку и ждёт, пока чат подключится к потоку событий. */
async function open({ history = false } = {}) {
  if (!history) answerHistory()
  const view = renderApp(`/p/${exampleId()}`)
  await screen.findByText('Версия 1', { selector: 'b' })
  // событие open потока означает, что подписка уже работает
  await waitFor(() => expect(db.procurements.get(exampleId())).toBeDefined())
  await new Promise((r) => setTimeout(r, 60))
  return view
}

const popup = () => screen.findByRole('dialog', { name: 'Уточняющий вопрос' })
const feed = () => within(screen.getByRole('region', { name: 'Чат с агентом' }).querySelector('[class*="thread"]') as HTMLElement)

describe('окно уточняющих вопросов', () => {
  it('показывает номер, позицию, вариант по умолчанию и не перехватывает фокус', async () => {
    await open()
    const composer = screen.getByRole('textbox', { name: 'Сообщение агенту' })
    composer.focus()
    db.addMessage(exampleId(), question(1))

    const dialog = await popup()
    expect(dialog).not.toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByText('Вопрос 1 из 1 · позиция 2, Бумага писчая офсетная А4')).toBeInTheDocument()
    expect(within(dialog).getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Да по умолчанию' })).toHaveAttribute('aria-keyshortcuts', '1')
    expect(within(dialog).getByRole('button', { name: 'Нет' })).toHaveAttribute('aria-keyshortcuts', '2')
    expect(within(dialog).getByText('Без ответа агент продолжит с вариантом по умолчанию.')).toBeInTheDocument()
    expect(composer).toHaveFocus()
    // смену вопроса слышно в программе чтения с экрана
    expect(screen.getByText('Вопрос 1 из 1: Искать на маркетплейсах? (1)')).toHaveAttribute('aria-live', 'polite')
  })

  it('в ленте вопрос приглушён с подписью «открыт ниже», клик ставит окно на него', async () => {
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    db.addMessage(exampleId(), question(2))
    const dialog = await popup()
    expect(within(dialog).getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(feed().getByRole('button', { name: /Искать на маркетплейсах\? \(1\).*открыт ниже/ })).toBeInTheDocument()
    await user.click(feed().getByRole('button', { name: /Искать на маркетплейсах\? \(2\).*в очереди/ }))
    expect(within(dialog).getByText('Искать на маркетплейсах? (2)')).toBeInTheDocument()
    expect(within(dialog).getByText(/^Вопрос 2 из 2/)).toBeInTheDocument()
    expect(dialog).toHaveFocus()
  })

  it('кнопки ‹ › и стрелки листают неотвеченные вопросы', async () => {
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    db.addMessage(exampleId(), question(2))
    const dialog = await popup()
    const prev = within(dialog).getByRole('button', { name: 'Предыдущий вопрос' })
    const next = within(dialog).getByRole('button', { name: 'Следующий вопрос' })
    expect(prev).toBeDisabled()
    await user.click(next)
    expect(within(dialog).getByText('Искать на маркетплейсах? (2)')).toBeInTheDocument()
    expect(next).toBeDisabled()
    await user.keyboard('{ArrowLeft}')
    expect(within(dialog).getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(within(dialog).getByText('Искать на маркетплейсах? (2)')).toBeInTheDocument()
  })

  it('цифра выбирает вариант, когда фокус в окне или нигде, и окно переходит к следующему', async () => {
    const answer = vi.spyOn(api, 'answerQuestion')
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    db.addMessage(exampleId(), question(2))
    const dialog = await popup()
    ;(document.activeElement as HTMLElement | null)?.blur()
    await user.keyboard('2')
    expect(answer).toHaveBeenCalledWith(exampleId(), 'q2-1', 'Нет')
    await waitFor(() => expect(within(dialog).getByText('Искать на маркетплейсах? (2)')).toBeInTheDocument())
    expect(within(dialog).getByText(/^Вопрос 1 из 1/)).toBeInTheDocument()

    within(dialog).getByRole('button', { name: 'Следующий вопрос' }).focus()
    await user.keyboard('1')
    expect(answer).toHaveBeenCalledWith(exampleId(), 'q2-2', 'Да')
    // вопросов не осталось: окно исчезает, в ленте карточки с ответами
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('button', { name: 'Нет', pressed: true })).toBeInTheDocument()
  })

  it('в поле ввода цифры, стрелки и Esc остаются за полем', async () => {
    const answer = vi.spyOn(api, 'answerQuestion')
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    db.addMessage(exampleId(), question(2))
    const dialog = await popup()
    const composer = screen.getByRole('textbox', { name: 'Сообщение агенту' })
    await user.click(composer)
    await user.keyboard('12{ArrowRight}{ArrowLeft}{Escape}')
    expect(composer).toHaveValue('12')
    expect(answer).not.toHaveBeenCalled()
    expect(within(dialog).getByText(/^Вопрос 1 из 2/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('Esc сворачивает окно в строку со счётчиком, новый вопрос его не разворачивает', async () => {
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    db.addMessage(exampleId(), question(2))
    const dialog = await popup()
    within(dialog).getByRole('button', { name: 'Нет' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const pill = screen.getByRole('button', { name: /2 вопроса ждут ответа/ })
    expect(pill).toHaveFocus()
    // свёрнуто: в ленте полные карточки, ответить можно и там
    expect(feed().getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(feed().queryByText('открыт ниже')).not.toBeInTheDocument()

    db.addMessage(exampleId(), question(3))
    expect(await screen.findByRole('button', { name: /3 вопроса ждут ответа/ })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /ждут ответа Открыть/ }))
    expect(within(await popup()).getByText(/^Вопрос 1 из 3/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('кнопка «Свернуть» тоже сворачивает, а свёрнутость помнится в этой закупке', async () => {
    const user = userEvent.setup()
    const first = await open()
    db.addMessage(exampleId(), question(1))
    await user.click(within(await popup()).getByRole('button', { name: 'Свернуть' }))
    expect(screen.getByRole('button', { name: /1 вопрос ждёт ответа/ })).toBeInTheDocument()

    first.unmount()
    // старые вопросы уже отвечены первым открытием, новый должен остаться в счётчике
    await open({ history: true })
    expect(screen.getByRole('button', { name: /1 вопрос ждёт ответа/ })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ответ в ленте при свёрнутом окне убирает вопрос из счётчика', async () => {
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    db.addMessage(exampleId(), question(2))
    await user.click(within(await popup()).getByRole('button', { name: 'Свернуть' }))
    const card = feed().getByText('Искать на маркетплейсах? (1)').parentElement as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Нет' }))
    expect(await screen.findByRole('button', { name: /1 вопрос ждёт ответа/ })).toBeInTheDocument()
  })

  it('флажок «Тот же ответ» отвечает сразу на одинаковые вопросы А4 и А3', async () => {
    const user = userEvent.setup()
    const answer = vi.spyOn(api, 'answerQuestion')
    await open()
    db.addMessage(exampleId(), analog(1))
    db.addMessage(exampleId(), analog(2))
    const dialog = await popup()
    expect(within(dialog).getByText(/^Вопрос 1 из 2 · позиция 1, Бумага А4 SvetoCopy$/)).toBeInTheDocument()
    const same = within(dialog).getByRole('checkbox', { name: 'Тот же ответ для позиции 2, Бумага писчая офсетная А4' })
    expect(same).not.toBeChecked()
    await user.click(same)
    await user.click(within(dialog).getByRole('button', { name: 'Нет' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(answer).toHaveBeenCalledWith(exampleId(), 'q2-1', 'Нет')
    expect(answer).toHaveBeenCalledWith(exampleId(), 'q2-2', 'Нет')
    const messages = db.procurements.get(exampleId())!.messages
    expect(messages.filter((m) => m.kind === 'question' && m.data.answer === 'Нет')).toHaveLength(2)
  })

  it('без флажка решения для разных позиций отдельные', async () => {
    const user = userEvent.setup()
    const answer = vi.spyOn(api, 'answerQuestion')
    await open()
    db.addMessage(exampleId(), analog(1))
    db.addMessage(exampleId(), analog(2))
    const dialog = await popup()
    await user.click(within(dialog).getByRole('button', { name: /^Да/ }))
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText(/позиция 2,/)).toBeInTheDocument())
    expect(answer).toHaveBeenCalledWith(exampleId(), 'q2-1', 'Да')
    expect(answer).not.toHaveBeenCalledWith(exampleId(), 'q2-2', expect.anything())
  })

  it('вопрос, который уже был в чате при открытии, окно не разворачивает, но учтён в счётчике', async () => {
    const user = userEvent.setup()
    await open({ history: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(feed().getByText(/Учитывать аналоги без марки/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /1 вопрос ждёт ответа/ }))
    expect(within(await popup()).getByText(/Учитывать аналоги без марки/)).toBeInTheDocument()
  })

  it('счётчик после перезагрузки учитывает старые и новые неотвеченные вопросы', async () => {
    const user = userEvent.setup()
    const first = await open({ history: true })
    db.addMessage(exampleId(), question(1))
    // новый вопрос разворачивает окно на себе, старый тоже в нём
    const dialog = await popup()
    expect(within(dialog).getByText(/^Вопрос 2 из 2/)).toBeInTheDocument()
    expect(within(dialog).getByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Свернуть' }))
    expect(screen.getByRole('button', { name: /2 вопроса ждут ответа/ })).toBeInTheDocument()

    first.unmount()
    sessionStorage.clear()
    await open({ history: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2 вопроса ждут ответа/ })).toBeInTheDocument()
  })

  it('вопрос, на который уже ответили, в окно не попадает', async () => {
    await open()
    db.addMessage(exampleId(), question(1, { answer: 'Нет' }))
    expect(await screen.findByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('вопрос с одним вариантом в окно не попадает: выбирать нечего, он остаётся в ленте', async () => {
    await open()
    const single = question(1)
    if (single.kind !== 'question') throw new Error('Expected question')
    db.addMessage(exampleId(), { ...single, data: { ...single.data, options: ['Да'] } })
    expect(await screen.findByText('Искать на маркетплейсах? (1)')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /ждёт ответа/ })).not.toBeInTheDocument()
  })

  it('если ответ не принят, окно остаётся и показывает причину', async () => {
    server.use(
      http.post('/api/procurements/:id/questions/:qid/answer', () =>
        HttpResponse.json({ detail: 'Вопрос уже закрыт' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    await open()
    db.addMessage(exampleId(), question(1))
    const dialog = await popup()
    await user.click(within(dialog).getByRole('button', { name: /^Да/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Вопрос уже закрыт')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('счётчик вопросов', () => {
  it.each([
    [1, '1 вопрос ждёт ответа'],
    [2, '2 вопроса ждут ответа'],
    [4, '4 вопроса ждут ответа'],
    [5, '5 вопросов ждут ответа'],
    [11, '11 вопросов ждут ответа'],
    [21, '21 вопрос ждёт ответа'],
    [22, '22 вопроса ждут ответа'],
  ])('%i → %s', (n, label) => {
    expect(waitingLabel(n)).toBe(label)
  })
})
