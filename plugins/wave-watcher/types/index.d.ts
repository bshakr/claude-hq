export type WaveCi =
  | { kind: 'green' }
  | { kind: 'red'; failing: string }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'none' }

export type WaveMerge = 'mergeable' | 'conflicting' | 'needs rebase' | 'unknown'

export type WaveGallery = 'linked' | 'no visual change' | 'none'

export type WaveRow = {
  url: string
  repo: string
  number: number
  title: string
  status: 'open' | 'merged'
  isDraft: boolean
  ci: WaveCi
  merge: WaveMerge
  gallery: WaveGallery
  /** When this watcher first saw it merged (ms since epoch); null while open. */
  mergedAt: number | null
}

export type WaveTransition =
  | { kind: 'ci-red'; row: WaveRow; failing: string }
  | { kind: 'merged'; row: WaveRow; others: number[] }
  | { kind: 'conflicting' | 'needs rebase'; row: WaveRow }

declare module 'claude-code' {
  interface PluginState {
    'wave-watcher': {
      rows: WaveRow[]
      /** null until the first poll has finished. */
      polledAt: number | null
      error: string | null
      wake: boolean
      /** Ticks every 10s so "polled Xs ago" stays current. */
      now: number
      /** Id of the active pane style (hooks/styles). */
      style: string
      /** Motion counter: +1 every 10s, every 1s while an animated style's pane is open. */
      tick: number
    }
  }
}
