import { USAGE_REFRESH_MS } from '@shared/types'

// Un solo sondeo para todas las ventanas. Los turnos simultáneos se agrupan.
export class UsageRefresh {
  private interval?: ReturnType<typeof setInterval>
  private turnTimer?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private stopped = false

  constructor(private readonly read: () => Promise<void>) {}

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (!this.pending) this.pending = this.read().finally(() => { this.pending = undefined })
    return this.pending
  }

  async refreshAfterChange() {
    await this.pending
    await this.refresh()
  }

  start() {
    if (this.interval || this.stopped) return
    void this.refresh()
    this.interval = setInterval(() => { void this.refresh() }, USAGE_REFRESH_MS)
    this.interval.unref?.()
  }

  afterTurn() {
    if (this.stopped) return
    clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(async () => {
      // Una consulta iniciada antes de acabar el turno puede devolver el uso antiguo.
      await this.refreshAfterChange()
    }, 1000)
    this.turnTimer.unref?.()
  }

  stop() {
    this.stopped = true
    clearInterval(this.interval)
    clearTimeout(this.turnTimer)
  }
}
