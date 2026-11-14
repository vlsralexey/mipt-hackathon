import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  receive(value: unknown) { act(() => this.onmessage?.({ data: JSON.stringify(value) })) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Socket.instances = [] })
const tabs = [
  { id: 'one', title: 'ЕИС', url: 'https://zakupki.gov.ru', action: 'Читаю контракт', procurement_id: 'p1', source_id: 'eis', status: 'running', blocked: false },
  { id: 'two', title: 'Магазин', url: 'https://shop.example', action: 'Нужна проверка', procurement_id: 'p1', source_id: 'shop', status: 'blocked', blocked: true },
]
describe('браузер агента', () => {
  it('показывает все вкладки, переключает кадр и возвращает управление после капчи', async () => {
    vi.stubGlobal('WebSocket', Socket)
    const user = userEvent.setup()
    const view = render(<BrowserPanel procurementId="p1" active />)
    const socket = Socket.instances[0]
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    socket.receive({ type: 'frame', tab_id: 'one', data: 'YWJj', width: 1280, height: 800 })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('img')).toHaveAccessibleName('Страница: ЕИС')
    await user.click(screen.getByRole('tab', { name: /Магазин/ }))
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'select', tab_id: 'two' })
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    socket.receive({ type: 'frame', tab_id: 'two', data: 'ZGVm', width: 1280, height: 800 })
    await user.click(screen.getByRole('button', { name: 'Взять управление' }))
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'control', tab_id: 'two', by: 'user' })
    socket.receive({ type: 'control', tab_id: 'two', by: 'user' })
    await user.type(screen.getByRole('textbox'), 'Проверка')
    await user.click(screen.getByRole('button', { name: 'Ввести' }))
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'text', tab_id: 'two', text: 'Проверка' })
    await user.click(screen.getByRole('button', { name: 'Проверка пройдена' }))
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'resume', tab_id: 'two' })
    view.unmount()
    expect(socket.close).toHaveBeenCalled()
  })
  it('переводит координаты клика из размера превью в размер страницы и блокирует ввод в режиме наблюдения', () => {
    vi.stubGlobal('WebSocket', Socket)
    render(<BrowserPanel procurementId="p1" active />)
    const socket = Socket.instances[0]
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    socket.receive({ type: 'frame', tab_id: 'one', data: 'YWJj', width: 1280, height: 800 })
    const image = screen.getByRole('img')
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 640, height: 400 } as DOMRect)
    fireEvent.mouseDown(image, { clientX: 110, clientY: 70 })
    expect(socket.send).not.toHaveBeenCalled()
    socket.receive({ type: 'control', tab_id: 'one', by: 'user' })
    fireEvent.mouseDown(image, { clientX: 110, clientY: 70 })
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'mouse', tab_id: 'one', event: 'down', x: 200, y: 100, button: 'left' })
  })
  it('передаёт Space, отпускает клавиши при потере фокуса и перехватывает прокрутку страницы', () => {
    vi.stubGlobal('WebSocket', Socket)
    render(<BrowserPanel procurementId="p1" active />)
    const socket = Socket.instances[0]
    socket.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    socket.receive({ type: 'frame', tab_id: 'one', data: 'YWJj', width: 1280, height: 800 })
    socket.receive({ type: 'control', tab_id: 'one', by: 'user' })
    const image = screen.getByRole('img')
    fireEvent.keyDown(image, { key: ' ' })
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'key', tab_id: 'one', event: 'down', key: 'Space' })
    fireEvent.blur(image)
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'key', tab_id: 'one', event: 'up', key: 'Space' })
    const wheel = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true })
    fireEvent(image, wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'wheel', tab_id: 'one', dx: 0, dy: 100 })
  })
  it('не переносит страницы и управление в другую закупку и игнорирует старый socket', () => {
    vi.stubGlobal('WebSocket', Socket)
    const view = render(<BrowserPanel procurementId="p1" active />)
    const first = Socket.instances[0]
    first.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    first.receive({ type: 'control', tab_id: 'one', by: 'user' })
    first.receive({ type: 'frame', tab_id: 'one', data: 'YWJj', width: 1280, height: 800 })
    view.rerender(<BrowserPanel procurementId="p2" active />)
    expect(first.close).toHaveBeenCalled()
    first.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(Socket.instances[1].url).toContain('procurement_id=p2')
  })

  it('снимает локальное управление при обрыве и создаёт новую подписку', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', Socket)
    render(<BrowserPanel procurementId="p1" active />)
    const first = Socket.instances[0]
    first.receive({ type: 'tabs', tabs, selected_tab_id: 'one' })
    first.receive({ type: 'control', tab_id: 'one', by: 'user' })
    expect(screen.getByRole('button', { name: 'Вернуть агенту' })).toBeInTheDocument()
    act(() => first.onclose?.())
    expect(screen.getByRole('button', { name: 'Взять управление' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2000))
    expect(Socket.instances).toHaveLength(2)
    first.receive({ type: 'control', tab_id: 'one', by: 'user' })
    expect(screen.getByRole('button', { name: 'Взять управление' })).toBeInTheDocument()
  })

})
