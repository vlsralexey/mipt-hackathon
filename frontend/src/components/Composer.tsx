import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { formatSize } from '../format'
import { TZ_ACCEPT, tzFileError } from '../tz-file'
import { Icon } from './Icon'
import styles from './Composer.module.css'

interface ComposerProps {
  text: string
  onTextChange: (text: string) => void
  /** Если передан `onFileChange`, в поле появляется скрепка и приём файла ТЗ. */
  file?: File | null
  onFileChange?: (file: File | null) => void
  placeholder: string
  label: string
  pending?: boolean
  /** Ошибка отправки, пришедшая от родителя. */
  error?: string | null
  onSubmit: () => void
}

/** Поле ввода: текст, по желанию файл ТЗ; Enter отправляет, Shift+Enter — новая строка. */
export function Composer({
  text,
  onTextChange,
  file = null,
  onFileChange,
  placeholder,
  label,
  pending = false,
  error = null,
  onSubmit,
}: ComposerProps) {
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const canSubmit = !pending && (text.trim() !== '' || file !== null)

  function accept(candidate: File | undefined) {
    if (!candidate || !onFileChange) return
    const problem = tzFileError(candidate)
    setFileError(problem)
    if (!problem) onFileChange(candidate)
  }

  function submit() {
    if (canSubmit) onSubmit()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (!pending) accept(e.dataTransfer.files[0])
  }

  const message = fileError ?? error

  return (
    <div className={styles.wrap}>
      <div
        className={`${styles.composer} ${dragging ? styles.dragging : ''}`}
        onDragOver={(e) => {
          if (!onFileChange) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onFileChange ? onDrop : undefined}
      >
        {file && (
          <div className={styles.attach}>
            <Icon name="doc" />
            <span className={styles.attachText}>
              <span className={styles.attachName}>{file.name}</span>
              <span className={styles.attachSize}>{formatSize(file.size)}</span>
            </span>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Убрать файл"
              disabled={pending}
              onClick={() => onFileChange?.(null)}
            >
              <Icon name="x" />
            </button>
          </div>
        )}
        <textarea
          rows={2}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          disabled={pending}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.row}>
          {onFileChange && (
            <>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Приложить файл"
                disabled={pending}
                onClick={() => input.current?.click()}
              >
                <Icon name="clip" />
              </button>
              <input
                ref={input}
                type="file"
                hidden
                accept={TZ_ACCEPT}
                data-testid="file-input"
                onChange={(e) => {
                  accept(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </>
          )}
          <span className={styles.spacer} />
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.send}`}
            aria-label="Отправить"
            disabled={!canSubmit}
            onClick={submit}
          >
            <Icon name="up" />
          </button>
        </div>
      </div>
      {message && (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}
    </div>
  )
}
