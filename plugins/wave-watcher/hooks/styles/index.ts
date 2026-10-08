import { style as classic } from './classic'
import { style as d1 } from './d1'
import { style as d2 } from './d2'
import { style as d3 } from './d3'
import { style as d4 } from './d4'
import { style as d5 } from './d5'
import type { PaneStyle } from './types'

export type { PaneCtx, PaneStyle } from './types'

export const DEFAULT_STYLE = 'classic'

export const STYLES: readonly PaneStyle[] = [classic, d1, d2, d3, d4, d5]

export function styleById(id: string): PaneStyle | undefined {
  return STYLES.find(one => one.meta.id === id)
}
