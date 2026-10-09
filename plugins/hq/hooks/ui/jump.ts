import type { Jump } from '../model/types'
import { resumeCommand, strategiesFor } from './focus'
import type { Exec } from './focus'

/** The host commands a tmux or URL jump runs, in order; [] when the target is not one /hq will open. */
export function jumpCommands(jump: Jump): string[][] {
  if (jump.kind === 'url') return /^https?:\/\//.test(jump.url) ? [['open', jump.url]] : []
  const target = jump.kind === 'tmux' ? jump.target : jump.tmux
  if (!target) return []
  const cmds = [['tmux', 'switch-client', '-t', target]]
  const pane = /(%\d+)$/.exec(target)
  if (pane) cmds.push(['tmux', 'select-pane', '-t', pane[1]!])
  return cmds
}

export const jumpLabel = (jump: Jump) => (jump.kind === 'url' ? jump.url : jump.kind === 'tmux' ? jump.target : (jump.tmux ?? jump.cwd))

export type Runner = Exec

/** Focused: nothing. A string: why it failed. `resume`: no host could focus it; this command reopens it. */
export type JumpResult = undefined | string | { resume: string; tried: string[] }

/** Runs a jump. A session tries each strategy in order, first success wins, and falls back to its resume command. */
export async function runJump(jump: Jump, run: Runner): Promise<JumpResult> {
  if (jump.kind === 'session') {
    const tried: string[] = []
    for (const s of strategiesFor(jump)) {
      tried.push(s.name)
      if (await s.run(jump, run)) return undefined
    }
    return { resume: resumeCommand(jump), tried }
  }
  const cmds = jumpCommands(jump)
  if (cmds.length === 0) return `nothing to open for ${jumpLabel(jump)}`
  for (const argv of cmds) {
    try {
      const ran = await run(argv)
      if (ran.exitCode !== 0) return `${argv.slice(0, 2).join(' ')} failed: ${(ran.stderr.split('\n')[0] ?? '').slice(0, 80)}`
    } catch (thrown) {
      return `${argv[0]} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`
    }
  }
  return undefined
}

export interface JumpIO {
  run: Runner
  copy: (text: string) => Promise<boolean>
  toast: (text: string) => void
}

/** A press: run the jump; on fallback copy the resume command and say so. False when it failed outright. */
export async function pressJump(jump: Jump, io: JumpIO): Promise<boolean> {
  const out = await runJump(jump, io.run)
  if (typeof out === 'string') {
    io.toast(`hq: ${out}`)
    return false
  }
  if (out) {
    const copied = await io.copy(out.resume).catch(() => false)
    const bg = jump.kind === 'session' && jump.bg && jump.jobId
    io.toast(
      copied
        ? bg
          ? `hq: copied ${out.resume}; paste it in a terminal to open the background session`
          : `hq: copied resume command: ${out.resume}`
        : `hq: can't focus it; run ${out.resume}`,
    )
  }
  return true
}
