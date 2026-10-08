import type { ElementTable, RenderElement, RenderNode } from 'claude-code'

import type { Action, Row, Seg, Sty, Tok } from './row'

/** ansi256 slots of the sheet's tokens (the validator refuses `ansi:<name>`). */
export const TOKENS: Record<Tok, string> = {
  fail: 'ansi256(1)',
  wait: 'ansi256(3)',
  run: 'ansi256(4)',
  ok: 'ansi256(2)',
  accent: 'ansi256(6)',
  rule: 'ansi256(8)',
}

export type DrawOpts = {
  el: ElementTable
  onAction: (key: string, action: Action) => void
  /** The Button the focus ring starts on when the pane takes the keys. */
  autoFocusKey?: string
}

function textProps(s: Sty, hovered: boolean) {
  const props: { color?: string; dimColor?: boolean; bold?: boolean; hover?: { dimColor?: boolean } } = {}
  if (s.c !== undefined) {
    props.color = TOKENS[s.c]
    // A colour may be dimmed too: the running dot's motion phase.
    if (s.dim) props.dimColor = true
  } else if (s.dim) {
    props.dimColor = true
    // Plain text on hover: dim runs come up to full strength under the pointer.
    if (hovered) props.hover = { dimColor: false }
  }
  if (s.bold) props.bold = true
  return props
}

function drawRow(row: Row, o: DrawOpts, hovered: boolean): RenderElement {
  const { Box, Text, Button, Link } = o.el
  const segs = row.segs()
  if (segs.length === 0) return <Text> </Text>

  const styled = (s: Seg): RenderNode => {
    const props = textProps(s.s, hovered)
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
    if (spec.hotkey !== undefined) props.hotkey = spec.hotkey
    if (spec.dim) props.dimColor = true
    if (hovered) props.hover = { underline: true }
    if (o.autoFocusKey === spec.key) props.autoFocus = true
    parts.push(<Button {...props} />)
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
  for (let i = 0; i < rows.length; ) {
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
