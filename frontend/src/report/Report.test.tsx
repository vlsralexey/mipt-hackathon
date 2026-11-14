import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { AppliedEdit, Edit, Report } from '../api/types'
import { db } from '../mocks/db'
import { mockTiming } from '../mocks/handlers'
import { renderApp } from '../test/render'

const exampleId = () => [...db.procurements.keys()][0]
const panel = async () => within(await screen.findByRole('article', { name: 'Отчёт' }))

const edit = (over: Partial<Edit>): Edit => ({
  id: 'ed_01',
  seq: 1,
  created_at: '2026-11-13T10:31:40+03:00',
  kind: 'exclude',
  position_index: 1,
  target: 'o1',
  payload: {},
  reason: 'поставка б/у',
  reason_kind: 'other',
  origin: 'chat',
  status: 'active',
  summary: 'Исключено: Дистрибьютор «Регион», каталог',
  ...over,
})

/** Добавляет в мок версию 2 и делает её последней. */
function addVersion2(over: Partial<Report> = {}) {
  const id = exampleId()
  const v1 = db.reports.get(id)![0]
  const v2: Report = {
    ...structuredClone(v1),
    version: 2,
    cause: 'Исключено: Дистрибьютор «Регион»',
    title: 'Заголовок второй версии',
    ...over,
  }
  db.reports.get(id)!.push(v2)
  db.procurements.get(id)!.latest_version = 2
  return v2
}

beforeEach(() => {
  mockTiming.agentReplyMs = 20
})

