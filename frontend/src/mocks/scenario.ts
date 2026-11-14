import procurementExample from '../../../docs/api-examples/procurement.json'
import reportExample from '../../../docs/api-examples/report.json'
import type { Message, Procurement, Report, RunState } from '../api/types'
import { db } from './db'

/** Пауза между шагами сценария и ответ «агента» на сообщение, мс. Тесты могут обнулить. */
export const mockTiming = { agentReplyMs: 1200, stepMs: 900 }

const example = procurementExample as unknown as Procurement
const exampleReport = reportExample as unknown as Report
const find = <K extends Message['kind']>(kind: K) =>
  example.messages.find((m): m is Extract<Message, { kind: K }> => m.kind === kind)!

const now = () => new Date().toISOString()

/**
 * Первый прогон на моках: разбор ТЗ → ход поиска → версия 1. Данные — из примера контракта,
 * поэтому по ним нельзя судить о настоящих ценах.
 */
export function startMockRun(id: string) {
  const p = db.procurements.get(id)
  if (!p) return
  const runId = db.nextId('m')
  const run = find('run')
  const runningState: RunState = {
    ...run.data,
    run_id: db.nextId('run'),
    state: 'running',
    summary: 'Ищу предложения',
    started_at: now(),
    finished_at: null,
    steps: run.data.steps.map((s, i) => ({
      ...s,
      status: i < 2 ? 'running' : 'queued',
      found: 0,
      relevant: null,
    })),
  }
  const putRun = (data: RunState, text: string | null = null) =>
    db.addMessage(id, { id: runId, created_at: runStart, role: 'system', kind: 'run', text, data })
  const runStart = now()

  p.status = 'running'
  p.agent_busy = true
  db.publishSummary(id)
  db.publish(id, { event: 'agent', data: { busy: true } })

  const summary = find('tz_summary')
  db.addMessage(id, {
    ...summary,
    id: db.nextId('m'),
    created_at: now(),
    data: { ...summary.data, title: p.title },
  })
  putRun(runningState)

  // Уточняющий вопрос приходит по ходу прогона: в интерфейсе он всплывает окошком.
  const question = find('question')
  db.addMessage(id, {
    ...question,
    id: db.nextId('m'),
    created_at: now(),
    data: { ...question.data, answer: null },
  })
  // Второй вопрос: окно показывает «Вопрос 1 из 2» и листание.
  db.addMessage(id, {
    ...question,
    id: db.nextId('m'),
    created_at: now(),
    data: {
      id: 'q2-1',
      position_index: 2,
      text: 'Допускать плотность от 60 до 70 г/м² вместо 65?',
      hint: null,
      options: ['Нет, только 65 г/м²', 'Да, от 60 до 70 г/м²'],
      default_answer: 'Нет, только 65 г/м²',
      answer: null,
    },
  })

  const step = mockTiming.stepMs
  setTimeout(() => {
    if (db.procurements.get(id) !== p) return // база сброшена (тесты)
    putRun({
      ...runningState,
      summary: 'Проверено 1 источник, ищу дальше',
      steps: run.data.steps.map((s, i) => (i < 2 ? s : { ...s, status: 'running', found: 0, relevant: null })),
    })
  }, step)

  setTimeout(() => {
    if (db.procurements.get(id) !== p) return
    putRun({ ...run.data, run_id: runningState.run_id, started_at: runningState.started_at, finished_at: now() })

    const version = find('version')
    db.addMessage(id, { ...version, id: db.nextId('m'), created_at: now() })
    const agent = find('text')
    db.addMessage(id, { ...agent, id: db.nextId('m'), created_at: now() })

    const report: Report = { ...structuredClone(exampleReport), procurement_id: id, title: p.title }
    db.reports.set(id, [report])
    Object.assign(p, {
      status: 'ready',
      agent_busy: false,
      latest_version: report.version,
      total: report.total,
      total_justified: report.total_justified,
      positions_total: report.positions.length,
      positions_unjustified: report.positions.filter((x) => x.status !== 'ok').length,
      updated_at: now(),
    })
    db.publish(id, { event: 'report', data: { version: report.version, cause: report.cause } })
    db.publishSummary(id)
    db.publish(id, { event: 'agent', data: { busy: false } })
  }, step * 2)
}
