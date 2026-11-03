import { describe, expect, it } from 'vitest'
import type { GitStatus } from '../src/shared/types'
import { gitPrimaryAction } from '../src/renderer/src/lib/git-primary-action'

const clean: GitStatus = { isRepo: true, ahead: 0, behind: 0, files: [] }

describe('acción principal de Git', () => {
  it('ofrece subir o bajar cuando no hay un commit en preparación', () => {
    expect(gitPrimaryAction({ ...clean, ahead: 2 }, '', false)).toBe('push')
    expect(gitPrimaryAction({ ...clean, behind: 3 }, '  ', false)).toBe('pull')
    expect(gitPrimaryAction({ ...clean, ahead: 1, behind: 1 }, '', false)).toBe('pull')
    expect(gitPrimaryAction(clean, '', false)).toBe('commit')
  })

  it('mantiene commit al editar un mensaje, preparar archivos o resolver una operación', () => {
    const ahead = { ...clean, ahead: 1 }
    expect(gitPrimaryAction(ahead, 'mensaje', false)).toBe('commit')
    expect(gitPrimaryAction(ahead, '', true)).toBe('commit')
    expect(gitPrimaryAction({ ...ahead, operation: 'merge' }, '', false)).toBe('commit')
    expect(gitPrimaryAction({ ...ahead, files: [{ path: 'nuevo', index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflicted: false }] }, '', false)).toBe('commit')
  })
})
