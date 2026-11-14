// Типы API. Источник правды — docs/api.md §5. Менять только вместе с контрактом.

/** Decimal с 2 знаками: "761250.00". Фронтенд только форматирует. */
export type Money = string
/** Decimal без фиксированной точности: "1.22", "0.0468", "2500". */
export type Dec = string
/** "2026-11-13" */
export type ISODate = string
/** "2026-11-13T10:20:00+03:00" */
export type ISODateTime = string
export interface Change<T> {
  before: T | null
  after: T | null
}

// ── Настройки и закупки ─────────────────────────────────────────────

export interface Settings {
  has_api_key: boolean
  key_source: 'settings' | 'env' | null
  model: string
}

export interface OpenRouterModel {
  id: string
  name: string
}

export type ProcurementStatus = 'new' | 'running' | 'needs_user' | 'ready' | 'failed'

export interface ProcurementSummary {
  id: string
  title: string
  created_at: ISODateTime
  updated_at: ISODateTime
  status: ProcurementStatus
  latest_version: number | null
  total: Money | null
  total_justified: Money | null
  positions_total: number
  positions_unjustified: number
}

export interface Procurement extends ProcurementSummary {
  filename: string | null
  agent_busy: boolean
  messages: Message[]
}

export interface VersionInfo {
  version: number
  created_at: ISODateTime
  cause: string
  total: Money | null
  total_justified: Money | null
}

// ── Сообщения чата ──────────────────────────────────────────────────

export interface MessageBase<K extends string, D> {
  id: string
  created_at: ISODateTime
  role: 'user' | 'agent' | 'system'
  kind: K
  text: string | null
  data: D
}

export type Message =
  | MessageBase<'text', null>
  | MessageBase<'file', FileData>
  | MessageBase<'tz_summary', TzSummary>
  | MessageBase<'question', Question>
  | MessageBase<'run', RunState>
  | MessageBase<'version', VersionCard>
  | MessageBase<'proposal', Proposal>
  | MessageBase<'source_blocked', SourceBlocked>
  | MessageBase<'error', ErrorData>

export interface FileData {
  filename: string
  size_bytes: number
}

export interface TzSummary {
  title: string
  positions: { index: number; name: string; quantity: Dec; unit: string }[]
}

export interface ErrorData {
  code: 'llm_auth' | 'llm_unavailable' | 'tz_parse_failed' | 'internal'
}

export interface Question {
  id: string
  position_index: number
  text: string
  hint: string | null
  options: string[]
  default_answer: string
  answer: string | null
}

export type SourceStatus = 'ok' | 'empty' | 'unavailable' | 'error' | 'needs_login' | 'skipped'

export interface RunStep {
  source_id: string
  name: string
  level: 1 | 2
  position_index: number
  status: 'queued' | 'running' | SourceStatus
  found: number
  relevant: number | null
  note: string | null
}

export interface RunState {
  run_id: string
  kind: 'full' | 'targeted' | 'user'
  state: 'running' | 'done' | 'failed'
  summary: string
  position_indexes: number[]
  started_at: ISODateTime
  finished_at: ISODateTime | null
  steps: RunStep[]
}

export interface PositionChange {
  index: number
  name: string
  status: Change<PositionStatus>
  unit_price: Change<Money>
  n: Change<number>
  cv: Change<Dec>
}

export interface OfferMove {
  offer_id: string
  label: string
  caption: string
  position_index: number
  to: 'included' | 'excluded'
  reason: string
}

export interface VersionDiff {
  from_version: number | null
  to_version: number
  total: Change<Money>
  total_justified: Change<Money>
  positions: PositionChange[]
  offers_moved: OfferMove[]
  edits_added: string[]
  edits_cancelled: string[]
  rules_changed: { key: string; title: string; before: string; after: string }[]
}

export interface VersionCard {
  version: number
  cause: string
  diff: VersionDiff
  edit_ids: string[]
  cancellable: boolean
}

export interface Proposal {
  id: string
  text: string
  diff: VersionDiff
  status: 'pending' | 'applied' | 'rejected' | 'expired'
}

export interface SourceBlocked {
  source_id: string
  name: string
  url: string
  reason: 'captcha' | 'login'
  status: 'waiting' | 'resolved' | 'skipped'
  /** Только при status 'waiting': когда источник пропустят и полный срок ожидания. */
  deadline?: ISODateTime | null
  wait_seconds?: number | null
}

// ── Отчёт ───────────────────────────────────────────────────────────

export type PositionStatus = 'ok' | 'insufficient' | 'heterogeneous'

export interface Characteristic {
  name: string
  value: string
  unit: string | null
  essential: boolean
}

export interface Position {
  index: number
  name: string
  unit: string
  quantity: Dec
  okpd2: string | null
  characteristics: Characteristic[]
  basis: { unit: string; per_tz_unit: Dec }
  search_terms: string[]
}

export interface Stats {
  n: number
  min: Money
  max: Money
  mean: Money
  std: Money
  cv: Dec
  outlier_rule: string
  median: Money
  lower_bound: Money | null
  upper_bound: Money | null
}

export interface Offer {
  id: string
  source_id: string
  source_name: string
  level: 1 | 2
  url: string
  retrieved_at: ISODateTime
  title: string
  price: Money
  currency: 'RUB'
  amount: Dec
  amount_unit: string
  vat: 'included' | 'excluded' | 'exempt' | 'unknown'
  vat_rate: Dec | null
  supplier: string | null
  supplier_inn: string | null
  delivery: 'included' | 'separate' | 'unknown'
  delivery_cost: Money | null
  delivery_free_from: Money | null
  delivery_note: string | null
  price_date: ISODate | null
  characteristics: Record<string, string>
}

