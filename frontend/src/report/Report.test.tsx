import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { AppliedEdit, Edit, Report } from '../api/types'
import { db } from '../mocks/db'
import { http, HttpResponse } from 'msw'
import { mockTiming } from '../mocks/handlers'
import { server } from '../mocks/server'
import { renderApp } from '../test/render'

const exampleId = () => [...db.procurements.keys()][0]
const panel = async () => within(await screen.findByRole('article', { name: 'Отчёт' }))

/** Открывает меню версии в шапке панели и выбирает версию. */
async function chooseVersion(user: ReturnType<typeof userEvent.setup>, version: number) {
  await user.click(await screen.findByRole('button', { name: /^Версия отчёта:/ }))
  await user.click(screen.getByRole('button', { name: new RegExp(`^Версия ${version}(\\D|$)`) }))
}

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
    // мета одной строкой, без причины версии: она в карточке версии в чате
    expect(report.getByText('Версия 1 · 13 ноября 2026 · метод сопоставимых рыночных цен')).toBeInTheDocument()
    expect(report.queryByText(/Первый прогон/)).not.toBeInTheDocument()
    // позиция 2 не обоснована: итог только по обоснованным, плашка говорит, без какой позиции
    expect(report.getByText('НМЦК закупки')).toBeInTheDocument()
    expect(report.getByText('без позиции 2: мало цен')).toBeInTheDocument()
    // итог крупно; та же сумма у позиции 1 в таблице, в заголовке позиции и в шаге расчёта
    expect(report.getAllByText(/761\s250,00/).length).toBeGreaterThanOrEqual(2)
    // справочная цена позиции 2 видна в таблице, но в итог не входит
    const rows = report.getAllByRole('row')
    expect(rows[2]).toHaveTextContent(/274,75\s₽справочно/)
    expect(rows[2]).toHaveTextContent('не входит')
    expect(within(rows[2]).getByRole('img', { name: 'не обоснована' })).toBeInTheDocument()
    expect(within(rows[1]).getByRole('img', { name: 'обоснована' })).toBeInTheDocument()
    // предупреждения сгруппированы
    const note = report.getByRole('note')
    expect(note).toHaveTextContent('Проверьте перед согласованием')
    expect(note).toHaveTextContent('Цена может быть занижена: НДС не подтверждён (поз. 1), доставка не подтверждена (поз. 1 и 2).')
    expect(note).toHaveTextContent('Позиция 2: найдено 2 цены, для обоснования нужно не меньше 3.')
  })

  it('расчёт позиции: шаги с числами, линейка цен, переключатель позиций', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    const steps = within(document.querySelector<HTMLElement>('dl[aria-label="Расчёт"]')!)
    expect(steps.getByText('Средняя цена')).toBeInTheDocument()
    expect(steps.getByText(/\(290,00 \+ 305,00 \+ 318,50\) \/ 3 =/)).toBeInTheDocument()
    expect(steps.getByText(/14,26 \/ 304,50 =/)).toBeInTheDocument()
    expect(steps.getByText(/не больше 33\s%: цены однородны/)).toBeInTheDocument()
    expect(steps.getByText(/520,00\s₽ вне коридора, отклонение от медианы больше 50\s%/)).toBeInTheDocument()
    expect(steps.getByText(/304,50\s₽\s×\s2\s500\sпачек =/)).toBeInTheDocument()
    // длинное правило выбросов не загромождает позицию: оно в разделе «Методика»
    expect(report.getAllByText(/Меньше 5 цен: исключаются цены/)).toHaveLength(1)
    const ruler = report.getByRole('img', { name: /^Цены:/ })
    expect(ruler).toHaveAttribute('aria-label', expect.stringMatching(/Среднее 304,50\s₽.*Допустимый коридор.*Выбросы: 520,00/))
    expect(report.getByText('в расчёте: 3')).toBeInTheDocument()
    expect(report.getByText('выбросы: 1')).toBeInTheDocument()

    // переключатель управляет всей детализацией; необоснованная позиция отмечена точкой
    const seg2 = report.getByRole('button', { name: /^2\. Бумага писчая офсетная А4, 65 г\/м², не обоснована$/ })
    expect(within(seg2).getByRole('img', { name: 'не обоснована' })).toBeInTheDocument()
    // на вкладке номер и то, чем позиция отличается; полное название в подсказке
    expect(seg2).toHaveTextContent(/^2Писчая 65 г\/м²$/)
    expect(seg2).toHaveAttribute('title', 'Бумага писчая офсетная А4, 65 г/м²')
    await user.click(seg2)
    expect(report.getByRole('heading', { name: 'Бумага писчая офсетная А4, 65 г/м²' })).toBeInTheDocument()
    expect(report.getByText(/не определена: 2 цены, нужно не меньше 3, цена 274,75\s₽ справочно/)).toBeInTheDocument()
    expect(report.getByText('в расчёте: 2')).toBeInTheDocument()
    // допущения не загромождают позицию: ответ по умолчанию виден в «Уточнениях»
    expect(report.queryByText(/Принято по умолчанию/)).not.toBeInTheDocument()
    expect(report.queryByText(/Уровень 2 подключён/)).not.toBeInTheDocument()
    expect(report.getByText('(принято по умолчанию)')).toBeInTheDocument()
  })

  it('включённые предложения: ссылки на источники, фильтр по позиции, расчёт цены', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    const link = report.getByRole('link', { name: /^ЕИС · контракт №\s2770…0148$/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('zakupki.gov.ru'))
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // под источником поставщик и дата словами
    expect(report.getByText('12 августа 2026').parentElement).toHaveTextContent(/^ООО «Офис-Снаб» · 12 августа 2026$/)
    // «Совпадают: ...» под источником не выводится: то же видно в раскрытой строке
    expect(report.queryByText(/Совпадают:/)).not.toBeInTheDocument()

    // раскрытие строки: как получена цена и совпадение с ТЗ
    const toggle = report.getByRole('button', { name: 'Как получена цена, строка 1.3' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const row = toggle.closest('li')!
    expect(within(row).getByText('Как получена цена')).toBeInTheDocument()
    expect(within(row).getByText('За единицу ТЗ')).toBeInTheDocument()
    expect(within(row).getByText(/= 290,00\s₽ за единицу/)).toBeInTheDocument()
    expect(within(row).getByRole('list', { name: 'Сравнение с ТЗ' })).toBeInTheDocument()
    // клик по строке (не по ссылке) тоже сворачивает
    await user.click(within(row).getByText('1.3'))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(report.getByRole('button', { name: /^2\. Бумага писчая офсетная А4, 65 г\/м², не обоснована$/ }))
    expect(report.getByRole('button', { name: /^2\. Бумага писчая офсетная А4, 65 г\/м², не обоснована$/ })).toHaveAttribute('aria-pressed', 'true')
    expect(report.getByRole('link', { name: /Северная бумага/ })).toBeInTheDocument()
    expect(report.queryByRole('link', { name: /контракт №\s2770…0148/ })).not.toBeInTheDocument()
    // строка магазина: домен и название
    expect(report.getByRole('link', { name: /^kanc-market\.example\s· Канцмаркет$/ })).toHaveAttribute('title', 'Канцмаркет')
  })

  it('исключённые предложения: причина показана, раздел относится к выбранной позиции', async () => {
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    const excluded = within(report.getByRole('list', { name: 'Исключены' }))
    expect(excluded.getByText(/^Выброс: выше коридора 467,63\s₽$/)).toBeInTheDocument()
    expect(excluded.getByText('Не совпадает с ТЗ: Белизна CIE')).toBeInTheDocument()
    expect(excluded.getAllByText(/520,00\s₽/)[0]).toHaveClass(/struck/)
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
    const link = await screen.findByRole('link', { name: 'Скачать DOCX' })
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
  it('все позиции обоснованы: «НМЦК закупки» без плашки', async () => {
    const id = exampleId()
    const r = db.reports.get(id)![0]
    r.total = '800000.00'
    r.positions[1].status = 'ok'
    renderApp(`/p/${id}`)
    const report = await panel()
    expect(report.getByText('НМЦК закупки')).toBeInTheDocument()
    expect(report.getAllByText(/800\s000,00/).length).toBeGreaterThanOrEqual(1)
    expect(report.queryByText(/^без позици/)).not.toBeInTheDocument()
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
    expect(report.getByText('ни одна позиция не обоснована')).toBeInTheDocument()
  })
})

describe('версии отчёта', () => {
  beforeEach(() => {
    addVersion2()
  })

  it('по умолчанию открыта последняя; список версий, от новой к старой', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    const toggle = await screen.findByRole('button', { name: 'Версия отчёта: 2' })
    expect(await screen.findByRole('heading', { name: 'Заголовок второй версии' })).toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const items = within(screen.getByRole('list', { name: 'Версии отчёта' })).getAllByRole('button')
    expect(items.map((b) => b.getAttribute('aria-label')?.split(',')[0])).toEqual(['Версия 2', 'Версия 1'])
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    // Escape закрывает меню
    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('выбор старой версии закрепляет её с плашкой; «Открыть последнюю» возвращает', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await chooseVersion(user, 1)

    expect(await screen.findByText('Вы смотрите версию 1, последняя: 2.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Скачать DOCX' })).toHaveAttribute('href', expect.stringMatching(/reports\/1\/export\.docx$/))
    await user.click(screen.getByRole('button', { name: 'Открыть последнюю' }))
    expect(await screen.findByRole('heading', { name: 'Заголовок второй версии' })).toBeInTheDocument()
    expect(screen.queryByText(/Вы смотрите версию/)).not.toBeInTheDocument()
  })

  it('чат отправляет viewing_version той версии, что открыта в панели', async () => {
    const user = userEvent.setup()
    const send = vi.spyOn(api, 'sendMessage')
    renderApp(`/p/${exampleId()}`)
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await chooseVersion(user, 1)
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
    expect(await screen.findByRole('button', { name: 'Версия отчёта: 3' })).toBeInTheDocument()
  })

  it('закреплённая версия не подменяется новой по событию SSE', async () => {
    const user = userEvent.setup()
    const id = exampleId()
    renderApp(`/p/${id}`)
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await chooseVersion(user, 1)
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
    expect(report.getByText('Правки')).toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    await chooseVersion(user, 1)
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
    expect(screen.queryByRole('button', { name: /^Версия отчёта/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Скачать DOCX' })).not.toBeInTheDocument()
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
    expect(screen.getByText('Агент пока не открывал страниц')).toBeVisible()
  })
})

describe('редизайн панели: таблица позиций, предупреждения, сравнение версий', () => {
  it('клик по названию в таблице позиций переключает детализацию', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    const report = await panel()
    const rows = report.getAllByRole('row')
    const rowName = within(rows[2]).getByRole('button', { name: 'Бумага писчая офсетная А4, 65 г/м²' })
    // в строке коротко, полностью в подсказке
    expect(rowName).toHaveTextContent(/^Бумага писчая А4 65 г\/м²$/)
    expect(rowName).toHaveAttribute('title', 'Бумага писчая офсетная А4, 65 г/м²')
    await user.click(rowName)
    expect(report.getByRole('button', { name: /^2\. Бумага писчая офсетная А4, 65 г\/м², не обоснована$/ })).toHaveAttribute('aria-pressed', 'true')
    expect(report.getByRole('region', { name: 'Позиция 2' })).toBeInTheDocument()
  })

  it('недоступные страницы свёрнуты в одну строку со списком «Какие»', async () => {
    const user = userEvent.setup()
    const id = exampleId()
    const r = db.reports.get(id)![0]
    r.positions[0].skipped_pages = [
      { url: 'https://zakupki.gov.ru/a?reestrNumber=111', source_id: 'eis', reason: 'Источник недоступен : таймаут' },
      { url: 'https://zakupki.gov.ru/b?reestrNumber=222', source_id: 'eis', reason: 'Источник недоступен : таймаут' },
    ]
    r.warnings.push('Источник «ЕИС Закупки», позиция 1: Источник недоступен : таймаут')
    renderApp(`/p/${id}`)
    const note = (await panel()).getByRole('note')
    expect(note).toHaveTextContent('2 страницы не открылись: ЕИС.')
    const toggle = within(note).getByRole('button', { name: 'Какие' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(within(note).getByRole('link', { name: 'zakupki.gov.ru/…111' })).toBeInTheDocument()
    // причина одна на обе страницы: написана один раз, под ней ссылки
    expect(within(note).getAllByText('Источник недоступен: таймаут')).toHaveLength(1)
    expect(within(note).getByRole('link', { name: 'zakupki.gov.ru/…222' })).toBeInTheDocument()
    expect(note.textContent).not.toMatch(/\s:\s/)
  })

  it('«Сравнить версии» в меню версии открывает сравнение над отчётом', async () => {
    const user = userEvent.setup()
    addVersion2()
    server.use(
      http.get('/api/procurements/:id/reports/:a/diff/:b', ({ params }) =>
        HttpResponse.json({
          from_version: Number(params.a),
          to_version: Number(params.b),
          total: { before: '761250.00', after: '700000.00' },
          total_justified: { before: '761250.00', after: '700000.00' },
          positions: [],
          offers_moved: [],
          edits_added: [],
          edits_cancelled: [],
          rules_changed: [],
        }),
      ),
    )
    renderApp(`/p/${exampleId()}`)
    await screen.findByRole('heading', { name: 'Заголовок второй версии' })
    expect(screen.queryByRole('heading', { name: 'Сравнение версий' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Версия отчёта: 2' }))
    await user.click(screen.getByRole('button', { name: 'Сравнить версии' }))
    const region = screen.getByRole('region', { name: 'Сравнение версий' })
    expect(await within(region).findByText(/НМЦК: 761\s250,00\s₽ → 700\s000,00\s₽/)).toBeInTheDocument()
    await user.click(within(region).getByRole('button', { name: 'Закрыть сравнение' }))
    expect(screen.queryByRole('region', { name: 'Сравнение версий' })).not.toBeInTheDocument()
  })

  it('с одной версией пункта сравнения нет', async () => {
    const user = userEvent.setup()
    renderApp(`/p/${exampleId()}`)
    await user.click(await screen.findByRole('button', { name: 'Версия отчёта: 1' }))
    expect(screen.queryByRole('button', { name: 'Сравнить версии' })).not.toBeInTheDocument()
  })
})
