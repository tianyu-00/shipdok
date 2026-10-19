import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RepoLink } from './repo-link'
import { repoUrl } from '@/lib/format'

describe('RepoLink', () => {
  it('links to the repository on GitHub, in a new tab', () => {
    render(<RepoLink repo="tianyu-00/shipdok-test-app" />)
    const a = screen.getByRole('link', { name: 'tianyu-00/shipdok-test-app' })
    expect(a).toHaveAttribute('href', 'https://github.com/tianyu-00/shipdok-test-app')
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
  })
  it('shows plain text when the value is not owner/repo', () => {
    render(<RepoLink repo="javascript:alert(1)" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument()
  })
  it('repoUrl rejects odd values', () => {
    expect(repoUrl('a/b/c')).toBeNull()
    expect(repoUrl('../x')).toBeNull()
    expect(repoUrl(undefined)).toBeNull()
  })
})
