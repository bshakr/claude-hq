// Model text shown in a row: markdown reads as raw syntax in a terminal cell.

/** One line of markdown as plain text: links and images to their text, emphasis and code ticks gone, no heading or list marker. */
export function plainText(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|\W)_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const isHeading = (l: string) => /^#{1,6}\s/.test(l)

/** The first sentence of the first line with words, a heading only when nothing else has any. */
export function summaryLine(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => plainText(l).length > 0)
  const line = lines.find(l => !isHeading(l)) ?? lines[0]
  if (line === undefined) return undefined
  const plain = plainText(line)
  const sentence = /^(.+?[.!?])\s+(?=[A-Z0-9"'(])/.exec(plain)?.[1] ?? plain
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence
}

const TAG = /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g
const REPORT_FOLLOWS = 'The report follows:'

/** A prompt as the "now" line names it: a subagent's hand-back or a plugin's message by what it says, tags gone. */
export function promptSummary(text: string): string {
  const hand = /^\s*<agent-message\b[^>]*>([\s\S]*)$/.exec(text)
  if (hand) {
    let report = (hand[1] ?? '').replace(/<\/agent-message>\s*$/, '')
    const at = report.indexOf(REPORT_FOLLOWS)
    report = at >= 0 ? report.slice(at + REPORT_FOLLOWS.length) : report.replace(/^\s*\[Subagent hand-back\]/, '')
    const said = summaryLine(report.replace(TAG, ' '))
    return said ? `agent reported: ${said}` : 'agent reported'
  }
  const plugin = /^\s*The (\S+) plugin sent a message:\s*([\s\S]*)$/.exec(text)
  if (plugin) {
    const name = plugin[1]!
    const first =
      (plugin[2] ?? '')
        .replace(TAG, ' ')
        .split('\n')
        .map(plainText)
        .find(l => l.length > 0) ?? ''
    // Plugins often repeat their own name as a "[name]" prefix.
    const said = first.replace(new RegExp(`^\\[${name.replace(/[^\w-]/g, '')}\\]\\s*`), '')
    return said ? `${name}: ${said}` : name
  }
  return text.replace(TAG, ' ')
}
