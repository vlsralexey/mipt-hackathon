// @vitest-environment node
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { api, ApiError } from './client'

describe('api client (на моках из docs/api-examples)', () => {
  it('отдаёт список закупок и закупку с историей чата', async () => {
    const list = await api.listProcurements()
    expect(list).toHaveLength(1)
    const p = await api.getProcurement(list[0].id)
    expect(p.messages.map((m) => m.kind)).toEqual([
      'file', 'text', 'tz_summary', 'question', 'run', 'version', 'text',
    ])
  })

  it('отдаёт отчёт latest и версию по номеру', async () => {
    const [{ id }] = await api.listProcurements()
    const latest = await api.getReport(id, 'latest')
    expect(latest.version).toBe(1)
    expect(latest.positions).toHaveLength(2)
    expect((await api.getReport(id, 1)).procurement_id).toBe(id)
    expect((await api.listReports(id)).map((v) => v.version)).toEqual([1])
  })

  it('превращает ошибку API в ApiError с готовым текстом', async () => {
    const error = await api.getReport('нет-такой', 'latest').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).message).toBe('Версия отчёта не найдена')
  })

  it('сообщает о потере связи по-русски', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.error()))
    await expect(api.getSettings()).rejects.toMatchObject({ status: 0 })
  })

  it('запуск без ключа даёт 400 с текстом из контракта', async () => {
    const [{ id }] = await api.listProcurements()
    await expect(api.runProcurement(id)).rejects.toMatchObject({
      status: 400,
      message: 'Не задан ключ OpenRouter. Укажите его в настройках.',
    })
    await api.putSettings({ openrouter_api_key: 'sk-or-v1-test' })
    await expect(api.runProcurement(id)).resolves.toHaveProperty('run_id')
  })

  it('создаёт закупку из файла', async () => {
    const file = new File(['текст ТЗ'], 'ТЗ принтер.txt', { type: 'text/plain' })
    const p = await api.createProcurement({ file, message: 'Обоснуй НМЦК' })
    expect(p.title).toBe('ТЗ принтер')
    expect(p.messages.map((m) => m.kind)).toEqual(['file', 'text'])
    expect(await api.listProcurements()).toHaveLength(2)
  })
})
