import { agoText, dotOf, stateLine, truncate } from '../logic'
import type { Dot } from '../logic'
import type { PaneCtx, PaneStyle } from './types'

const DOT_COLOR: Record<Dot, string | undefined> = {
  green: 'success',
  red: 'error',
  amber: 'warning',
  grey: undefined,
}

function render(ctx: PaneCtx) {
  const { Box, Text } = ctx.el
  const { rows: list, polledAt: at, now: clock, error: lastError, isWaking } = ctx
  const width = Math.max(20, ctx.width)
  const openCount = list.filter(row => row.status === 'open').length

  return (
    <Box flexDirection="column">
      <Text bold>
        Wave: {openCount} open PRs, {agoText(at, Math.max(clock, at ?? 0))}
      </Text>
      {list.length === 0 && <Text dimColor>{at === null ? 'Polling GitHub…' : 'No open PRs.'}</Text>}
      {list.map(row => {
        const color = DOT_COLOR[dotOf(row)]
        const head = `${row.repo}#${row.number} `
        return (
          <Box key={row.url} flexDirection="column" marginTop={1}>
            <Text wrap="truncate">
              {color === undefined ? <Text dimColor>●</Text> : <Text color={color}>●</Text>}{' '}
              <Text bold>{head}</Text>
              {truncate(row.title, width - head.length - 2)}
            </Text>
            <Text dimColor wrap="truncate">
              {'  '}
              {stateLine(row)}
            </Text>
          </Box>
        )
      })}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>gh every 60s, 0 model tokens · wake {isWaking ? 'on' : 'off'}</Text>
        {lastError !== null && <Text color="error">{lastError}</Text>}
      </Box>
    </Box>
  )
}

export const style: PaneStyle = {
  meta: { id: 'classic', name: 'Classic', tagline: 'Dot, repo#number and title, state line beneath' },
  render,
}
