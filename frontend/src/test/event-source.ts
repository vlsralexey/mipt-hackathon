import { EventSource as NodeEventSource } from 'eventsource'

// jsdom и Node без флага не имеют EventSource, а MSW нужен он для SSE-моков.
// Полифил Node не понимает относительные адреса, поэтому, как браузер, считаем их от location.
// Модуль подключается первым в setup.ts, до импорта обработчиков.
class TestEventSource extends NodeEventSource {
  constructor(url: string | URL, init?: ConstructorParameters<typeof NodeEventSource>[1]) {
    super(new URL(url, globalThis.location?.href ?? 'http://localhost:3000').href, init)
  }
}

globalThis.EventSource = TestEventSource as unknown as typeof globalThis.EventSource
