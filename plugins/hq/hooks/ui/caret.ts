// The caret: a one-cell Button at each item's cursor column, the only Button the pane's focus ring rests on,
// so the engine's inverse covers that cell instead of the item's title.

import type { Layout } from './layout'
import type { UiFocusInput } from 'claude-code'

const PREFIX = '^'

export const caretKey = (item: string): string => `${PREFIX}${item}`

/** The item a caret Button belongs to, or undefined for any other key. */
export const caretItem = (key: string): string | undefined => (key.startsWith(PREFIX) ? key.slice(PREFIX.length) : undefined)

/**
 * Where a person's ring move onto one of `owner`'s other Buttons goes instead: that item's caret.
 *
 * `ui.focus` names no direction. A title is the stop right after its own caret, so a move onto the
 * cursor item's own Buttons is a forward Tab and goes on to the next item's caret, wrapping; any other
 * item's (a backward Tab, a click elsewhere) takes that item's caret.
 */
export function ringTarget(items: readonly string[], cursor: string | null, owner: string): string | undefined {
  const i = items.indexOf(owner)
  if (i < 0) return undefined
  return owner === cursor ? items[(i + 1) % items.length] : owner
}

/** The item a press belongs to: a caret's, the owner of a title or other row Button, else the key itself. */
export const pressedItem = (l: Pick<Layout, 'owner'> | undefined, key: string): string => caretItem(key) ?? l?.owner[key] ?? key

/**
 * What the pane does with a ring move: pass it on (undefined), land it on another caret, or, when that
 * caret is off screen, scroll its item in first.
 */
export function ringMove(
  l: Pick<Layout, 'items' | 'owner' | 'rows'>,
  cursor: string | null,
  e: Pick<UiFocusInput, 'element' | 'origin'>,
): { caret: string } | { scrollTo: string } | undefined {
  if (e.element === undefined || e.origin.kind !== 'person' || caretItem(e.element) !== undefined) return undefined
  const owner = l.owner[e.element]
  const target = owner === undefined ? undefined : ringTarget(l.items, cursor, owner)
  if (target === undefined) return undefined
  return l.rows.some(r => r.head && r.item === target) ? { caret: caretKey(target) } : { scrollTo: target }
}