export interface VatResolution {
  status: 'included' | 'added' | 'exempt' | 'unknown'
  factor: Dec
  note: string
}
export interface IndexResolution {
  status: 'applied' | 'not_needed' | 'no_data'
  factor: Dec
  note: string
}
export interface DeliveryResolution {
  status: 'included' | 'added' | 'unknown'
  added_per_unit: Money
  note: string
}

export interface CharComparison {
  name: string
  required: string
  offered: string | null
  essential: boolean
  ok: boolean | null
}

export type ExclusionReason =
  | 'anomalous_price'
  | 'incomparable'
  | 'unit_mismatch'
  | 'insufficient_data'
  | 'duplicate'
  | 'same_supplier'
  | 'user_excluded'

export type UserMark = 'corrected' | 'added' | 'excluded' | 'excluded_by_price' | 'included'

export interface OfferEntry {
  label: string
  caption: string
  offer: Offer
  base_price: Money | null
  vat: VatResolution | null
  indexation: IndexResolution | null
  delivery: DeliveryResolution | null
  normalized_price: Money | null
  comparison: CharComparison[]
  reason: string
  exclusion: ExclusionReason | null
  original: Record<string, string> | null
  user_marks: UserMark[]
}

export interface SkippedPage {
  url: string
  source_id: string
  reason: string
}

export interface PositionReport {
  position: Position
  status: PositionStatus
  levels_used: (1 | 2)[]
  included: OfferEntry[]
  excluded: OfferEntry[]
  stats: Stats | null
  unit_price: Money | null
  reference_price: Money | null
  total: Money | null
  assumptions: string[]
  spread_hints: string[]
  skipped_pages: SkippedPage[]
  excluded_by_user: boolean
}

export interface SourceRun {
  source_id: string
  name: string
  level: 1 | 2
  position_index: number
  queries: string[]
  status: SourceStatus
  error: string | null
  found: number
  at: ISODateTime
}

// ── Правки ──────────────────────────────────────────────────────────

export type EditKind =
  | 'exclude'
  | 'include'
  | 'correct_offer'
  | 'answer_question'
  | 'add_offer'
  | 'exclude_where'
  | 'edit_position'
  | 'local_setting'
  | 'rebase_settings'
  | 'exclude_position'

export interface Edit {
  id: string
  seq: number
  created_at: ISODateTime
  kind: EditKind
  position_index: number | null
  target: string | null
  payload: Record<string, unknown>
  reason: string
  reason_kind: 'characteristics' | 'source' | 'date' | 'supplier' | 'price' | 'other' | null
  origin: 'chat' | 'button'
  status: 'active' | 'cancelled' | 'superseded'
  summary: string
}

export interface AppliedEdit {
  edit: Edit
  applied: boolean
  effect: string
}

export interface Report {
  procurement_id: string
  version: number
  created_at: ISODateTime
  title: string
  calc_date: ISODate
  methodology: string
  cause: string
  positions: PositionReport[]
  sources: SourceRun[]
  questions: Question[]
  delivery_terms: string | null
  delivery_extras: string[]
  total: Money | null
  total_justified: Money | null
  warnings: string[]
  edits: AppliedEdit[]
  rules: Record<string, unknown>
  local_settings: string[]
}

// ── События SSE ─────────────────────────────────────────────────────

export interface ReportEvent {
  version: number
  cause: string
}
export interface AgentEvent {
  busy: boolean
}

/** Тело ошибки любого запроса. */
export interface ApiErrorBody {
  detail: string
}

export interface LocalSetting {
  key: string
  group: 'rules' | 'sources'
  title: string
  display: string
  global_display: string
  changed: boolean
  edit_id: string | null
}
export interface LocalSettings {
  items: LocalSetting[]
  base_outdated: { key: string; title: string; base: string; current: string }[]
}
export interface Config {
  sources: { id: string; name: string; level: 1 | 2; type: 'eis' | 'web'; enabled: boolean; sites: string[]; vat_default: 'included' | 'unknown'; vat_note: string | null; delivery_note: string | null }[]
  rules: { key: string; title: string; value: unknown; display: string; description: string }[]
}
export interface ConfigChange {
  id: string
  created_at: ISODateTime
  path: string
  title: string
  before: string
  after: string
  reason: string
  status: 'active' | 'cancelled'
}
export type BrowserTabState = 'loading' | 'reading' | 'needs_user' | 'skipped' | 'error' | 'done'
/** Вкладка управляемого браузера, см. docs/api.md §3.6. Новые поля необязательны для старого сервера. */
export interface BrowserTab {
  id: string
  url: string
  title: string
  procurement_id: string
  source_id: string
  status: string
  action: string
  blocked: boolean
  state?: BrowserTabState
  domain?: string
  source_name?: string
  position_index?: number
  needs?: 'captcha' | 'login' | null
  deadline?: ISODateTime | null
  wait_seconds?: number | null
  error?: string | null
  popup?: boolean
  controlled?: boolean
}
export interface BrowserFrame {
  tab_id: string
  data: string
  width: number
  height: number
  format?: 'jpeg' | 'png'
  scroll_x?: number
  scroll_y?: number
  source?: 'screencast' | 'snapshot'
}
export interface JournalEvent {
  id: number
  at: ISODateTime
  kind: 'opened' | 'found' | 'skipped' | 'waiting' | 'resolved' | 'error'
  text: string
  position_index: number | null
  source_id: string | null
  source_name: string | null
  domain: string
  url: string
  tab_id: string | null
  price: string | null
  amount: string | null
  unit: string | null
}
