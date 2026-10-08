import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { WaveRow } from '../../types'

/** Everything a pane drawing needs, read from state by the Pane render hook. */
export type PaneCtx = {
  /** Already sorted: red CI, conflicts/rebase, running, green, other, then merged. */
  rows: readonly WaveRow[]
  /** null while the first gh poll is still running. */
  polledAt: number | null
  /** ms since epoch; moves every 10 s and on each poll. */
  now: number
  /** Last gh failure, null when the last poll was clean. Rows may be stale or empty. */
  error: string | null
  isWaking: boolean
  /** Cells across the pane body (`e.props.bodyColumns`). */
  width: number
  /** Visible body rows (`e.props.scroll.bodyRows`); taller trees scroll. */
  bodyRows: number
  placement: 'dock' | 'inline'
  isFocused: boolean
  /** +1 per second while this style is `animated`, the pane is open and a PR's CI runs; still otherwise. */
  tick: number
  /** `$.ui.resolve(e)`; narrow on `surface === 'terminal'` before using Raster or Image. */
  el: ElementTable
  surface: RenderSurface
}

export type PaneStyleMeta = {
  id: string
  name: string
  tagline: string
  animated?: true
}

export type PaneStyle = {
  meta: PaneStyleMeta
  /** Synchronous and pure: no `$`, no state writes. */
  render: (ctx: PaneCtx) => RenderElement
  /** The status line while this style is active; without it, `logic.statusLine`. Pure, like `render`. */
  status?: (ctx: StatusCtx) => string | undefined
}

export type StatusCtx = Pick<PaneCtx, 'rows' | 'polledAt' | 'error' | 'now'>
