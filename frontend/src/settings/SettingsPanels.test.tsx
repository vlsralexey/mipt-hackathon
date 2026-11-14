import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { VersionDiff } from '../api/types'
import { ProposalActions } from '../chat/messages/NoteCards'
import { LocalSettingsPanel } from './LocalSettingsPanel'
import { GlobalSettingsPanel } from './GlobalSettingsPanel'
afterEach(() => vi.unstubAllGlobals())
const diff: VersionDiff = { from_version: 1, to_version: 2, total: { before: '300.00', after: '400.00' }, total_justified: { before: '300.00', after: '400.00' }, positions: [], offers_moved: [], edits_added: [], edits_cancelled: [], rules_changed: [] }
function wrap(content: React.ReactNode) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{content}</QueryClientProvider>) }
describe('настройки и подтверждения P1', () => {
  it('показывает предварительную разницу и применяет только явным нажатием', async () => {
    const resolve = vi.fn().mockResolvedValue({})
    wrap(<ProposalActions text={null} data={{ id: 'proposal', text: 'Изменить правила?', status: 'pending', diff }} resolve={resolve} />)
    expect(resolve).not.toHaveBeenCalled()
    expect(screen.getByText(/НМЦК: 300,00 ₽ → 400,00 ₽/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Применить изменения' }))
    expect(resolve).toHaveBeenCalledWith('apply')
    expect(await screen.findByText('Изменения приняты')).toBeInTheDocument()
  })
  it('показывает ошибку подтверждения и сохраняет возможность повторить', async () => {
    wrap(<ProposalActions text={null} data={{ id: 'proposal', text: 'Изменить правила?', status: 'pending', diff }} resolve={vi.fn().mockRejectedValue(new Error('Предложение устарело'))} />)
    await userEvent.click(screen.getByRole('button', { name: 'Применить изменения' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Предложение устарело')
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeEnabled()
  })
  it('сбрасывает только выбранную локальную правку и запускает rebase отдельно', async () => {
    vi.spyOn(api, 'getLocalSettings').mockResolvedValue({ items: [{ key: 'rules.cv_threshold', group: 'rules', title: 'Порог разброса', display: '40 %', global_display: '33 %', changed: true, edit_id: 'ed1' }], base_outdated: [{ key: 'rules.cv_threshold', title: 'Порог разброса', base: '33 %', current: '35 %' }] })
    const cancel = vi.spyOn(api, 'cancelEdits').mockResolvedValue({})
    const rebase = vi.spyOn(api, 'rebaseSettings').mockResolvedValue({})
    wrap(<LocalSettingsPanel procurementId="p1" active />)
    await userEvent.click(await screen.findByRole('button', { name: 'Сбросить изменение' }))
    expect(cancel).toHaveBeenCalledWith('p1', ['ed1'])
    await userEvent.click(screen.getByRole('button', { name: 'Пересчитать по общим' }))
    expect(rebase).toHaveBeenCalledWith('p1')
  })
  it('показывает общие правила и отправляет просьбу агенту настроек', async () => {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
    vi.spyOn(api, 'getConfig').mockResolvedValue({ sources: [], rules: [{ key: 'cv', title: 'Порог разброса', value: '0.33', display: '33 %', description: 'Максимальный разброс' }] })
    vi.spyOn(api, 'getConfigChanges').mockResolvedValue([])
    vi.spyOn(api, 'getConfigMessages').mockResolvedValue([])
    const send = vi.spyOn(api, 'sendConfigMessage').mockResolvedValue({ id: 'm1', kind: 'text', role: 'user', created_at: new Date().toISOString(), text: 'Измени порог', data: null })
    wrap(<GlobalSettingsPanel />)
    await waitFor(() => expect(screen.queryByText('Загрузка правил и источников…')).not.toBeInTheDocument())
    await userEvent.type(screen.getByRole('textbox', { name: 'Сообщение агенту настроек' }), 'Измени порог{Enter}')
    expect(send).toHaveBeenCalledWith('Измени порог')
    expect(await screen.findByText('Измени порог')).toBeInTheDocument()
  })
})
