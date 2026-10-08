import { NOW } from './fixtures';
const M = 60_000;
export const ctx = (percent) => ({ percent, window: 1_000_000, source: 'transcript' });
const sess = (s, win) => ({
    status: 'idle',
    windowLabel: win,
    tmuxTarget: `work:${win}.%1`,
    jump: { kind: 'tmux', target: `work:${win}.%1` },
    ...s,
});
export const METERED = {
    now: NOW,
    counts: { waiting: 0, broken: 0, inProgress: 1, sessions: 4 },
    current: {
        label: 'work:@1 · main',
        goal: { text: 'Session usage meters', day: 2 },
        context: { percent: 28, window: 1_000_000, tokens: 280_000, source: 'live' },
        agents: [],
        prs: [],
    },
    others: [
        {
            tmuxSession: 'work',
            sessions: [
                sess({ sessionId: 's-api', name: 'rp-api', status: 'busy', statusSince: NOW - 6 * M, context: ctx(55), prSummary: { total: 2, broken: 0, waiting: 0, inProgress: 0 } }, '@2'),
                sess({ sessionId: 's-docs', name: 'rp-docs', statusSince: NOW - 60 * M, context: ctx(85) }, '@3'),
                sess({ sessionId: 's-new', name: 'fresh', statusSince: NOW - 1 * M }, '@4'),
            ],
        },
    ],
    account: { fiveHour: 5, week: 18 },
    statusText: '',
};