describe('панель отчёта: версия из примера контракта', () => {
  it('показывает заголовок, итог с пояснением и предупреждения', async () => {
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    expect(report.getByRole('heading', { name: /Поставка бумаги для офисной техники/ })).toBeInTheDocument()
    expect(report.getByText(/версия 1, 13 ноября 2026 г\.$/)).toBeInTheDocument()
    expect(report.queryByText(/Первый прогон/)).not.toBeInTheDocument()
    // позиция 2 не обоснована: итог только по обоснованным, цена справочная
    expect(report.getByText('НМЦК по обоснованным позициям')).toBeInTheDocument()
    // итог крупно и та же сумма у обоснованной позиции 1
    expect(report.getAllByText(/761\s250,00/)).toHaveLength(2)
    expect(report.getByText(/Позиция 2 пока не обоснована: её цена 274,75\s₽ приведена справочно и в итог не входит\./)).toBeInTheDocument()
    expect(report.getByRole('note')).toHaveTextContent(/найдено 2 цены, обоснование недостаточно/)
  })

  it('расчёт по позициям: цена × количество, статус и линейка цен', async () => {
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    // название встречается и в расчёте, и в «Предмете закупки»
    expect(report.getAllByText(/1\. Бумага А4 SvetoCopy/).length).toBeGreaterThanOrEqual(1)
    expect(report.getByText(/304,50\s₽\s×\s2\s500\s·\sпачка/)).toBeInTheDocument()
    expect(report.getByText('обоснована')).toBeInTheDocument()
    expect(report.getByText('справочно')).toBeInTheDocument()
    expect(report.getByText('3 цены · исключено 2 · разброс 4,68 %')).toBeInTheDocument()
    // длинное правило выбросов не загромождает позицию: оно в разделе «Методика»
    expect(report.getAllByText(/Меньше 5 цен: исключаются цены/)).toHaveLength(1)
    const rulers = report.getAllByRole('img')
    expect(rulers).toHaveLength(2)
    expect(rulers[0]).toHaveAttribute('aria-label', expect.stringMatching(/Среднее 304,50\s₽.*Допустимый коридор/))
    // допущения не загромождают позицию: ответ по умолчанию виден в «Уточнениях»
    expect(report.queryByText(/Принято по умолчанию/)).not.toBeInTheDocument()
    expect(report.queryByText(/Уровень 2 подключён/)).not.toBeInTheDocument()
    expect(report.getByText('(принято по умолчанию)')).toBeInTheDocument()
  })

  it('включённые предложения: ссылки на источники, фильтр по позиции, расчёт цены', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    const link = report.getByRole('link', { name: /ЕИС, контракт № 2770…0148/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('zakupki.gov.ru'))
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(report.getByText('12.08.2026')).toBeInTheDocument()
    // «Совпадают: ...» под источником не выводится: то же видно в «Как получена цена»
    expect(report.queryByText(/Совпадают:/)).not.toBeInTheDocument()

    // как получена цена: фасовка 5 пачек приводится к пачке
    const row = report.getAllByRole('link', { name: /Регион|Северная/ })[0].closest('tr')!
    expect(within(row).getByText('Как получена цена')).toBeInTheDocument()

    await user.click(report.getByRole('button', { name: 'Позиция 2' }))
    expect(report.getByRole('button', { name: 'Позиция 2' })).toHaveAttribute('aria-pressed', 'true')
    expect(report.getByRole('link', { name: /Северная бумага/ })).toBeInTheDocument()
    expect(report.queryByRole('link', { name: /ЕИС, контракт № 2770…0148/ })).not.toBeInTheDocument()
  })

  it('исключённые предложения: причина показана, раздел относится к выбранной позиции', async () => {
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    const summary = report.getByText(/Исключённые предложения, позиция 1/)
    expect(summary).toBeInTheDocument()
    const excluded = (await screen.findByRole('article', { name: 'Отчёт' })).querySelectorAll('tr[class*="excluded"]')
    expect(excluded.length).toBeGreaterThan(0)
    expect(report.getAllByText(/Выброс|Не совпадает|Дубль|Исключено/).length).toBeGreaterThan(0)
  })

  it('«Где искали», «Уточнения», «Предмет закупки» и методика', async () => {
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    expect(report.getByText('ЕИС Закупки')).toBeInTheDocument()
    expect(report.getAllByText(/уровень 1/).length).toBeGreaterThan(0)
    expect(report.getByText('(принято по умолчанию)')).toBeInTheDocument()
    expect(report.getByText(/ОКПД2 17\.12\.14\.160/)).toBeInTheDocument()
    expect(report.getByText(/Существенные: Товарный знак SvetoCopy/)).toBeInTheDocument()
    expect(report.getByText(/До адреса заказчика/)).toBeInTheDocument()
    expect(report.getByText(/Цены приведены на 13\.11\.2026/)).toBeInTheDocument()
  })

  it('ссылка на DOCX ведёт на выгрузку открытой версии', async () => {
    const id = exampleId()
    renderApp(`/p/${id}`)
    const link = await screen.findByRole('link', { name: 'DOCX' })
    expect(link).toHaveAttribute('href', `/api/procurements/${id}/reports/1/export.docx`)
  })
})

