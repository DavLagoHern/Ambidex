import type { GitStatus } from '@shared/types'

// El commit sigue teniendo prioridad cuando hay trabajo local o un borrador.
export function gitPrimaryAction(git: GitStatus, message: string, amend: boolean): 'commit' | 'pull' | 'push' {
  if (git.files.length || message.trim() || amend || git.operation) return 'commit'
  if (git.behind > 0) return 'pull'
  if (git.ahead > 0) return 'push'
  return 'commit'
}
