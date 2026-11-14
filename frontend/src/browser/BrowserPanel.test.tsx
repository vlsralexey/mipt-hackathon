import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from './BrowserPanel'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  url: string
  constructor(url: string) { this.url = url; Socket.instances.push(this) }
  open() { act(() => this.onopen?.()) }
  receive(value: unknown) { act(() => this.onmessage?.({ data: JSON.stringify(value) })) }
  sent() { return this.send.mock.calls.map((call) => JSON.parse(call[0])) }
  last() { return JSON.parse(this.send.mock.calls.at(-1)![0]) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Socket.instances = [] })
const tabs = [
  { id: 'one', title: 'ЕИС', url: 'https://zakupki.gov.ru/epz/contract?id=1', domain: 'zakupki.gov.ru', action: 'Читаю контракт', procurement_id: 'p1', source_id: 'eis', status: 'reading', state: 'reading', blocked: false, position_index: 1 },
  { id: 'two', title: 'Магазин', url: 'https://shop.example/item', domain: 'shop.example', action: 'Жду проверки', procurement_id: 'p1', source_id: 'shop', status: 'waiting', state: 'needs_user', blocked: true, needs: 'captcha', deadline: new Date(Date.now() + 228_000).toISOString(), wait_seconds: 300, position_index: 1 },
]
const frame = (tab: string) => ({ type: 'frame', tab_id: tab, data: 'YWJj', width: 1280, height: 800, format: 'jpeg' })
function show(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
function start() {
  vi.stubGlobal('WebSocket', Socket)
  const view = show(<BrowserPanel procurementId="p1" active />)
  const socket = Socket.instances[0]
  socket.open()
  return { view, socket }
}

describe('браузер агента', () => {
  it('показывает короткое пустое состояние', () => {
    start()
    expect(screen.getByText('Агент пока не открывал страниц')).toBeInTheDocument()
  })

  it('показывает вкладки с состоянием, адрес и действие агента, переключает кадр', async () => {
    const user = userEvent.setup()
    const { view, socket } = start()
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    socket.receive(frame('one'))
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: /Магазин/ })).toContainElement(screen.getByRole('img', { name: 'нужна помощь' }))
    expect(screen.getByRole('img', { name: 'Страница: ЕИС' })).toBeInTheDocument()
    expect(screen.getByText('zakupki.gov.ru')).toBeInTheDocument()
    expect(screen.getByText('Читаю контракт')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Магазин/ }))
    expect(socket.last()).toEqual({ type: 'select', tab_id: 'two' })
    expect(screen.queryByRole('img', { name: /Страница/ })).not.toBeInTheDocument()
    expect(screen.getByText('Сайт просит пройти проверку')).toBeInTheDocument()
    view.unmount()
    expect(socket.close).toHaveBeenCalled()
  })

  it('ручная проверка: полоса управления, таймер, пропуск и возврат по Esc', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { socket } = start()
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'two' })
    socket.receive(frame('two'))
    await user.click(screen.getByRole('button', { name: 'Взять управление' }))
    expect(socket.last()).toEqual({ type: 'control', tab_id: 'two', by: 'user' })
    socket.receive({ type: 'control', tab_id: 'two', by: 'user' })
    expect(screen.getByText(/Управляете вы/)).toHaveTextContent(/агент ждёт 3:4\d/)
    expect(screen.queryByRole('textbox', { name: 'Текст для страницы браузера' })).not.toBeInTheDocument()
    const capture = screen.getByRole('textbox', { name: 'Ввод на страницу' })
    expect(capture).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Пропустить сайт' }))
    expect(fetchMock).toHaveBeenCalled()
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/procurements/p1/sources/shop/skip')
    fireEvent.keyDown(capture, { key: 'Escape' })
    expect(socket.last()).toEqual({ type: 'resume', tab_id: 'two' })
    expect(socket.sent()).not.toContainEqual(expect.objectContaining({ type: 'key', key: 'Escape' }))
    await user.click(screen.getByRole('button', { name: 'Готово, продолжить' }))
    expect(socket.last()).toEqual({ type: 'resume', tab_id: 'two' })
  })

  it('переводит координаты клика в систему кадра, передаёт двойной клик и правую кнопку', () => {
    const { socket } = start()
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    socket.receive(frame('one'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    socket.receive({ type: 'control', tab_id: 'one', by: 'user' })
    const capture = screen.getByRole('textbox', { name: 'Ввод на страницу' })
    vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 640, height: 400 } as DOMRect)
    fireEvent.mouseDown(capture, { clientX: 110, clientY: 70, button: 0, detail: 1 })
    expect(socket.last()).toEqual({ type: 'mouse', tab_id: 'one', event: 'down', x: 200, y: 100, button: 'left' })
    fireEvent.mouseDown(capture, { clientX: 110, clientY: 70, button: 0, detail: 2 })
    expect(socket.last()).toMatchObject({ event: 'down', click_count: 2 })
    fireEvent.mouseUp(capture, { clientX: 110, clientY: 70, button: 2, detail: 1 })
    expect(socket.last()).toMatchObject({ event: 'up', button: 'right' })
  })

  it('печатные символы и вставка уходят текстом, служебные клавиши и сочетания нажатиями', () => {
    const { socket } = start()
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    socket.receive(frame('one'))
    socket.receive({ type: 'control', tab_id: 'one', by: 'user' })
    const capture = screen.getByRole('textbox', { name: 'Ввод на страницу' }) as HTMLTextAreaElement
    // Буква любой раскладки: keydown не отменяется, текст приходит событием input.
    expect(fireEvent.keyDown(capture, { key: 'ж', code: 'Semicolon' })).toBe(true)
    fireEvent.input(capture, { target: { value: 'ж' } })
    expect(socket.last()).toEqual({ type: 'text', tab_id: 'one', text: 'ж' })
    expect(capture.value).toBe('')
    // IME: текст после завершения композиции.
    capture.value = '日本'
    fireEvent.compositionEnd(capture, { data: '日本' })
    expect(socket.last()).toEqual({ type: 'text', tab_id: 'one', text: '日本' })
    fireEvent.paste(capture, { clipboardData: { getData: () => 'Привет из буфера' } })
    expect(socket.last()).toEqual({ type: 'text', tab_id: 'one', text: 'Привет из буфера' })
    fireEvent.keyDown(capture, { key: 'Backspace', code: 'Backspace' })
    expect(socket.last()).toEqual({ type: 'key', tab_id: 'one', event: 'down', key: 'Backspace' })
    fireEvent.keyDown(capture, { key: ' ', code: 'Space' })
    expect(socket.last()).toEqual({ type: 'key', tab_id: 'one', event: 'down', key: 'Space' })
    // Ctrl+A на русской раскладке: странице уходит латинская клавиша.
    fireEvent.keyDown(capture, { key: 'Control', code: 'ControlLeft', ctrlKey: true })
    fireEvent.keyDown(capture, { key: 'ф', code: 'KeyA', ctrlKey: true })
    expect(socket.last()).toEqual({ type: 'key', tab_id: 'one', event: 'down', key: 'a' })
    // Ctrl+V не отправляется клавишей: текст придёт событием paste.
    const count = socket.send.mock.calls.length
    expect(fireEvent.keyDown(capture, { key: 'v', code: 'KeyV', ctrlKey: true })).toBe(true)
    expect(socket.send.mock.calls.length).toBe(count)
    // Потеря фокуса отпускает зажатые клавиши.
    fireEvent.blur(capture)
    const ups = socket.sent().filter((m) => m.type === 'key' && m.event === 'up').map((m) => m.key)
    expect(ups).toEqual(expect.arrayContaining(['Backspace', 'Space', 'Control', 'a']))
    const wheel = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true })
    fireEvent(capture, wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(socket.last()).toEqual({ type: 'wheel', tab_id: 'one', dx: 0, dy: 100 })
  })

  it('показывает понятную ошибку страницы и журнал хода поиска', () => {
    const { socket } = start()
    const failed = { ...tabs[0], state: 'error', status: 'error', error: 'Сайт не ответил за 30 секунд' }
    socket.receive({ type: 'tabs', tabs: [failed], selected_tab_id: 'one' })
    socket.receive(frame('one'))
    expect(screen.getByText('Страница не открылась')).toBeInTheDocument()
    expect(screen.getByText('Сайт не ответил за 30 секунд')).toBeInTheDocument()
    const event = (id: number, kind: string, text: string) => ({ id, at: '2026-11-14T13:29:00Z', kind, text, position_index: 1, source_id: 'eis', source_name: 'ЕИС', domain: 'zakupki.gov.ru', url: '', tab_id: null, price: null, amount: null, unit: null })
    socket.receive({ type: 'journal', full: true, events: [event(1, 'found', 'zakupki.gov.ru: цена 320,80 ₽ за 1 пачка')] })
    socket.receive({ type: 'journal', full: false, events: [event(2, 'skipped', 'shop.example: сайт не ответил за 30 секунд')] })
    const journal = screen.getByRole('region', { name: 'Ход поиска' })
    expect(within(journal).getAllByRole('listitem')).toHaveLength(2)
    expect(within(journal).getByText('позиция 1')).toBeInTheDocument()
    expect(journal.textContent).toMatch(/\d\d:29/)
  })

  it('разворачивает окно поверх приложения и закрывает по Esc', async () => {
    const user = userEvent.setup()
    const { socket } = start()
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    socket.receive(frame('one'))
    await user.click(screen.getByRole('button', { name: 'Развернуть' }))
    const dialog = screen.getByRole('dialog', { name: 'Браузер агента' })
    expect(within(dialog).getByRole('img', { name: 'Страница: ЕИС' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ручное управление открывает развёрнутый вид, возврат управления агенту закрывает его', async () => {
    const user = userEvent.setup()
    const { socket } = start()
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'two' })
    socket.receive(frame('two'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    socket.receive({ type: 'control', tab_id: 'two', by: 'user' })
    const dialog = screen.getByRole('dialog', { name: 'Браузер агента' })
    // ввод и клики работают в развёрнутом виде
    const capture = within(dialog).getByRole('textbox', { name: 'Ввод на страницу' })
    expect(capture).toHaveFocus()
    fireEvent.input(capture, { target: { value: 'abc' } })
    expect(socket.last()).toEqual({ type: 'text', tab_id: 'two', text: 'abc' })
    vi.spyOn(capture, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 } as DOMRect)
    fireEvent.mouseDown(capture, { clientX: 100, clientY: 50, button: 0, detail: 1 })
    expect(socket.last()).toMatchObject({ type: 'mouse', event: 'down', x: 100, y: 50 })
    expect(within(dialog).getByRole('button', { name: 'Пропустить сайт' })).toHaveTextContent('Пропустить сайт')
    // Esc уходит не странице, а возвращает управление; окно закрывается, когда агент его принял
    await user.keyboard('{Escape}')
    expect(socket.last()).toEqual({ type: 'resume', tab_id: 'two' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    socket.receive({ type: 'control', tab_id: 'two', by: 'agent' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('не переносит страницы и управление в другую закупку и игнорирует старый socket', () => {
    const { view, socket: first } = start()
    first.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    first.receive({ type: 'control', tab_id: 'one', by: 'user' })
    first.receive(frame('one'))
    view.rerender(<QueryClientProvider client={new QueryClient()}><BrowserPanel procurementId="p2" active /></QueryClientProvider>)
    expect(first.close).toHaveBeenCalled()
    first.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(Socket.instances.at(-1)!.url).toContain('procurement_id=p2')
  })

  it('спокойно сообщает об обрыве, снимает управление и переподключается', () => {
    vi.useFakeTimers()
    const { socket: first } = start()
    first.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    first.receive({ type: 'control', tab_id: 'one', by: 'user' })
    expect(screen.getByRole('button', { name: 'Готово, продолжить' })).toBeInTheDocument()
    act(() => first.onclose?.())
    expect(screen.getByText('Нет связи с браузером агента.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Переподключить' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Взять управление' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2000))
    expect(Socket.instances).toHaveLength(2)
    first.receive({ type: 'control', tab_id: 'one', by: 'user' })
    expect(screen.getByRole('button', { name: 'Взять управление' })).toBeInTheDocument()
  })
})
