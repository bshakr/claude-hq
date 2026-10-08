import { charWidth, cellLen } from './text';
const same = (a, b) => a.c === b.c && a.dim === b.dim && a.bold === b.bold && a.btn === b.btn && a.href === b.href;
/** One pane row placed cell by cell, so widths are exact; never wider than W. */
export class Row {
    W;
    cells;
    buttons = [];
    /** The actionable item this row belongs to (all its lines share it). */
    item;
    /** First line of its item: where the cursor marker goes. */
    head;
    /** Gutter tone of the item, for the scroll indicators' counts. */
    gutter;
    /** Column the cursor marker takes on a head row. */
    mark;
    constructor(W) {
        this.W = W;
        this.cells = Array.from({ length: Math.max(0, W) }, () => ({ ch: ' ', s: {} }));
    }
    /** Writes text from `col`; cells past the edge are dropped. Returns the end column. */
    put(col, text, s = {}) {
        let c = col;
        for (const ch of text) {
            const w = charWidth(ch);
            if (w === 0)
                continue;
            if (c + w > this.W)
                return this.W;
            this.cells[c] = { ch, s };
            if (w === 2)
                this.cells[c + 1] = { ch: '', s };
            c += w;
        }
        return c;
    }
    /** Right-aligned to the last cell; skipped when it would start before `minCol`. */
    right(text, s = {}, minCol = 0) {
        const at = this.W - cellLen(text);
        if (at < minCol)
            return false;
        this.put(at, text, s);
        return true;
    }
    fill(c0, c1, ch, s = {}) {
        return c1 > c0 ? this.put(c0, ch.repeat(c1 - c0), s) : c0;
    }
    button(col, text, spec, s = {}) {
        if (text === '' || col >= this.W)
            return col;
        const end = this.put(col, text, { ...s, btn: spec.key });
        // A label cut at the edge stays what is drawn.
        const drawn = this.cells.slice(col, end).map(cell => cell.ch).join('');
        this.buttons.push({ ...spec, label: spec.label ?? drawn });
        return end;
    }
    /** Copies `inner` in from `col`, with its buttons and item. */
    inset(col, inner) {
        inner.cells.forEach((cell, i) => {
            if (col + i < this.W)
                this.cells[col + i] = cell;
        });
        this.buttons.push(...inner.buttons);
        this.item = inner.item;
        this.head = inner.head;
        this.gutter = inner.gutter;
        return this;
    }
    text() {
        return this.cells.map(cell => cell.ch).join('').trimEnd();
    }
    /** Neighbouring cells of one style merge into a run; trailing blanks dropped. */
    segs() {
        let end = this.cells.length;
        while (end > 0 && this.cells[end - 1].ch === ' ' && !this.cells[end - 1].s.btn)
            end--;
        const out = [];
        for (let i = 0; i < end; i++) {
            const cell = this.cells[i];
            const last = out[out.length - 1];
            if (last && same(last.s, cell.s))
                last.t += cell.ch;
            else
                out.push({ col: i, t: cell.ch, s: cell.s });
        }
        return out;
    }
}
