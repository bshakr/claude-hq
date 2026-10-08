import { resumeCommand, strategiesFor } from './focus';
/** The host commands a tmux or URL jump runs, in order; [] when the target is not one /hq will open. */
export function jumpCommands(jump) {
    if (jump.kind === 'url')
        return /^https?:\/\//.test(jump.url) ? [['open', jump.url]] : [];
    const target = jump.kind === 'tmux' ? jump.target : jump.tmux;
    if (!target)
        return [];
    const cmds = [['tmux', 'switch-client', '-t', target]];
    const pane = /(%\d+)$/.exec(target);
    if (pane)
        cmds.push(['tmux', 'select-pane', '-t', pane[1]]);
    return cmds;
}
export const jumpLabel = (jump) => (jump.kind === 'url' ? jump.url : jump.kind === 'tmux' ? jump.target : jump.tmux ?? jump.cwd);
/** Runs a jump. A session tries each strategy in order, first success wins, and falls back to its resume command. */
export async function runJump(jump, run) {
    if (jump.kind === 'session') {
        const tried = [];
        for (const s of strategiesFor(jump)) {
            tried.push(s.name);
            if (await s.run(jump, run))
                return undefined;
        }
        return { resume: resumeCommand(jump), tried };
    }
    const cmds = jumpCommands(jump);
    if (cmds.length === 0)
        return `nothing to open for ${jumpLabel(jump)}`;
    for (const argv of cmds) {
        try {
            const ran = await run(argv);
            if (ran.exitCode !== 0)
                return `${argv.slice(0, 2).join(' ')} failed: ${(ran.stderr.split('\n')[0] ?? '').slice(0, 80)}`;
        }
        catch (thrown) {
            return `${argv[0]} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
        }
    }
    return undefined;
}
/** A press: run the jump; on fallback copy the resume command and say so. False when it failed outright. */
export async function pressJump(jump, io) {
    const out = await runJump(jump, io.run);
    if (typeof out === 'string') {
        io.toast(`hq: ${out}`);
        return false;
    }
    if (out) {
        const copied = await io.copy(out.resume).catch(() => false);
        io.toast(copied ? `hq: copied resume command: ${out.resume}` : `hq: can't focus it; run ${out.resume}`);
    }
    return true;
}
