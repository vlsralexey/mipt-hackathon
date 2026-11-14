import type { ReactNode } from 'react'
import styles from './Markdown.module.css'

// Подмножество разметки из docs/api.md §5.3: абзацы, списки, **жирный**, ссылки.
// HTML не интерпретируется: всё, что не разметка, выводится текстом.

const inline = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g
const safeHref = /^(https?:\/\/|\/)/i

function renderInline(text: string): ReactNode[] {
  return text.split(inline).map((part, i) => {
    const bold = part.match(/^\*\*([^*]+)\*\*$/)
    if (bold) return <strong key={i}>{bold[1]}</strong>
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
    if (link) {
      if (!safeHref.test(link[2])) return link[1]
      const external = /^https?:/i.test(link[2])
      return (
        <a key={i} href={link[2]} {...(external && { target: '_blank', rel: 'noopener noreferrer' })}>
          {link[1]}
        </a>
      )
    }
    return part
  })
}

function renderLines(lines: string[]): ReactNode[] {
  return lines.flatMap((line, i) => (i === 0 ? renderInline(line) : [<br key={`br${i}`} />, ...renderInline(line)]))
}

const bullet = /^\s*[-*]\s+/
const numbered = /^\s*\d+[.)]\s+/

export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/)
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        if (lines.every((l) => bullet.test(l))) {
          return (
            <ul key={i} className={styles.list}>
              {lines.map((l, j) => (
                <li key={j}>{renderInline(l.replace(bullet, ''))}</li>
              ))}
            </ul>
          )
        }
        if (lines.every((l) => numbered.test(l))) {
          return (
            <ol key={i} className={styles.list}>
              {lines.map((l, j) => (
                <li key={j}>{renderInline(l.replace(numbered, ''))}</li>
              ))}
            </ol>
          )
        }
        return <p key={i}>{renderLines(lines)}</p>
      })}
    </>
  )
}
