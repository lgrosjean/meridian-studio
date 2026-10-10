// A dataset's CSV, read once per version of the file: its header, and for each column what it holds (dates,
// numbers, text), its range, its zeros and its empty cells. Completion, hover and the dataset's checks read it.
// The runner reads the CSV with pandas; this only has to agree with pandas on what a cell is.
import fs from 'node:fs'
import { basename } from 'node:path'

export type ColumnProfile = {
  name: string
  type: 'dates' | 'numbers' | 'text' | 'empty'
  filled: number // cells with a value
  empty: number // cells pandas reads as missing
  zeros: number
  distinct: number
  min?: number
  max?: number
  first?: string // dates: the earliest and the latest
  last?: string
  iso: boolean // dates all written yyyy-mm-dd, the only way Meridian reads them
  odd?: string // a value that is not what the column mostly is: "25/01/2021" among dates, "1,5" among numbers
  samples: string[]
}
export type Profile = { file: string; header: string[]; rows: number; columns: Map<string, ColumnProfile>; partial: boolean }

// What pandas reads as missing (read_csv's default na_values).
const NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const ISO = /^\d{4}-\d{2}-\d{2}$/
const DATE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/
const MAX_BYTES = 32 * 1024 * 1024 // a bigger CSV is profiled from its first rows

/** Rows of cells: commas, double quotes ("" inside quotes is a quote), \n or \r\n; a leading BOM dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') row.push(cell), (cell = '')
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

/** What a CSV's text holds, column by column. */
export function profileCsv(text: string, file = '', partial = false): Profile {
  const [header = [], ...body] = parseCsv(text)
  const rows = body.filter((r) => r.length > 1 || r[0] !== '') // pandas skips blank lines
  const names = header.map((h) => h.trim())
  const columns = new Map<string, ColumnProfile>()
  names.forEach((name, j) => {
    const values: string[] = []
    let empty = 0
    for (const r of rows) {
      const v = (r[j] ?? '').trim()
      if (NA.has(v)) empty++
      else values.push(v)
    }
    const p: ColumnProfile = { name, type: 'empty', filled: values.length, empty, zeros: 0, distinct: new Set(values).size, iso: false, samples: [...new Set(values)].slice(0, 3) }
    if (values.length && values.every((v) => NUMBER.test(v))) {
      const n = values.map(Number)
      p.type = 'numbers'
      p.zeros = n.filter((x) => x === 0).length
      p.min = n.reduce((a, b) => Math.min(a, b))
      p.max = n.reduce((a, b) => Math.max(a, b))
    } else if (values.length && values.every((v) => DATE.test(v))) {
      p.type = 'dates'
      p.iso = values.every((v) => ISO.test(v))
      p.odd = values.find((v) => !ISO.test(v))
      const sorted = p.iso ? [...values].sort() : values
      ;[p.first, p.last] = [sorted[0], sorted[sorted.length - 1]]
    } else if (values.length) {
      p.type = 'text'
      p.odd = values.find((v) => !NUMBER.test(v))
    }
    columns.set(name, p)
  })
  return { file, header: names, rows: rows.length, columns, partial }
}

const cache = new Map<string, { stamp: string; profile: Profile }>()
/** The CSV at this path, profiled; read again only when the file changes. Undefined when it cannot be read. */
export function profileOf(path: string): Profile | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(path)
  } catch {
    return undefined
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const hit = cache.get(path)
  if (hit?.stamp === stamp) return hit.profile
  const fd = fs.openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    let text = buf.toString('utf8', 0, n)
    const partial = stat.size > MAX_BYTES
    if (partial) text = text.slice(0, text.lastIndexOf('\n') + 1) // whole rows only
    const profile = profileCsv(text, basename(path), partial)
    cache.set(path, { stamp, profile })
    return profile
  } finally {
    fs.closeSync(fd)
  }
}

// 412K, 2.5, 0.035: three significant digits at most, whatever the scale.
const compact = (v: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 }).format(v)
/** One line on a column, as completion shows it: "numbers · 75K – 297K · 3 zeros". */
export function describe(c: ColumnProfile): string {
  const extra = [c.zeros ? `${c.zeros} zero${c.zeros > 1 ? 's' : ''}` : '', c.empty ? `${c.empty} empty` : '']
  if (c.type === 'numbers') return ['numbers', `${compact(c.min!)} – ${compact(c.max!)}`, ...extra].filter(Boolean).join(' · ')
  if (c.type === 'dates')
    return ['dates', `${c.first} → ${c.last}`, c.iso ? '' : 'not yyyy-mm-dd', c.distinct < c.filled ? `${c.distinct} dates over ${c.filled} rows` : '', ...extra].filter(Boolean).join(' · ')
  if (c.type === 'text') return ['text', `${c.distinct} value${c.distinct > 1 ? 's' : ''}`, ...extra].filter(Boolean).join(' · ')
  return 'empty'
}
