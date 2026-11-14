import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError } from '../api/client'
import buildingUrl from '../assets/mipt-building.png'
import { Composer } from '../components/Composer'
import styles from './NewProcurementPage.module.css'

export interface RunNoticeState {
  runError?: string
}

/**
 * Новая закупка: файл ТЗ или вставленный текст (docs/api.md §2).
 * Текст без файла — это само ТЗ (`tz_text`), текст рядом с файлом — сообщение (`message`).
 */
export function NewProcurementPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const create = useMutation({
    mutationFn: async () => {
      const body = text.trim()
      const procurement = await api.createProcurement(
        file ? { file, message: body || undefined } : { tzText: body },
      )
      // Закупка уже создана; если запуск не удался, её не теряем, а открываем с уведомлением.
      let runError: string | null = null
      try {
        await api.runProcurement(procurement.id)
      } catch (e) {
        // 409 — прогон уже идёт, это не ошибка для пользователя
        if (!(e instanceof ApiError && e.status === 409)) {
          runError = e instanceof ApiError ? e.message : 'Не удалось запустить поиск.'
        }
      }
      return { procurement, runError }
    },
    onSuccess: ({ procurement, runError }) => {
      queryClient.setQueryData(['procurement', procurement.id], procurement)
      void queryClient.invalidateQueries({ queryKey: ['procurements'] })
      const state: RunNoticeState | undefined = runError ? { runError } : undefined
      void navigate(`/p/${procurement.id}`, { state })
    },
  })

  return (
    <div className={styles.page}>
      <div className={styles.stack}>
        <div className={styles.intro}>
          <h1>Новая закупка</h1>
          <p>Приложите техническое задание или вставьте его текст.</p>
        </div>
        <Composer
          text={text}
          onTextChange={setText}
          file={file}
          onFileChange={setFile}
          placeholder={file ? 'Добавьте пожелания к расчёту (необязательно)' : 'Вставьте текст ТЗ или перетащите файл'}
          label="Техническое задание"
          pending={create.isPending}
          error={create.error?.message ?? null}
          onSubmit={() => create.mutate()}
        />
        <p className={styles.formats}>.docx, .pdf, .txt или .md, до 20&nbsp;МБ</p>
      </div>
      {/* Главное здание МФТИ стоит на нижнем краю, как горизонт; украшение, не содержимое */}
      <img className={styles.building} src={buildingUrl} alt="" width={1400} height={559} />
    </div>
  )
}
