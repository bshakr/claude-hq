# HQ draws each group as a rounded card with a one-sentence header, and drops the legend and rule lines

- Status: accepted
- Date: 2026-10-08

## Context

The first build (ADR 0001, "Name and shape") was a flat sheet: a three-counter header, solid and dotted rule lines, tree glyphs, a separate "agents" heading under "current session", and a legend at the bottom. In use it read as cluttered, and the current session's agents did not look like part of the current session. The installed skins plugin draws prompts as rounded outlines with even padding, which the founder preferred.

## Decision

- A pinned one-sentence header: non-zero counts only, "nothing needs you" when nothing does, followed by the "needs you" flare line.
- Rounded cards with the title in the top border: one "this session" card holding now, todos, background waits and agents (a task line plus a dim doing line); one card per other tmux group; a pull requests card only when the session owns PRs, each PR with its checks bar.
- A card's border is dim, yellow when something in it needs the user, red when something is broken. No legend, no rule lines, no tree glyphs.
- Borders are drawn as text inside HQ's row grid, not as a native `Box borderStyle="round"`, because scrolling, the j/k cursor, hover groups and the cell-for-cell layout tests all work on whole rows.

## Consequences

- The pane reads as grouped and quieter; colour now carries status without a legend.
- Card glyphs are part of every row, so width maths and the layout sheets must account for two border cells and the inner padding.
- A native border would need the row grid and its tests reworked first.
- As built (2026-10-08): the header sentence is gone (plan usage bars only); "this session" is titled by its repo and opens on its goal like the other cards, its now line reads `◷ waiting on N agents` while agents run, and only the newest finished agent shows above a `+N finished` toggle.
- As built (2026-10-09): while the pane is focused, the card holding the cursor is drawn in heavy lines (`┏━┓┃┗┛`) in its status colour, and the cursor row is bold, with its whole text wrapped to at most three lines. The current session's card has no padding rows; its title is the accent colour, bold, followed by a dim ` · this session`, and a dim `── other sessions ──` divider follows it when other sessions exist. The engine's focus ring still inverts the focused Button's label, because HQ cannot turn that off.
- As built (2026-10-09): a session's card splits into sections under its own lines, each opened by a divider that joins the border (`├─ agents ─┤`, `├─ pull requests ─┤`; `┣━ ━┫` on the heavy card) and drawn only when it has rows. The standalone pull requests card is gone: this session's PRs are its `pull requests` section with the full two-line rows, and another session's open PRs are one line each (number, title, status), most urgent first, three then a `+N more PRs` toggle. A card's border takes the worst status of everything in it, and a bare `├──┤` rule separates a session that has sections from the next one in its group.

## Alternatives considered

- **Keep the flat sheet and only remove the legend:** still left the agents detached from the session.
- **Native `Box` borders:** the border sits outside the row grid and breaks row counts and scrolling.
