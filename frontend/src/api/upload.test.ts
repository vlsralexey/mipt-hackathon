import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../mocks/server'
import { api } from './client'

it.each(['', 'text/plain'])('передаёт имя, байты и тип файла через multipart (type=%s)', async (type) => {
  let received: FormData | undefined
  server.use(http.post('/api/procurements', async ({ request }) => {
    received = await request.formData()
    return HttpResponse.json({ id: 'uploaded' })
  }))
  const content = 'Техническое задание: бумага А4'
  const file = new File([content], 'ТЗ принтер.txt', { type })

  await expect(api.createProcurement({ file, message: 'Обоснуй НМЦК' }))
    .resolves.toMatchObject({ id: 'uploaded' })

  const uploaded = received?.get('file') as File
  expect(uploaded.name).toBe(file.name)
  expect(uploaded.size).toBe(file.size)
  expect(uploaded.type).toBe(type || 'application/octet-stream')
  expect(await uploaded.text()).toBe(content)
  expect(received?.get('message')).toBe('Обоснуй НМЦК')
  expect(received?.has('tz_text')).toBe(false)
})
