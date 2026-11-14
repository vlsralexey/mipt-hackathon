import type {
  ApiErrorBody,
  Config,
  ConfigChange,
  LocalSettings,
  VersionDiff,
  Edit,
  Message,
  OpenRouterModel,
  Procurement,
  ProcurementSummary,
  Report,
  Settings,
  VersionInfo,
} from './types'

/** Ошибка API: `detail` — готовый текст для пользователя. */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, init)
  } catch {
    throw new ApiError(0, 'Нет связи с сервером. Проверьте, что бэкенд запущен.')
  }
  if (!response.ok) {
    let detail = 'Не удалось выполнить запрос'
    try {
      const body = (await response.json()) as Partial<ApiErrorBody>
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      // тело не JSON — остаётся общий текст
    }
    throw new ApiError(response.status, detail)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export interface NewProcurementInput {
  file?: File
  tzText?: string
  message?: string
}

export const api = {
  checkSettings: () => request<{ ok: boolean; detail: string | null }>('/settings/check', json('POST', {})),
  getConfig: () => request<Config>('/config'),
  getConfigChanges: () => request<ConfigChange[]>('/config/changes'),
  getConfigMessages: () => request<Message[]>('/config/messages'),
  sendConfigMessage: (text: string) => request<Message>('/config/messages', json('POST', { text })),
  resolveConfigProposal: (id: string, action: 'apply' | 'reject') => request<unknown>(`/config/proposals/${id}/${action}`, json('POST', {})),
  cancelConfigChange: (id: string) => request<unknown>(`/config/changes/${id}/cancel`, json('POST', {})),
  getLocalSettings: (id: string) => request<LocalSettings>(`/procurements/${id}/settings`),
  rebaseSettings: (id: string) => request<unknown>(`/procurements/${id}/settings/rebase`, json('POST', {})),
  resolveProposal: (pid: string, id: string, action: 'apply' | 'reject') => request<unknown>(`/procurements/${pid}/proposals/${id}/${action}`, json('POST', {})),
  skipSource: (pid: string, source: string) => request<unknown>(`/procurements/${pid}/sources/${source}/skip`, json('POST', {})),
  getVersionDiff: (id: string, a: number, b: number) => request<VersionDiff>(`/procurements/${id}/reports/${a}/diff/${b}`),
  getSettings: () => request<Settings>('/settings'),
  listModels: () => request<OpenRouterModel[]>('/settings/models'),
  putSettings: (patch: { openrouter_api_key?: string; model?: string }) =>
    request<Settings>('/settings', json('PUT', patch)),

  listProcurements: () => request<ProcurementSummary[]>('/procurements'),
  getProcurement: (id: string) => request<Procurement>(`/procurements/${id}`),
  createProcurement: ({ file, tzText, message }: NewProcurementInput) => {
    const form = new FormData()
    if (file) form.set('file', file)
    if (tzText) form.set('tz_text', tzText)
    if (message) form.set('message', message)
    return request<Procurement>('/procurements', { method: 'POST', body: form })
  },
  runProcurement: (id: string) =>
    request<{ run_id: string }>(`/procurements/${id}/run`, { method: 'POST' }),

  sendMessage: (id: string, text: string, viewingVersion?: number) =>
    request<Message>(
      `/procurements/${id}/messages`,
      json('POST', { text, viewing_version: viewingVersion }),
    ),
  answerQuestion: (id: string, questionId: string, answer: string) =>
    request<unknown>(`/procurements/${id}/questions/${questionId}/answer`, json('POST', { answer })),

  listReports: (id: string) => request<VersionInfo[]>(`/procurements/${id}/reports`),
  getReport: (id: string, version: number | 'latest') =>
    request<Report>(`/procurements/${id}/reports/${version}`),
  exportDocxUrl: (id: string, version: number) =>
    `/api/procurements/${id}/reports/${version}/export.docx`,

  listEdits: (id: string) => request<Edit[]>(`/procurements/${id}/edits`),
  cancelEdits: (id: string, editIds: string[]) =>
    request<unknown>(`/procurements/${id}/edits/cancel`, json('POST', { edit_ids: editIds })),
}
