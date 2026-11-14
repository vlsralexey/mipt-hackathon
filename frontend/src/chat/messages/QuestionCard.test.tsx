import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import type { Question } from '../../api/types'
import { ChatContext } from '../context'
import { QuestionCard } from './QuestionCard'

const question: Question = { id: 'q1', position_index: 1, text: 'Учитывать аналоги?', options: ['Да', 'Нет'], hint: null, default_answer: 'Нет', answer: null }
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content = (answer: string | null) => <QueryClientProvider client={client}><ChatContext.Provider value={{ procurementId: 'p1', openVersion: vi.fn() }}><QuestionCard data={{ ...question, answer }} /></ChatContext.Provider></QueryClientProvider>
  return { ...render(content(null)), content, client }
}
describe('состояние ответа на вопрос', () => {
  it('выделяет кнопку до ответа сервера и удерживает выбор после 202 до подтверждения SSE', async () => {
    let resolve!: (value: unknown) => void
    vi.spyOn(api, 'answerQuestion').mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const view = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Да' }))
    expect(screen.getByRole('button', { name: 'Да', pressed: true })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Сохраняем ответ')
    await act(async () => resolve({}))
    expect(await screen.findByText('Ответ принят, применяем…')).toBeInTheDocument()
    view.rerender(view.content(null))
    expect(screen.getByRole('button', { name: 'Да', pressed: true })).toBeDisabled()
    view.rerender(view.content('Да'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Да', pressed: true })).toBeEnabled())
    expect(screen.queryByText('Ответ принят, применяем…')).not.toBeInTheDocument()
  })
  it('возвращает прежний выбор и показывает причину при отказе сервера', async () => {
    vi.spyOn(api, 'answerQuestion').mockRejectedValueOnce(new Error('Не удалось сохранить ответ'))
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'Да' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить ответ')
    expect(screen.getByRole('button', { name: 'Да', pressed: false })).toBeEnabled()
  })
  it('не восстанавливает ожидание, если SSE подтвердил ответ раньше HTTP 202', async () => {
    let resolve!: (value: unknown) => void
    vi.spyOn(api, 'answerQuestion').mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const view = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Да' }))
    view.rerender(view.content('Да'))
    await waitFor(() => expect(view.client.getQueryData(['question-answer', 'p1', 'q1'])).toBeNull())
    // Старая копия закупки из параллельного GET не должна оживить уже подтверждённый pending.
    view.rerender(view.content(null))
    await act(async () => resolve({}))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Да' })).toBeEnabled())
    expect(screen.queryByText('Ответ принят, применяем…')).not.toBeInTheDocument()
  })

})
