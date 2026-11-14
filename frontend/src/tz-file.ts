/** Форматы и размер ТЗ — по docs/api.md §3.2. */
export const TZ_EXTENSIONS = ['.docx', '.pdf', '.txt', '.md']
export const TZ_ACCEPT = TZ_EXTENSIONS.join(',')
export const TZ_MAX_BYTES = 20 * 1024 * 1024

/** Текст ошибки для файла, который бэкенд не примет; `null`, если файл подходит. */
export function tzFileError(file: File): string | null {
  const name = file.name.toLowerCase()
  if (!TZ_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return 'Формат не поддерживается. Нужен файл .docx, .pdf, .txt или .md.'
  }
  if (file.size > TZ_MAX_BYTES) return 'Файл больше 20 МБ.'
  return null
}
