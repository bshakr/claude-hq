import { claimKey, isEnded } from './prs';
/** `$.store` key of the `/hq wake on|off` toggle; absent means on. */
export const WAKE_KEY = 'wake';
const RAN = new Set(['passed', 'running']);
const CLEAN = new Set(['mergeable', 'blocked']);
/**
 * Transitions of owned PRs between two ticks. A PR seen for the first time is never one,
 * so the first tick after a start or reload is silent; a stale row carries no news.
 */
export function detectTransitions(previous, next) {
    const before = new Map(previous.map(pr => [claimKey(pr.repo, pr.number), pr]));
    const found = [];
    for (const pr of next) {
        const old = before.get(claimKey(pr.repo, pr.number));
        if (!old || pr.stale)
            continue;
        if (!isEnded(old.merge) && pr.merge === 'merged') {
            const others = next
                .filter(o => o.repo.toLowerCase() === pr.repo.toLowerCase() && o.number !== pr.number && !isEnded(o.merge))
                .map(o => o.number);
            found.push({ kind: 'merged', pr, others });
            continue;
        }
        if (isEnded(pr.merge))
            continue;
        if (pr.ci.kind === 'failed' && RAN.has(old.ci.kind))
            found.push({ kind: 'ci-red', pr, failing: pr.ci.firstFailing });
        if ((pr.merge === 'conflicting' || pr.merge === 'behind') && CLEAN.has(old.merge))
            found.push({ kind: pr.merge, pr });
    }
    return found;
}
function ref(pr) {
    return `${pr.repo}#${pr.number}`;
}
export function toastText(t) {
    switch (t.kind) {
        case 'ci-red':
            return `${ref(t.pr)} CI went red: ${t.failing}`;
        case 'merged':
            return `${ref(t.pr)} merged`;
        case 'conflicting':
            return `${ref(t.pr)} has merge conflicts`;
        case 'behind':
            return `${ref(t.pr)} needs a rebase`;
    }
}
function promptLine(t) {
    switch (t.kind) {
        case 'ci-red':
            return `${ref(t.pr)} CI went red (failing check: ${t.failing}). Triage: read the failing log and report; do not merge or push without asking.`;
        case 'merged':
            // Nothing to rebase means nothing to ask the model; the toast covers it.
            if (t.others.length === 0)
                return null;
            return `${ref(t.pr)} merged. Other owned open PRs in that repo: ${t.others.map(n => `#${n}`).join(', ')} — check whether they need a rebase and report; do not push without asking.`;
        case 'conflicting':
            return `${ref(t.pr)} now has merge conflicts with its base. Check what conflicts and report; do not push without asking.`;
        case 'behind':
            return `${ref(t.pr)} is behind its base and needs a rebase. Check whether it rebases cleanly and report; do not push without asking.`;
    }
}
/** All of one tick's transitions as one prompt, or null when none should wake. */
export function wakePrompt(transitions) {
    const lines = transitions.map(promptLine).filter((line) => line !== null);
    if (lines.length === 0)
        return null;
    if (lines.length === 1)
        return `[hq] ${lines[0]}`;
    return ['[hq] Several PRs changed:', ...lines.map(line => `- ${line}`)].join('\n');
}
export function parseWake(args) {
    const match = /^wake\s+(on|off)$/.exec(args.trim());
    return match ? match[1] : null;
}
/** The owned-PR part of the status line, e.g. "PRs 1 red · 2 green"; undefined with no owned PRs. */
export function prStatusPart(prs) {
    if (prs.length === 0)
        return undefined;
    const open = prs.filter(pr => !isEnded(pr.merge));
    const counts = [
        [open.filter(pr => pr.ci.kind === 'passed').length, 'green'],
        [open.filter(pr => pr.ci.kind === 'running' || pr.ci.kind === 'registering').length, 'running'],
        [open.filter(pr => pr.ci.kind === 'failed').length, 'red'],
        [open.filter(pr => pr.merge === 'conflicting').length, 'conflict'],
        [open.filter(pr => pr.merge === 'behind').length, 'rebase'],
        [prs.filter(pr => pr.merge === 'merged').length, 'merged'],
    ];
    const shown = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
    if (shown.length > 0)
        return `PRs ${shown.join(' · ')}`;
    return open.length > 0 ? `PRs ${open.length} open` : undefined;
}
/** HQ's one status entry: its own parts, then the owned PRs'; '' clears it. */
export function withPrStatus(base, prs) {
    const part = prStatusPart(prs);
    if (part === undefined)
        return base;
    return base === '' ? `hq: ${part}` : `${base} · ${part}`;
}
/** What one tick's owned-PR transitions say: a toast each, and at most one wake prompt. */
export function newsOf(previous, next) {
    const transitions = detectTransitions(previous, next);
    return { toasts: transitions.map(toastText), prompt: wakePrompt(transitions) };
}
