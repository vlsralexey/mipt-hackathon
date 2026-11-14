import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

describe('Markdown', () => {
  it('абзацы, жирный и перенос строки', () => {
    const { container } = render(<Markdown text={'Первый **важный** абзац\nвторая строка\n\nВторой абзац'} />)
    expect(container.querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByText('важный').tagName).toBe('STRONG')
    expect(container.querySelector('br')).not.toBeNull()
  })

  it('маркированный и нумерованный списки', () => {
    const { container } = render(<Markdown text={'- один\n- два\n\n1. раз\n2. два'} />)
    expect(container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('внешние ссылки открываются безопасно, неизвестные схемы, только текстом', () => {
    render(<Markdown text={'[ЕИС](https://zakupki.example/x) и [опасно](javascript:alert(1))'} />)
    const link = screen.getByRole('link', { name: 'ЕИС' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('link', { name: 'опасно' })).not.toBeInTheDocument()
    expect(screen.getByText(/опасно/)).toBeInTheDocument()
  })

  it('не интерпретирует HTML', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> <b>тег</b>'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container).toHaveTextContent('<b>тег</b>')
  })
})
