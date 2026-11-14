import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { db } from '../mocks/db'
import { server } from '../mocks/server'
import { renderApp } from '../test/render'

const docx = (name = 'ТЗ принтер.docx', size?: number) => {
  const file = new File(['содержимое'], name)
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
  return file
}
const upload = (file: File) =>
  userEvent.upload(screen.getByTestId('file-input'), file, { applyAccept: false })

describe('новая закупка', () => {
  it('не даёт отправить пустую форму', async () => {
    const user = userEvent.setup()
    renderApp('/new')
    const send = screen.getByRole('button', { name: 'Отправить' })
    expect(send).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Техническое задание' }), '   ')
    expect(send).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Техническое задание' }), 'Бумага А4')
    expect(send).toBeEnabled()
  })

  it('текст без файла уходит как tz_text; без ключа открывает закупку с уведомлением', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, 'createProcurement')
    renderApp('/new')
    await user.type(screen.getByRole('textbox', { name: 'Техническое задание' }), 'Нужна бумага А4')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    expect(await screen.findByRole('region', { name: 'Чат с агентом' })).toBeInTheDocument()
    expect(create).toHaveBeenCalledWith({ tzText: 'Нужна бумага А4' })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Не задан ключ OpenRouter. Укажите его в настройках.')
    expect(within(alert).getByRole('link', { name: 'Настройки' })).toHaveAttribute('href', '/settings')
    // закупка появилась в навигации
    const nav = screen.getByRole('navigation', { name: 'Закупки' })
    expect(await within(nav).findAllByRole('link', { name: /Новая закупка|Поставка бумаги/ })).toHaveLength(3)
  })

  it('файл с сообщением: message рядом с file, ключ задан, без уведомления', async () => {
    db.settings = { has_api_key: true, key_source: 'settings', model: 'm' }
    const user = userEvent.setup()
    const create = vi.spyOn(api, 'createProcurement')
    renderApp('/new')
    const file = docx()
    await upload(file)
    expect(screen.getByText('ТЗ принтер.docx')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Техническое задание' }), 'Обоснуй НМЦК')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    expect(await screen.findByRole('region', { name: 'Чат с агентом' })).toBeInTheDocument()
    expect(create).toHaveBeenCalledWith({ file, message: 'Обоснуй НМЦК' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('один файл без текста тоже можно отправить, файл можно убрать', async () => {
    const user = userEvent.setup()
    renderApp('/new')
    await upload(docx())
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Убрать файл' }))
    expect(screen.queryByText('ТЗ принтер.docx')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled()
  })

  it('отклоняет неподдерживаемый формат и слишком большой файл', async () => {
    renderApp('/new')
    await upload(docx('программа.exe'))
    expect(screen.getByRole('alert')).toHaveTextContent('Формат не поддерживается')
    expect(screen.queryByText('программа.exe')).not.toBeInTheDocument()

    await upload(docx('большой.pdf', 21 * 1024 * 1024))
    expect(screen.getByRole('alert')).toHaveTextContent('Файл больше 20 МБ')
    expect(screen.queryByText('большой.pdf')).not.toBeInTheDocument()
  })

  it('принимает файл, брошенный на поле', () => {
    renderApp('/new')
    const field = screen.getByRole('textbox', { name: 'Техническое задание' }).parentElement!
    fireEvent.drop(field, { dataTransfer: { files: [docx('ТЗ цитокины.docx')] } })
    expect(screen.getByText('ТЗ цитокины.docx')).toBeInTheDocument()
  })

  it('при ошибке создания остаётся на форме, показывает текст и сохраняет ввод', async () => {
    server.use(
      http.post('/api/procurements', () =>
        HttpResponse.json({ detail: 'В файле нет текста ТЗ.' }, { status: 400 }),
      ),
    )
    const user = userEvent.setup()
    renderApp('/new')
    const field = screen.getByRole('textbox', { name: 'Техническое задание' })
    await user.type(field, 'текст')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('В файле нет текста ТЗ.')
    expect(field).toHaveValue('текст')
    expect(field).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'Новая закупка', level: 1 })).toBeInTheDocument()
  })

  it('Enter отправляет, Shift+Enter переносит строку', async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, 'createProcurement')
    renderApp('/new')
    const field = screen.getByRole('textbox', { name: 'Техническое задание' })
    await user.type(field, 'раз{Shift>}{Enter}{/Shift}два')
    expect(create).not.toHaveBeenCalled()
    expect(field).toHaveValue('раз\nдва')
    await user.type(field, '{Enter}')
    expect(create).toHaveBeenCalledWith({ tzText: 'раз\nдва' })
  })

  it('«Повторить запуск» убирает уведомление, когда ключ уже задан', async () => {
    const user = userEvent.setup()
    renderApp('/new')
    await user.type(screen.getByRole('textbox', { name: 'Техническое задание' }), 'ТЗ')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    // ключ не задан, повтор снова даёт ту же ошибку
    await user.click(screen.getByRole('button', { name: 'Повторить запуск' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Не задан ключ OpenRouter')

    db.settings = { has_api_key: true, key_source: 'settings', model: 'm' }
    await user.click(screen.getByRole('button', { name: 'Повторить запуск' }))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
