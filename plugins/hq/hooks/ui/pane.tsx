import type { ElementTable, RenderElement, RenderNode } from 'claude-code'

import { DEFAULT_TOKENS } from '../config'
import { caretItem } from './caret'
import type { Action, Row, Seg, Sty, Tok } from './row'

/** ansi256 slots of the sheet's tokens (the validator refuses `ansi:<name>`). */
export const TOKENS = DEFAULT_TOKENS

export type DrawOpts = {
  el: ElementTable
  onAction: (key: string, action: Action) => void
  /** The Button the focus ring starts on when the pane takes the keys: a caret. */
  autoFocusKey?: string
  /** The resolved palette; the defaults when left out. */
  tokens?: Readonly<Record<Tok, string>>
}

function textProps(s: Sty, hovered: boolean, tokens: Readonly<Record<Tok, string>>) {
  const props: { color?: string; dimColor?: boolean; bold?: boolean; underline?: boolean; hover?: { dimColor?: boolean } } = {}
  if (s.c !== undefined) {
    props.color = tokens[s.c]
    // A colour may be dimmed too: the running dot's motion phase.
    if (s.dim) props.dimColor = true
  } else if (s.dim) {
    props.dimColor = true
    // Plain text on hover: dim runs come up to full strength under the pointer.
    if (hovered) props.hover = { dimColor: false }
  }
  if (s.bold) props.bold = true
  if (s.underline) props.underline = true
  return props
}

function drawRow(row: Row, o: DrawOpts, hovered: boolean): RenderElement {
  const { Box, Text, Button, Link } = o.el
  const segs = row.segs()
  if (segs.length === 0) return <Text> </Text>

  const styled = (s: Seg): RenderNode => {
    const props = textProps(s.s, hovered, o.tokens ?? TOKENS)
    const inner = Object.keys(props).length === 0 ? s.t : <Text {...props}>{s.t}</Text>
    return s.s.href !== undefined ? <Link href={s.s.href}>{inner}</Link> : inner
  }
  if (!segs.some(s => s.s.btn !== undefined)) {
    return <Text wrap="truncate">{segs.map(styled)}</Text>
  }

  const parts: RenderElement[] = []
  let run: Seg[] = []
  const flush = () => {
    if (run.length) parts.push(<Text wrap="truncate">{run.map(styled)}</Text>)
    run = []
  }
  for (const s of segs) {
    if (s.s.btn === undefined) {
      run.push(s)
      continue
    }
    flush()
    const spec = row.buttons.find(b => b.key === s.s.btn)
    if (!spec) {
      run.push({ ...s, s: { ...s.s, btn: undefined } })
      continue
    }
    const props: Parameters<typeof Button>[0] = {
      key: spec.key,
      label: spec.label,
      plain: true,
      onPress: () => o.onAction(spec.key, spec.action),
    }
    const caret = caretItem(spec.key) !== undefined
    if (spec.hotkey !== undefined) props.hotkey = spec.hotkey
    if (spec.dim) props.dimColor = true
    if (hovered && !caret) props.hover = { underline: true }
    if (o.autoFocusKey === spec.key) props.autoFocus = true
    // A Button's own props carry no weight: bold, underline and the caret's colour ride in a Text child.
    const look: { color?: string; bold?: boolean; underline?: boolean } = {}
    if (caret && s.s.c !== undefined) look.color = (o.tokens ?? TOKENS)[s.s.c]
    if (s.s.bold) look.bold = true
    if (s.s.underline) look.underline = true
    parts.push(Object.keys(look).length ? <Button {...props}>{<Text {...look}>{spec.label}</Text>}</Button> : <Button {...props} />)
  }
  flush()
  return (
    <Box flexDirection="row" height={1}>
      {parts}
    </Box>
  )
}

/** Rows to elements: each actionable item's lines share a keyed Box, so hovering any line lights all of them. */
export function drawPane(rows: readonly Row[], o: DrawOpts): RenderElement {
  const { Box } = o.el
  const out: RenderElement[] = []
  for (let i = 0; i < rows.length;) {
    const item = rows[i]!.item
    if (item === undefined) {
      out.push(drawRow(rows[i]!, o, false))
      i++
      continue
    }
    const group: Row[] = []
    while (i < rows.length && rows[i]!.item === item) group.push(rows[i++]!)
    out.push(
      <Box key={`row:${item}`} flexDirection="column">
        {group.map(r => drawRow(r, o, true))}
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}