describe('«Открыть» в карточке версии', () => {
  it('возвращает уже открытый отчёт к началу', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await panel()
    // в jsdom нет вёрстки: имитируем прокрученный вниз отчёт
    const scroller = document.getElementById('panel-report')!
    Object.defineProperty(scroller, 'scrollTop', { value: 400, writable: true, configurable: true })
    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    await waitFor(() => expect(scroller.scrollTop).toBe(0))
    // версия уже была открыта: плашки закрепления нет
    expect(screen.queryByText(/Вы смотрите версию/)).not.toBeInTheDocument()
  })

  it('открывает вкладку «Отчёт», если была открыта «Браузер», и показывает отчёт сверху', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await panel()
    await user.click(screen.getByRole('tab', { name: 'Браузер' }))
    expect(screen.getByRole('tabpanel', { name: 'Браузер' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    expect(screen.getByRole('tab', { name: 'Отчёт', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel', { name: 'Отчёт' })).toBeVisible()
  })
})

describe('подсказки о разбросе', () => {
  it('подсказка о причине разброса остаётся под позицией', async () => {
    const id = [...db.procurements.keys()][0]
    db.reports.get(id)![0].positions[0].spread_hints = ['Цены с фасовкой 5 пачек заметно ниже']
    renderApp(`/p/${id}`)
    const report = await panel()
    expect(report.getByText('Цены с фасовкой 5 пачек заметно ниже')).toBeInTheDocument()
  })
})

describe('итог в разных состояниях', () => {
  it('все позиции обоснованы: просто «НМЦК» без пояснения', async () => {
    const id = exampleId()
    const r = db.reports.get(id)![0]
    r.total = '800000.00'
    r.positions[1].status = 'ok'
    renderApp(`/p/${id}`)
    const report = await panel()
    expect(report.getByText('НМЦК')).toBeInTheDocument()
    expect(report.getByText(/800\s000,00/)).toBeInTheDocument()
    expect(report.queryByText(/пока не обоснован/)).not.toBeInTheDocument()
  })

  it('ничего не обосновано: итога нет, и это сказано', async () => {
    const id = exampleId()
    const r = db.reports.get(id)![0]
    r.total = null
    r.total_justified = null
    r.positions[0].status = 'insufficient'
    renderApp(`/p/${id}`)
    const report = await panel()
    expect(report.getByText('НМЦК не определена')).toBeInTheDocument()
    expect(report.getByText(/Позиции 1, 2 пока не обоснованы/)).toBeInTheDocument()
  })
})

describe('версии отчёта', () => {
  beforeEach(() => {
    addVersion2()
  })

  it('по умолчанию открыта последняя; список версий, от новой к старой', async () => {
    renderApp(`/p/${exampleId()}`)
    const select = await screen.findByRole('combobox', { name: 'Версия отчёта' })
    await waitFor(() => expect(select).toHaveValue('2'))
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Версия 2',
      'Версия 1',
    ])
    expect(await screen.findByRole('heading', { name: 'Заголовок второй версии' })).toBeInTheDocument()
  })

  it('выбор старой версии закрепляет её с плашкой; «Открыть последнюю» возвращает', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    const select = await screen.findByRole('combobox', { name: 'Версия отчёта' })
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await user.selectOptions(select, '1')

    expect(await screen.findByText('Вы смотрите версию 1, последняя: 2.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'DOCX' })).toHaveAttribute('href', expect.stringMatching(/reports\/1\/export\.docx$/))
    await user.click(screen.getByRole('button', { name: 'Открыть последнюю' }))
    expect(await screen.findByRole('heading', { name: 'Заголовок второй версии' })).toBeInTheDocument()
    expect(screen.queryByText(/Вы смотрите версию/)).not.toBeInTheDocument()
  })

  it('чат отправляет viewing_version той версии, что открыта в панели', async () => {
    const user = userEvent.setup()
    const send = vi.spyOn(api, 'sendMessage')
    renderApp(`/p/${exampleId()}`)
    const select = await screen.findByRole('combobox', { name: 'Версия отчёта' })
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await user.selectOptions(select, '1')
    await screen.findByText(/Вы смотрите версию 1/)

    await user.type(screen.getByRole('textbox', { name: 'Сообщение агенту' }), 'про эту таблицу{Enter}')
    expect(send).toHaveBeenCalledWith(exampleId(), 'про эту таблицу', 1)
  })

  it('«Открыть» в карточке версии открывает её в панели', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    // в чате одна карточка версии (первый прогон), у неё одна кнопка «Открыть»
    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    expect(await screen.findByText(/Вы смотрите версию 1/)).toBeInTheDocument()
  })

  it('новая версия по событию SSE подхватывается, если смотрим последнюю', async () => {
    const id = exampleId()
    renderApp(`/p/${id}`)
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })

    const v3: Report = { ...structuredClone(db.reports.get(id)![1]), version: 3, cause: 'Ещё правка', title: 'Заголовок третьей версии' }
    db.reports.get(id)!.push(v3)
    db.procurements.get(id)!.latest_version = 3
    db.publishSummary(id)
    db.publish(id, { event: 'report', data: { version: 3, cause: v3.cause } })

    expect(await screen.findByRole('heading', { name: 'Заголовок третьей версии' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Версия отчёта' })).toHaveValue('3'))
  })

  it('закреплённая версия не подменяется новой по событию SSE', async () => {
    const user = userEvent.setup()
    const id = exampleId()
    renderApp(`/p/${id}`)
    const select = await screen.findByRole('combobox', { name: 'Версия отчёта' })
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await user.selectOptions(select, '1')
    await screen.findByText(/Вы смотрите версию 1/)

    const v3: Report = { ...structuredClone(db.reports.get(id)![1]), version: 3, cause: 'Ещё правка' }
    db.reports.get(id)!.push(v3)
    db.procurements.get(id)!.latest_version = 3
    db.publishSummary(id)
    db.publish(id, { event: 'report', data: { version: 3, cause: v3.cause } })

    expect(await screen.findByText('Вы смотрите версию 1, последняя: 3.')).toBeInTheDocument()
  })
})

describe('правки пользователя в отчёте', () => {
  const applied = (): AppliedEdit[] => [
    { edit: edit({}), applied: true, effect: 'Исключено из расчёта' },
    {
      edit: edit({ id: 'ed_02', seq: 2, status: 'cancelled', summary: 'Исключено: Северная бумага' }),
      applied: false,
      effect: 'Не применена: предложение не найдено при поиске от 14.11.2026',
    },
  ]

  it('в последней версии активную правку можно отменить одной правкой', async () => {
    const user = userEvent.setup()
    const cancel = vi.spyOn(api, 'cancelEdits')
    addVersion2({ edits: applied() })
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    expect(report.getByText(/Правки пользователя/)).toBeInTheDocument()
    expect(report.getByText('1 из 2')).toBeInTheDocument()
    expect(report.getByText('Не применена: предложение не найдено при поиске от 14.11.2026')).toBeInTheDocument()
    expect(report.getAllByRole('button', { name: 'Отменить' })).toHaveLength(1)
    await user.click(report.getByRole('button', { name: 'Отменить' }))
    expect(cancel).toHaveBeenCalledWith(exampleId(), ['ed_01'])
  })

  it('в старой версии отмены нет: отмена создаёт новую версию', async () => {
    const user = userEvent.setup()
    db.reports.get(exampleId())![0].edits = applied()
    addVersion2()
    renderApp(`/p/${exampleId()}`)
    const select = await screen.findByRole('combobox', { name: 'Версия отчёта' })
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await user.selectOptions(select, '1')
    const report = await panel()
    await waitFor(() => expect(report.getByText('1 из 2')).toBeInTheDocument())
    expect(report.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument()
    expect(report.getByText('действует')).toBeInTheDocument()
    expect(report.getByText('отменена')).toBeInTheDocument()
  })
})

describe('пустые состояния', () => {
  it('закупка без отчёта: понятное пояснение, без запросов отчёта и без кнопок версий', async () => {
    const get = vi.spyOn(api, 'getReport')
    const id = exampleId()
    Object.assign(db.procurements.get(id)!, { latest_version: null, status: 'new' })
    renderApp(`/p/${id}`)
    expect(await screen.findByRole('heading', { name: 'Отчёта пока нет' })).toBeInTheDocument()
    expect(screen.getByText('Отчёт появится после первого прогона.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Версия отчёта' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'DOCX' })).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  it('идёт поиск, так и сказано', async () => {
    const id = exampleId()
    Object.assign(db.procurements.get(id)!, { latest_version: null, status: 'running' })
    renderApp(`/p/${id}`)
    expect(await screen.findByText(/Агент ищет предложения/)).toBeInTheDocument()
  })

  it('отчёт не загрузился, текст ошибки и «Повторить»', async () => {
    const user = userEvent.setup()
    const id = exampleId()
    const v1 = db.reports.get(id)!
    db.reports.set(id, [])
    renderApp(`/p/${id}`)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Не удалось загрузить отчёт')
    expect(alert).toHaveTextContent('Версия отчёта не найдена')
    db.reports.set(id, v1)
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('article', { name: 'Отчёт' })).toBeInTheDocument()
  })

  it('вкладка «Браузер» объясняет, когда появится окно', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await user.click(await screen.findByRole('tab', { name: 'Браузер' }))
    expect(screen.getByText(/Оно появится здесь/)).toBeVisible()
  })
})
