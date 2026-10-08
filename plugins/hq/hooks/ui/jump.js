/** The host commands a jump runs, in order; [] when the target is not one /hq will open. */
export function jumpCommands(jump) {
    if (jump.kind === 'url')
        return /^https?:\/\//.test(jump.url) ? [['open', jump.url]] : [];
    if (!jump.target)
        return [];
    const cmds = [['tmux', 'switch-client', '-t', jump.target]];
    const pane = /(%\d+)$/.exec(jump.target);
    if (pane)
        cmds.push(['tmux', 'select-pane', '-t', pane[1]]);
    return cmds;
}
export const jumpLabel = (jump) => (jump.kind === 'url' ? jump.url : jump.target);
/** Runs a jump's commands in order, stopping at the first failure; answers why it stopped, or nothing. */
export async function runJump(jump, run) {
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
