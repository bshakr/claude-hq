// What a Bash call says about PR ownership: PRs it created, branches it pushed, directories it worked in.
const PR_URL_SRC = String.raw `https?://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)`;
/** Splits on whitespace honouring single/double quotes and backslashes; operators become their own tokens. */
export function tokenize(command) {
    const out = [];
    let cur = '';
    let has = false;
    let quote = null;
    const push = () => {
        if (has)
            out.push(cur);
        cur = '';
        has = false;
    };
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (quote) {
            if (c === quote)
                quote = null;
            else if (c === '\\' && quote === '"' && i + 1 < command.length)
                cur += command[++i];
            else
                cur += c;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            has = true;
        }
        else if (c === '\\' && i + 1 < command.length) {
            cur += command[++i];
            has = true;
        }
        else if (c === ' ' || c === '\t') {
            push();
        }
        else if (c === '\n' || c === ';' || c === '(' || c === ')') {
            push();
            out.push(';');
        }
        else if (c === '&' || c === '|') {
            // `2>&1` stays one token with what precedes it.
            if (c === '&' && cur.endsWith('>')) {
                cur += c;
                continue;
            }
            push();
            if (command[i + 1] === c)
                i++;
            out.push(c === '&' ? '&&' : '|');
        }
        else {
            cur += c;
            has = true;
        }
    }
    push();
    return out;
}
function segments(tokens) {
    const out = [[]];
    for (const t of tokens) {
        if (t === ';' || t === '&&' || t === '|')
            out.push([]);
        else
            out[out.length - 1].push(t);
    }
    return out.filter(s => s.length > 0);
}
function base(word) {
    const i = word.lastIndexOf('/');
    return i < 0 ? word : word.slice(i + 1);
}
function normalizeRepo(repo) {
    if (!repo)
        return undefined;
    const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repo);
    if (m)
        return m[1];
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : undefined;
}
export function urlsIn(text) {
    const out = [];
    for (const m of text.matchAll(new RegExp(PR_URL_SRC, 'g')))
        out.push({ repo: m[1], number: Number(m[2]) });
    return out;
}
/** "owner/name" from a git remote URL (ssh, https, ssh://). */
export function repoOfRemote(remote) {
    return normalizeRepo(remote.trim());
}
const isDir = (d) => !!d && (d.startsWith('/') || d.startsWith('~'));
function pushLines(output) {
    let repo;
    const branches = [];
    for (const line of output.split('\n')) {
        const to = /^To\s+(\S+)/.exec(line);
        if (to) {
            repo = normalizeRepo(to[1]) ?? repo;
            continue;
        }
        if (/\[(deleted|rejected|remote rejected|new tag)\]/.test(line))
            continue;
        const m = /^\s*[*+=!-]?\s+\S.*?\s(\S+)\s+->\s+(\S+)/.exec(line);
        if (!m)
            continue;
        const dst = m[2].replace(/^refs\/heads\//, '');
        if (dst.startsWith('refs/'))
            continue;
        branches.push(dst);
    }
    return { repo, branches };
}
/**
 * Ownership facts in one Bash call. Only creating a PR or pushing a branch counts;
 * viewing, checking, commenting on or waiting on a PR does not.
 */
export function parseOwnership(command, stdout = '', stderr = '', gitOp) {
    const out = { created: [], pushed: [], merged: [], dirs: [] };
    let dir;
    let creates = false;
    let pushes = false;
    let merges = false;
    for (const seg of segments(tokenize(command))) {
        let i = 0;
        while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]))
            i++;
        if (seg[i] === 'cd') {
            if (isDir(seg[i + 1])) {
                dir = seg[i + 1];
                out.dirs.push(dir);
            }
            continue;
        }
        const bin = seg[i] === undefined ? '' : base(seg[i]);
        const rest = seg.slice(i + 1);
        if (bin === 'gh') {
            const prAt = rest.indexOf('pr');
            if (prAt >= 0 && rest[prAt + 1] === 'create')
                creates = true;
            if (prAt >= 0 && rest[prAt + 1] === 'merge')
                merges = true;
        }
        else if (bin === 'git') {
            let k = 0;
            let gitDir;
            while (k < rest.length && rest[k].startsWith('-')) {
                if (rest[k] === '-C' && isDir(rest[k + 1]))
                    gitDir = rest[k + 1];
                k += rest[k] === '-C' || rest[k] === '-c' ? 2 : 1;
            }
            if (rest[k] === 'push' && !rest.slice(k).some(a => a === '--delete' || a === '-d')) {
                pushes = true;
                if (gitDir) {
                    dir = gitDir;
                    out.dirs.push(gitDir);
                }
            }
        }
    }
    if (creates) {
        const seen = new Set();
        const all = [...urlsIn(stdout), ...(gitOp?.pr?.action === 'created' && gitOp.pr.url ? urlsIn(gitOp.pr.url) : [])];
        for (const u of all) {
            const key = `${u.repo.toLowerCase()}#${u.number}`;
            if (!seen.has(key))
                out.created.push(u);
            seen.add(key);
        }
    }
    if (merges && gitOp?.pr?.action === 'merged') {
        const u = gitOp.pr.url ? urlsIn(gitOp.pr.url)[0] : undefined;
        out.merged.push(u ?? { number: gitOp.pr.number });
    }
    if (pushes || gitOp?.push) {
        const parsed = pushLines(`${stderr}\n${stdout}`);
        const branches = new Set([...(gitOp?.push ? [gitOp.push.branch] : []), ...parsed.branches]);
        const at = dir ? { dir } : {};
        const repo = parsed.repo ? { repo: parsed.repo } : {};
        // Output that names a remote but no branch (a tag, a rejection) owns nothing.
        if (branches.size === 0 && !parsed.repo)
            out.pushed.push({ ...at });
        for (const branch of branches)
            out.pushed.push({ ...repo, branch, ...at });
    }
    return out;
}
