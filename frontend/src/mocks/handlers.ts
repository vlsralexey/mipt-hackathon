import { HttpResponse, http, sse } from 'msw'
import type { Message, Procurement, Proposal } from '../api/types'
import { CONFIG_CHANNEL, db, summaryOf } from './db'
import { mockTiming, startMockRun } from './scenario'

export { mockTiming }

// В jsdom и Node разные классы File, поэтому instanceof не годится.
const fileOf = (v: FormDataEntryValue | null): File | null => (v !== null && typeof v !== 'string' ? v : null)

const notFound = (detail: string) => HttpResponse.json({ detail }, { status: 404 })

export const handlers = [
  http.get('/api/health', () => HttpResponse.json({ status: 'ok' })),

  http.get('/api/settings', () => HttpResponse.json(db.settings)),
  http.get('/api/settings/models', () => HttpResponse.json([
    { id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4' },
    { id: 'openai/gpt-4.1-mini', name: 'OpenAI: GPT-4.1 Mini' },
  ])),
  http.put('/api/settings', async ({ request }) => {
    const patch = (await request.json()) as { openrouter_api_key?: string; model?: string }
    if (patch.openrouter_api_key !== undefined) {
      const has = patch.openrouter_api_key !== ''
      db.settings.has_api_key = has
      db.settings.key_source = has ? 'settings' : null
    }
    if (patch.model !== undefined) db.settings.model = patch.model
    return HttpResponse.json(db.settings)
  }),

  http.post('/api/settings/check', () => HttpResponse.json(
    db.settings.has_api_key ? { ok: true, detail: null } : { ok: false, detail: 'Ключ не задан' },
  )),

  ...configHandlers(),

  http.get('/api/procurements/:id/settings', ({ params }) => {
    if (!db.procurements.has(String(params.id))) return notFound('Закупка не найдена')
    const local = db.config.rules.filter((r) => !TECHNICAL_RULES.has(r.key))
    return HttpResponse.json({
      items: [
        ...local.map((r) => ({ key: `rules.${r.key}`, group: 'rules', title: r.title, display: r.display, global_display: r.display, changed: false, edit_id: null })),
        ...db.config.sources.flatMap((s) => [
          { key: `sources.${s.id}.enabled`, group: 'sources', title: `${s.name}: включён`, display: s.enabled ? 'Да' : 'Нет', global_display: s.enabled ? 'Да' : 'Нет', changed: false, edit_id: null },
          { key: `sources.${s.id}.sites`, group: 'sources', title: `${s.name}: сайты`, display: s.sites.join(', ') || 'Список пуст', global_display: s.sites.join(', ') || 'Список пуст', changed: false, edit_id: null },
        ]),
      ],
      base_outdated: [],
    })
  }),

  http.post('/api/procurements/:id/settings/rebase', () => HttpResponse.json({}, { status: 202 })),

  http.get('/api/procurements', () => {
    const list = [...db.procurements.values()].map(summaryOf)
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return HttpResponse.json(list)
  }),

  http.post('/api/procurements', async ({ request }) => {
    const form = await request.formData()
    const file = fileOf(form.get('file'))
    const tzText = form.get('tz_text')
    const message = form.get('message')
    if (!file && typeof tzText !== 'string') {
      return HttpResponse.json({ detail: 'Приложите файл ТЗ или вставьте текст.' }, { status: 400 })
    }
    const now = new Date().toISOString()
    const id = db.nextId('p')
    const filename = file ? file.name : null
    const messages: Message[] = []
    if (file) {
      messages.push({
        id: db.nextId('m'),
        created_at: now,
        role: 'user',
        kind: 'file',
        text: null,
        data: { filename: file.name, size_bytes: file.size },
      })
    } else if (typeof tzText === 'string') {
      messages.push({
        id: db.nextId('m'),
        created_at: now,
        role: 'user',
        kind: 'text',
        text: tzText,
        data: null,
      })
    }
    if (typeof message === 'string' && message) {
      messages.push({
        id: db.nextId('m'),
        created_at: now,
        role: 'user',
        kind: 'text',
        text: message,
        data: null,
      })
    }
    const procurement: Procurement = {
      id,
      title: filename ? filename.replace(/\.[^.]+$/, '') : 'Новая закупка',
      created_at: now,
      updated_at: now,
      status: 'new',
      latest_version: null,
      total: null,
      total_justified: null,
      positions_total: 0,
      positions_unjustified: 0,
      filename,
      agent_busy: false,
      messages,
    }
    db.procurements.set(id, procurement)
    return HttpResponse.json(procurement, { status: 201 })
  }),

  http.get('/api/procurements/:id', ({ params }) => {
    const p = db.procurements.get(String(params.id))
    return p ? HttpResponse.json(p) : notFound('Закупка не найдена')
  }),

  http.post('/api/procurements/:id/run', ({ params }) => {
    const id = String(params.id)
    if (!db.procurements.has(id)) return notFound('Закупка не найдена')
    if (!db.settings.has_api_key) {
      return HttpResponse.json(
        { detail: 'Не задан ключ OpenRouter. Укажите его в настройках.' },
        { status: 400 },
      )
    }
    startMockRun(id)
    return HttpResponse.json({ run_id: db.nextId('run') }, { status: 202 })
  }),

  sse('/api/procurements/:id/events', ({ params, client }) => {
    const id = String(params.id)
    // Служебная строка сразу открывает поток: без неё клиент не получает `open`.
    client.send({ retry: 3000 })
    const unsubscribe = db.subscribe(id, (e) => {
      try {
        client.send({ event: e.event, data: e.data } as never)
      } catch {
        unsubscribe() // соединение закрыто
      }
    })
  }),

  http.post('/api/procurements/:id/messages', async ({ params, request }) => {
    const id = String(params.id)
    const p = db.procurements.get(id)
    if (!p) return notFound('Закупка не найдена')
    const body = (await request.json()) as { text?: string }
    if (!body.text?.trim()) {
      return HttpResponse.json({ detail: 'Пустое сообщение' }, { status: 400 })
    }
    const user: Message = {
      id: db.nextId('m'),
      created_at: new Date().toISOString(),
      role: 'user',
      kind: 'text',
      text: body.text,
      data: null,
    }
    db.addMessage(id, user)
    db.publish(id, { event: 'agent', data: { busy: true } })
    setTimeout(() => {
      db.addMessage(id, {
        id: db.nextId('m'),
        created_at: new Date().toISOString(),
        role: 'agent',
        kind: 'text',
        text: 'Это ответ-заглушка: бэкенд ещё не подключён.',
        data: null,
      })
      db.publish(id, { event: 'agent', data: { busy: false } })
    }, mockTiming.agentReplyMs)
    return HttpResponse.json(user, { status: 202 })
  }),

  http.post('/api/procurements/:id/questions/:qid/answer', async ({ params, request }) => {
    const id = String(params.id)
    const p = db.procurements.get(id)
    const message = p?.messages.find((m) => m.kind === 'question' && m.data.id === params.qid)
    if (!message || message.kind !== 'question') return notFound('Вопрос не найден')
    const { answer } = (await request.json()) as { answer: string }
    db.addMessage(id, { ...message, data: { ...message.data, answer } })
    return HttpResponse.json({}, { status: 202 })
  }),

  http.get('/api/procurements/:id/reports', ({ params }) => {
    const id = String(params.id)
    return db.procurements.has(id) ? HttpResponse.json(db.versions(id)) : notFound('Закупка не найдена')
  }),

  http.get('/api/procurements/:id/reports/:version', ({ params }) => {
    const reports = db.reports.get(String(params.id)) ?? []
    const v = String(params.version)
    const report = v === 'latest' ? reports.at(-1) : reports.find((r) => r.version === Number(v))
    return report ? HttpResponse.json(report) : notFound('Версия отчёта не найдена')
  }),

  http.get('/api/procurements/:id/reports/:version/export.docx', ({ params }) => {
    const reports = db.reports.get(String(params.id)) ?? []
    if (!reports.some((r) => r.version === Number(params.version))) return notFound('Версия отчёта не найдена')
    // заглушка: настоящий DOCX соберёт бэкенд
    return new HttpResponse('мок: здесь будет DOCX', {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('НМЦК, версия ' + params.version)}.docx`,
      },
    })
  }),

  http.get('/api/procurements/:id/edits', ({ params }) => {
    const id = String(params.id)
    return db.procurements.has(id) ? HttpResponse.json(db.edits(id)) : notFound('Закупка не найдена')
  }),

  http.post('/api/procurements/:id/edits/cancel', () => HttpResponse.json({}, { status: 202 })),
]

// ── Агент общих настроек ─────────────────────────────────────────────
// Заглушка: на любое сообщение с числом предлагает новый порог разброса.

const TECHNICAL_RULES = new Set(['methodology_note', 'max_pages_per_source', 'page_text_limit', 'spread_hint_min_gap', 'marketplace_hosts'])
const proposalPaths = new Map<string, { key: string; after: string; before: string; reason: string }>()

function emptyDiff(rule: { key: string; title: string; before: string; after: string }) {
  return {
    from_version: null, to_version: 0,
    total: { before: null, after: null }, total_justified: { before: null, after: null },
    positions: [], offers_moved: [], edits_added: [], edits_cancelled: [], rules_changed: [rule],
  }
}

function setRule(key: string, display: string) {
  const rule = db.config.rules.find((r) => r.key === key)
  if (rule) rule.display = display
  db.publish(CONFIG_CHANNEL, { event: 'config', data: {} })
}

function configHandlers() {
  return [
    http.get('/api/config', () => HttpResponse.json(db.config)),
    http.get('/api/config/changes', () => HttpResponse.json(db.configChanges)),
    http.get('/api/config/messages', () => HttpResponse.json(db.configMessages)),
    sse('/api/config/events', ({ client }) => {
      client.send({ retry: 3000 })
      const unsubscribe = db.subscribe(CONFIG_CHANNEL, (e) => {
        try {
          client.send({ event: e.event, data: e.data } as never)
        } catch {
          unsubscribe()
        }
      })
    }),
    http.post('/api/config/messages', async ({ request }) => {
      const body = (await request.json()) as { text?: string }
      if (!body.text?.trim()) return HttpResponse.json({ detail: 'Пустое сообщение' }, { status: 400 })
      const user: Message = { id: db.nextId('m'), created_at: new Date().toISOString(), role: 'user', kind: 'text', text: body.text, data: null }
      db.addConfigMessage(user)
      db.publish(CONFIG_CHANNEL, { event: 'agent', data: { busy: true } })
      const config = db.config
      setTimeout(() => {
        if (db.config !== config) return // база сброшена (тесты)
        const rule = config.rules.find((r) => r.key === 'cv_threshold')!
        const number = /\d+/.exec(body.text ?? '')?.[0] ?? '25'
        const after = `${number} %`
        const id = db.nextId('cp')
        const title = 'Порог разброса'
        proposalPaths.set(id, { key: rule.key, after, before: rule.display, reason: body.text ?? '' })
        const data: Proposal = {
          id, status: 'pending',
          text: `${title}: ${rule.display} → ${after}. Действует на новые закупки и новые поиски. Посчитанные закупки не изменятся.`,
          diff: emptyDiff({ key: `rules.${rule.key}`, title, before: rule.display, after }) as unknown as Proposal['diff'],
        }
        db.addConfigMessage({ id: db.nextId('m'), created_at: new Date().toISOString(), role: 'agent', kind: 'proposal', text: null, data })
        db.publish(CONFIG_CHANNEL, { event: 'agent', data: { busy: false } })
      }, mockTiming.agentReplyMs)
      return HttpResponse.json(user, { status: 202 })
    }),
    http.post('/api/config/proposals/:pid/:action', ({ params }) => {
      const id = String(params.pid)
      const message = db.configMessages.find((m) => m.kind === 'proposal' && m.data.id === id)
      const meta = proposalPaths.get(id)
      if (!message || message.kind !== 'proposal' || !meta) return notFound('Предложение не найдено')
      const apply = params.action === 'apply'
      db.addConfigMessage({ ...message, data: { ...message.data, status: apply ? 'applied' : 'rejected' } })
      if (apply) {
        db.configChanges.unshift({
          id: db.nextId('cc'), created_at: new Date().toISOString(), path: `rules.${meta.key}`,
          title: 'Порог разброса', before: meta.before, after: meta.after, reason: meta.reason, status: 'active',
        })
        setRule(meta.key, meta.after)
      }
      return HttpResponse.json({}, { status: apply ? 202 : 200 })
    }),
    http.post('/api/config/changes/:cid/cancel', ({ params }) => {
      const change = db.configChanges.find((c) => c.id === params.cid)
      if (!change) return notFound('Изменение не найдено')
      change.status = 'cancelled'
      setRule(change.path.split('.').at(-1)!, change.before)
      return HttpResponse.json({}, { status: 202 })
    }),
  ]
}
