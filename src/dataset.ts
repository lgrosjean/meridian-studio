// A dataset's YAML, read with where each thing it names sits: its CSV, the columns of each role, each
// *_to_channel entry. On top of it: what the editor underlines and how to fix it, what to complete where the
// cursor is, what a hover says, and the edits the fixes, the tree and "Complete from the CSV" make. An edit is a
// new text from the old one that changes only what it must: the person's layout and comments stay.
// Nothing here knows VS Code: offsets in, offsets out.
import { isMap, isPair, isScalar, isSeq, parseDocument, visit, type Pair, type Scalar } from 'yaml'
import { describe, type ColumnProfile, type Profile } from './csv'

export type Role = { key: string; label: string; icon: string; many: boolean; numeric: boolean; map?: string; hint: string }
// coord_to_columns' keys, in the order Meridian documents them; label and icon are the tree's.
export const ROLES: Role[] = [
  { key: 'time', label: 'time', icon: 'calendar', many: false, numeric: false, hint: 'dates, yyyy-mm-dd' },
  { key: 'geo', label: 'geo', icon: 'globe', many: false, numeric: false, hint: 'the geo of each row, in a geo model' },
  { key: 'kpi', label: 'KPI', icon: 'target', many: false, numeric: true, hint: 'what media moves: sales, conversions' },
  { key: 'revenue_per_kpi', label: 'revenue per KPI', icon: 'tag', many: false, numeric: true, hint: 'money per KPI unit, with kpi_type non_revenue' },
  { key: 'population', label: 'population', icon: 'person', many: false, numeric: true, hint: 'of each geo' },
  { key: 'media', label: 'media', icon: 'broadcast', many: true, numeric: true, map: 'media_to_channel', hint: 'impressions, GRP, clicks of a paid channel' },
  { key: 'media_spend', label: 'spend', icon: 'credit-card', many: true, numeric: true, map: 'media_spend_to_channel', hint: "a paid channel's spend" },
  { key: 'reach', label: 'reach', icon: 'broadcast', many: true, numeric: true, map: 'reach_to_channel', hint: 'a reach & frequency channel: its reach' },
  { key: 'frequency', label: 'frequency', icon: 'broadcast', many: true, numeric: true, map: 'frequency_to_channel', hint: 'a reach & frequency channel: its frequency' },
  { key: 'rf_spend', label: 'spend', icon: 'credit-card', many: true, numeric: true, map: 'rf_spend_to_channel', hint: 'a reach & frequency channel: its spend' },
  { key: 'controls', label: 'control', icon: 'settings', many: true, numeric: true, hint: 'what moves the KPI that media does not: season, price' },
  { key: 'non_media_treatments', label: 'non-media', icon: 'symbol-event', many: true, numeric: true, hint: 'levers that are not media: price, promotions' },
  { key: 'organic_media', label: 'organic', icon: 'symbol-event', many: true, numeric: true, hint: 'unpaid media: emails, organic social' },
  { key: 'organic_reach', label: 'organic reach', icon: 'symbol-event', many: true, numeric: true, map: 'organic_reach_to_channel', hint: 'unpaid reach' },
  { key: 'organic_frequency', label: 'organic frequency', icon: 'symbol-event', many: true, numeric: true, map: 'organic_frequency_to_channel', hint: 'unpaid frequency' }
]
const role = (key: string) => ROLES.find((r) => r.key === key)
// Roles whose channels pair up: Meridian wants the same channels in each, listed in the same order.
const GROUPS = [['media', 'media_spend'], ['reach', 'frequency', 'rf_spend'], ['organic_reach', 'organic_frequency']]
const groupOf = (key: string) => GROUPS.find((g) => g.includes(key)) ?? [key]
// The one column that may hold two roles: a channel without impressions takes its spend as media too.
const SHARED = new Set(['media|media_spend', 'media_spend|media'])
const shareable = (a: string, b: string) => a === b || SHARED.has(`${a}|${b}`)

// --- Reading ------------------------------------------------------------------------------------------

/** A value the YAML names, and where it sits. */
export type Named = { value: string; start: number; end: number }
export type Entry = { column: Named; channel?: Named }
export type Dataset = {
  csv?: Named
  kpiType?: Named
  coord?: Named // the coord_to_columns key itself
  roles: Record<string, Named[]> // coord_to_columns: role → its columns as written
  roleKeys: Record<string, Named>
  maps: Record<string, Entry[]> // media_to_channel… → its entries
}

// The template's blanks: `<column>`, `[<impressions column>, ...]`, an empty item.
const PLACEHOLDER = /^(<.*>|\.\.\.|…|)$/
export const isPlaceholder = (v: string) => PLACEHOLDER.test(v.trim())

type AnyPair = Pair<any, any>
const keyOf = (p: AnyPair) => String(isScalar(p.key) ? p.key.value : p.key)
const named = (n: unknown): Named | undefined =>
  isScalar(n) && n.value !== null && n.value !== undefined && n.range ? { value: String(n.value), start: n.range[0], end: n.range[1] } : undefined
const pairs = (doc: { contents: unknown }): AnyPair[] => (isMap(doc.contents) ? (doc.contents.items as AnyPair[]) : [])
const top = (doc: { contents: unknown }, key: string) => pairs(doc).find((p) => keyOf(p) === key)
const coordPair = (doc: { contents: unknown }, key: string): AnyPair | undefined => {
  const c = top(doc, 'coord_to_columns')
  return c && isMap(c.value) ? (c.value.items as AnyPair[]).find((p) => keyOf(p) === key) : undefined
}

export function readDataset(text: string): Dataset {
  const ds: Dataset = { roles: {}, roleKeys: {}, maps: {} }
  for (const p of pairs(parseDocument(text))) {
    const k = keyOf(p)
    if (k === 'csv') ds.csv = named(p.value)
    else if (k === 'kpi_type') ds.kpiType = named(p.value)
    else if (k === 'coord_to_columns') {
      ds.coord = named(p.key)
      if (isMap(p.value))
        for (const r of p.value.items as AnyPair[]) {
          const key = keyOf(r)
          const at = named(r.key)
          if (at) ds.roleKeys[key] = at
          const items: unknown[] = isSeq(r.value) ? r.value.items : [r.value]
          // an empty item (`- `) is a blank to fill, like a placeholder
          ds.roles[key] = items.flatMap((i) => (isScalar(i) && i.range ? [named(i) ?? { value: '', start: i.range[0], end: i.range[1] }] : []))
          if (!isSeq(r.value)) ds.roles[key] = ds.roles[key].filter((n) => n.value !== '')
        }
    } else if (k.endsWith('_to_channel'))
      ds.maps[k] = isMap(p.value)
        ? (p.value.items as AnyPair[]).flatMap((e) => {
            const column = named(e.key)
            return column ? [{ column, channel: named(e.value) }] : []
          })
        : []
  }
  return ds
}

/** Each column the YAML names (blanks aside), with the roles naming it, in coord_to_columns or as a *_to_channel key. */
export function usage(ds: Dataset): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (c: string, key: string) => out.set(c, [...new Set([...(out.get(c) ?? []), key])])
  for (const [key, nodes] of Object.entries(ds.roles)) for (const n of nodes) if (!isPlaceholder(n.value)) add(n.value, key)
  for (const r of ROLES) if (r.map) for (const e of ds.maps[r.map] ?? []) if (!isPlaceholder(e.column.value)) add(e.column.value, r.key)
  return out
}

// --- Names: what a column's name says it is, and the channel it belongs to ------------------------------------

const WORDS = {
  kpi: /^(kpi|sales|revenue|revenues|conversion|conversions|order|orders|units|leads|signups|installs|transactions|bookings|subscriptions|vente|ventes|ca|turnover)$/,
  population: /^(population|pop)$/,
  media: /^(impression|impressions|imp|imps|impr|grp|grps|trp|trps|click|clicks|view|views|exposure|exposures|insertion|insertions|contact|contacts)$/,
  media_spend: /^(spend|spends|spent|cost|costs|cout|couts|depense|depenses|investment|investments|invest)$/,
  reach: /^(reach|couverture)$/,
  frequency: /^(frequency|freq|frequence|repetition)$/,
  controls: /^(control|controls|ctrl|price|prices|prix|promo|promos|promotion|promotions|discount|discounts|holiday|holidays|ferie|feries|season|seasonal|seasonality|saison|saisonnalite|competitor|competitors|competition|concurrent|concurrence|weather|meteo|temperature|temp|rain|covid|lockdown|distribution|index|sentiment|gdp|pib|unemployment|cpi|inflation|trend|event|events)$/,
  organic: /^(organic|organique)$/
}
const NOISE = /^(media|paid|total|sum|weekly|daily|amount|eur|usd|gbp|chf)$/
// "Channel0_impression" → Channel0, impression; "TVSpend" → TV, Spend; "dépense_radio" → depense, radio
const pieces = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
const words = (name: string) => pieces(name).map((p) => p.toLowerCase())
const says = (name: string, what: keyof typeof WORDS) => words(name).some((w) => WORDS[what].test(w))
const perKpi = (name: string) => {
  const w = words(name)
  return (w.includes('per') && w.some((x) => /^(revenue|rev|value|price)$/.test(x))) || w.some((x) => /^(aov|arpu)$/.test(x))
}
type Paid = 'media' | 'media_spend' | 'reach' | 'frequency'
/** What a paid column's name says it holds, when it says exactly one thing. */
const paidKind = (name: string): Paid | undefined => {
  const kinds = (['media', 'media_spend', 'reach', 'frequency'] as const).filter((k) => says(name, k))
  return kinds.length === 1 ? kinds[0] : undefined
}
// What is left of a paid column's name once its kind is taken out: the channel it measures.
const stem = (name: string) => pieces(name).filter((p) => ![WORDS.media, WORDS.media_spend, WORDS.reach, WORDS.frequency, NOISE].some((re) => re.test(p.toLowerCase())))
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
export const stemKey = (name: string) => norm(stem(name).join(''))
const stemName = (name: string) => stem(name).join('_') || name

/** The channel a column of this role goes to: the one its partners already map to (tv_imp → tv makes tv_spend tv), else its name less its kind. */
export function channelFor(ds: Dataset, column: string, key: string): string {
  const k = stemKey(column)
  if (k)
    for (const r of groupOf(key))
      for (const e of ds.maps[role(r)?.map ?? ''] ?? [])
        if (e.column.value !== column && e.channel && !isPlaceholder(e.channel.value) && (stemKey(e.column.value) === k || norm(e.channel.value) === k)) return e.channel.value
  return stemName(column)
}
/** Where channelFor's guess comes from, in a few words: "the channel of tv_imps", or "from its name". */
export function channelSource(ds: Dataset, column: string, key: string): string {
  const guess = channelFor(ds, column, key)
  const partner = groupOf(key)
    .flatMap((r) => ds.maps[role(r)?.map ?? ''] ?? [])
    .find((e) => e.column.value !== column && e.channel?.value === guess)
  return partner ? `the channel of ${partner.column.value}` : 'from its name'
}
/** Whether a column's name fits a role: how completion ranks it and how the tree's picker sorts. */
export function fits(key: string, name: string): boolean {
  if (key === 'revenue_per_kpi') return perKpi(name)
  if (key === 'kpi') return says(name, 'kpi') && !perKpi(name) && !paidKind(name)
  if (key === 'rf_spend') return paidKind(name) === 'media_spend'
  if (key === 'media' || key === 'media_spend' || key === 'reach' || key === 'frequency') return paidKind(name) === key
  if (key === 'controls' || key === 'non_media_treatments') return says(name, 'controls')
  if (key.startsWith('organic')) return says(name, 'organic')
  if (key === 'population') return says(name, 'population')
  return false
}

// --- Edits: a new text, changed only where it must be ------------------------------------------------------

export type Edit = { start: number; end: number; text: string }
/** Whether the YAML reads: every edit below needs its structure, and leaves a broken one as it is. */
export const parses = (text: string) => !parseDocument(text).errors.length
const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end)
const lineStart = (text: string, i: number) => text.lastIndexOf('\n', i - 1) + 1
const lineEnd = (text: string, i: number) => {
  const j = text.indexOf('\n', i)
  return j < 0 ? text.length : j
}
const indentAt = (text: string, i: number) => ' '.repeat(i - lineStart(text, i))
const colonOf = (text: string, p: AnyPair) => text.indexOf(':', p.key.range[1])
/** Where a node's own text ends: a block collection's last item, not the comments and lines after it. */
const endOf = (n: any): number => {
  if (isPair(n)) return n.value ? endOf(n.value) : (n.key as any).range[1]
  if ((isSeq(n) || isMap(n)) && !n.flow && n.items.length) return endOf(n.items[n.items.length - 1])
  return n.range[1]
}
const appendTop = (text: string, block: string) => `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block}\n`

/** A column or channel name as YAML writes it: bare when it reads back as the same string, else in double quotes. */
export function yamlName(name: string): string {
  const bare = /^[A-Za-z_][\w .()%/-]*$/.test(name) && !/\s$/.test(name) && !/^(true|false|yes|no|on|off|null|y|n)$/i.test(name)
  return bare ? name : JSON.stringify(name)
}
const flowList = (names: string[]) => `[${names.map(yamlName).join(', ')}]`
const entry = ([column, channel]: [string, string]) => `${yamlName(column)}: ${yamlName(channel)}`

/** The one replacement that turns a text into another: what lies between their common start and their common end. */
export function diff(before: string, after: string): Edit {
  let s = 0
  while (s < before.length && s < after.length && before[s] === after[s]) s++
  let e = 0
  while (e < before.length - s && e < after.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++
  return { start: s, end: before.length - e, text: after.slice(s, after.length - e) }
}

/** The pair's value replaced by this text (a scalar or a flow collection); a pair without a value gets it. */
function setValue(text: string, p: AnyPair, rendered: string): string {
  const v = p.value
  if (v?.range && v.range[1] > v.range[0]) {
    if ((isSeq(v) || isMap(v)) && !v.flow) return splice(text, colonOf(text, p) + 1, endOf(v), ` ${rendered}`)
    return splice(text, v.range[0], v.range[1], rendered)
  }
  const colon = colonOf(text, p)
  let q = colon + 1
  while (text[q] === ' ' || text[q] === '\t') q++
  return splice(text, colon + 1, q, ` ${rendered}${text[q] === '#' ? ' ' : ''}`)
}
/** A new role under coord_to_columns, after its last one; coord_to_columns itself when missing. */
function addRole(text: string, doc: { contents: unknown }, key: string, rendered: string): string {
  const c = top(doc, 'coord_to_columns')
  if (!c) return appendTop(text, `coord_to_columns:\n  ${key}: ${rendered}`)
  const m = c.value
  if (isMap(m) && m.items.length) {
    const items = m.items as AnyPair[]
    const last = endOf(items[items.length - 1])
    if (m.flow) return splice(text, last, last, `, ${key}: ${rendered}`)
    // The template's commented line for this role (`# revenue_per_kpi: <column>`) becomes the real one.
    const block = text.slice(0, text.slice(last).search(/\n[^\s#]|$/) + last)
    const commented = new RegExp(`^([ \\t]+)#[ \\t]*${key}:[^,\\n]*$`, 'm').exec(block.slice(c.key.range[1]))
    if (commented) {
      const at = c.key.range[1] + commented.index
      return splice(text, at, at + commented[0].length, `${commented[1]}${key}: ${rendered}`)
    }
    const at = lineEnd(text, last)
    return splice(text, at, at, `\n${indentAt(text, items[0].key.range[0])}${key}: ${rendered}`)
  }
  if (isMap(m) || (isScalar(m) && m.value !== null)) return setValue(text, c, `{ ${key}: ${rendered} }`)
  const at = lineEnd(text, colonOf(text, c))
  return splice(text, at, at, `\n  ${key}: ${rendered}`)
}

/** A scalar set: kpi_type at the top, or a one-column role (time, kpi…); the key added when missing. */
export function setScalar(text: string, path: [string] | ['coord_to_columns', string], rendered: string): string {
  if (!parses(text)) return text
  const doc = parseDocument(text)
  if (path.length === 1) {
    const p = top(doc, path[0])
    return p ? setValue(text, p, rendered) : appendTop(text, `${path[0]}: ${rendered}`)
  }
  const p = coordPair(doc, path[1])
  return p ? setValue(text, p, rendered) : addRole(text, doc, path[1], rendered)
}

/** Columns added to a list role, after the ones there; the template's blanks go. */
export function addItems(text: string, key: string, columns: string[]): string {
  if (!parses(text)) return text
  const doc = parseDocument(text)
  const p = coordPair(doc, key)
  if (!p) return addRole(text, doc, key, flowList(columns))
  const v = p.value
  if (!isSeq(v)) {
    const held = isScalar(v) && v.value != null && !isPlaceholder(String(v.value)) ? [String(v.value)] : []
    return setValue(text, p, flowList([...new Set([...held, ...columns])]))
  }
  const items = v.items.filter(isScalar) as Scalar[]
  const keep = items.map((i) => (i.value == null ? '' : String(i.value))).filter((s) => !isPlaceholder(s))
  const add = [...new Set(columns)].filter((c) => !keep.includes(c))
  if (!add.length && keep.length === items.length) return text
  const range = v.range!
  if (keep.length < items.length || !items.length) {
    const all = [...keep, ...add]
    if (v.flow) return splice(text, range[0], range[1], flowList(all))
    return splice(text, range[0], endOf(v), all.map((c) => `- ${yamlName(c)}`).join(`\n${indentAt(text, range[0])}`))
  }
  const last = items[items.length - 1].range![1]
  if (v.flow) return splice(text, last, last, add.map((c) => `, ${yamlName(c)}`).join(''))
  const at = lineEnd(text, last)
  return splice(text, at, at, add.map((c) => `\n${indentAt(text, range[0])}- ${yamlName(c)}`).join(''))
}

/** Entries added to a *_to_channel map, after the ones there (the map added after its kin when missing); the template's blanks go. */
export function addEntries(text: string, map: string, entries: [string, string][]): string {
  if (!parses(text)) return text
  const doc = parseDocument(text)
  const p = top(doc, map)
  if (!p) {
    const kin = pairs(doc).filter((q) => keyOf(q).endsWith('_to_channel'))
    const block = `${map}:\n${entries.map((e) => `  ${entry(e)}`).join('\n')}`
    if (!kin.length) return appendTop(text, block)
    const at = lineEnd(text, endOf(kin[kin.length - 1]))
    return splice(text, at, at, `\n${block}`)
  }
  const v = p.value
  if (isMap(v)) {
    const items = v.items as AnyPair[]
    const keep = items.filter((q) => !isPlaceholder(keyOf(q)))
    const have = new Set(keep.map(keyOf))
    const add = entries.filter(([c]) => !have.has(c))
    if (!add.length && keep.length === items.length) return text
    const source = (q: AnyPair) => text.slice(q.key.range[0], endOf(q))
    if (keep.length < items.length || !items.length) {
      const all = [...keep.map(source), ...add.map(entry)]
      if (v.flow) return splice(text, v.range![0], v.range![1], `{ ${all.join(', ')} }`)
      return splice(text, items[0].key.range[0], endOf(v), all.join(`\n${indentAt(text, items[0].key.range[0])}`))
    }
    const last = endOf(items[items.length - 1])
    if (v.flow) return splice(text, last, last, add.map((e) => `, ${entry(e)}`).join(''))
    const at = lineEnd(text, last)
    return splice(text, at, at, add.map((e) => `\n${indentAt(text, items[0].key.range[0])}${entry(e)}`).join(''))
  }
  // `media_to_channel:` with nothing under it, or a stray value (`~`): the entries under it
  const t = v?.range && v.range[1] > v.range[0] ? splice(text, colonOf(text, p) + 1, v.range[1], '') : text
  const at = lineEnd(t, colonOf(text, p))
  return splice(t, at, at, entries.map((e) => `\n  ${entry(e)}`).join(''))
}

function removeItem(text: string, p: AnyPair, coll: any, i: number): string {
  const items = coll.items
  const start = (it: any): number => (isPair(it) ? (it.key as any).range[0] : it.range[0])
  // the last one out: an empty collection (a block item's comment goes with it; a flow list's is the list's)
  if (items.length === 1) return splice(text, colonOf(text, p) + 1, coll.flow ? endOf(coll) : lineEnd(text, endOf(coll)), isSeq(coll) ? ' []' : ' {}')
  if (coll.flow) return i < items.length - 1 ? splice(text, start(items[i]), start(items[i + 1]), '') : splice(text, endOf(items[i - 1]), endOf(items[i]), '')
  return splice(text, lineStart(text, start(items[i])), lineEnd(text, endOf(items[i])) + 1, '') // its whole line
}
function removeOnce(text: string, column: string, keys: string[]): string | undefined {
  const doc = parseDocument(text)
  for (const key of keys) {
    const p = coordPair(doc, key)
    const v = p?.value
    if (isSeq(v)) {
      const i = v.items.findIndex((it) => isScalar(it) && String(it.value) === column)
      if (i >= 0) return removeItem(text, p!, v, i)
    } else if (isScalar(v) && v.value != null && String(v.value) === column) return splice(text, colonOf(text, p!) + 1, v.range![1], role(key)?.many ? ' []' : '')
    const m = role(key)?.map ? top(doc, role(key)!.map!) : undefined
    if (m && isMap(m.value)) {
      const i = (m.value.items as AnyPair[]).findIndex((q) => keyOf(q) === column)
      if (i >= 0) return removeItem(text, m, m.value, i)
    }
  }
}
/** The column taken out of these roles (all by default): out of their lists and of their *_to_channel maps. */
export function removeColumn(text: string, column: string, keys = ROLES.map((r) => r.key)): string {
  if (!parses(text)) return text
  for (let n = 0; n < 100; n++) {
    const next = removeOnce(text, column, keys)
    if (next === undefined) break
    text = next
  }
  return text
}

/** A list role written again with its columns in this order. */
export function reorder(text: string, key: string, columns: string[]): string {
  if (!parses(text)) return text
  const v = coordPair(parseDocument(text), key)?.value
  if (!isSeq(v) || !v.range) return text
  if (v.flow) return splice(text, v.range[0], v.range[1], flowList(columns))
  return splice(text, v.range[0], endOf(v), columns.map((c) => `- ${yamlName(c)}`).join(`\n${indentAt(text, v.range[0])}`))
}
const channelsOf = (ds: Dataset, key: string) => new Map((ds.maps[role(key)?.map ?? ''] ?? []).map((e) => [e.column.value, e.channel?.value]))
/** A role's columns ordered as the lead role orders their channels (media_spend as media), which is how Meridian pairs them. */
export function alignOrder(text: string, lead: string, key: string): string {
  const ds = readDataset(text)
  const order = (ds.roles[lead] ?? []).map((n) => channelsOf(ds, lead).get(n.value))
  const mine = channelsOf(ds, key)
  const rank = (c: string) => {
    const i = order.indexOf(mine.get(c))
    return i < 0 ? order.length : i
  }
  const columns = (ds.roles[key] ?? []).map((n) => n.value)
  const sorted = [...columns].sort((a, b) => rank(a) - rank(b))
  return sorted.join('\0') === columns.join('\0') ? text : reorder(text, key, sorted)
}

/** These columns given this role, out of any other; a role with channels maps each column to one (named, or guessed). */
export function assign(text: string, columns: string[], key: string, channel?: (column: string) => string): string {
  const r = role(key)
  if (!r || !columns.length || !parses(text)) return text
  for (const c of columns) text = removeColumn(text, c)
  text = r.many ? addItems(text, key, columns) : setScalar(text, ['coord_to_columns', key], yamlName(columns[0]))
  if (r.map) {
    const ds = readDataset(text)
    text = addEntries(text, r.map, columns.map((c) => [c, channel?.(c) ?? channelFor(ds, c, key)]))
  }
  return text
}

// --- Complete from the CSV: the roles a column's content and name give it ----------------------------------

export type Completed = { text: string; done: { key: string; columns: string[]; channel?: string }[]; left: string[] }
/**
 * Fills what the YAML leaves blank from what the CSV holds: the dates column as time, the column that repeats
 * them as geo, a KPI and a revenue per KPI by name, each paid channel by pairing its impressions (or reach and
 * frequency) with its spend, and controls by name. A column it cannot place stays unused, for the person.
 */
export function complete(text: string, csv: Profile): Completed {
  const done: Completed['done'] = []
  if (!parses(text)) return { text, done, left: [] }
  const col = (c: string) => csv.columns.get(c)
  const numbers = (c: string) => col(c)?.type === 'numbers'
  const free = () => {
    const used = usage(readDataset(text))
    return csv.header.filter((c) => !used.has(c))
  }
  const filled = (key: string) => (readDataset(text).roles[key] ?? []).some((n) => !isPlaceholder(n.value) && csv.columns.has(n.value))
  const take = (key: string, columns: string[], channel?: string) => {
    if (!columns.length) return
    text = assign(text, columns, key, channel === undefined ? undefined : () => channel)
    done.push({ key, columns, ...(channel !== undefined && { channel }) })
  }
  const first = (test: (c: string) => boolean) => free().filter(test).slice(0, 1)

  if (!filled('time')) take('time', first((c) => col(c)?.type === 'dates'))
  const t = col(readDataset(text).roles.time?.[0]?.value ?? '')
  if (t && t.distinct < t.filled && !filled('geo')) take('geo', first((c) => col(c)?.type === 'text' && col(c)!.distinct * t.distinct === t.filled))
  if (!filled('kpi')) take('kpi', first((c) => numbers(c) && fits('kpi', c)))
  if (!filled('revenue_per_kpi')) {
    const c = first((c) => numbers(c) && fits('revenue_per_kpi', c))
    take('revenue_per_kpi', c)
    if (c.length && readDataset(text).kpiType?.value === 'revenue') {
      text = setScalar(text, ['kpi_type'], 'non_revenue') // Meridian ignores revenue_per_kpi otherwise
      done.push({ key: 'kpi_type', columns: [], channel: 'non_revenue' })
    }
  }
  if (!filled('population')) take('population', first((c) => numbers(c) && fits('population', c)))

  // Paid channels: each column's kind from its name, paired by the rest of its name, with what is already placed.
  const ds = readDataset(text)
  const placed = new Map<string, string>() // column → its paid role
  for (const key of ['media', 'media_spend', 'reach', 'frequency', 'rf_spend']) for (const n of ds.roles[key] ?? []) if (!isPlaceholder(n.value)) placed.set(n.value, key)
  const stems = new Map<string, Partial<Record<Paid, string[]>>>()
  const note = (c: string, kind: Paid) => {
    const k = stemKey(c)
    if (!k) return
    const s = stems.get(k) ?? {}
    ;(s[kind] ??= []).push(c)
    stems.set(k, s)
  }
  for (const c of free()) if (numbers(c) && paidKind(c)) note(c, paidKind(c)!)
  for (const [c, key] of placed) note(c, key === 'rf_spend' ? 'media_spend' : (key as Paid))
  for (const s of stems.values()) {
    const one = (kind: Paid) => (s[kind]?.length === 1 ? s[kind]![0] : undefined)
    const [media, spend, reach, frequency] = [one('media'), one('media_spend'), one('reach'), one('frequency')]
    const plan: [string, string][] =
      media && spend && !s.reach && !s.frequency ? [[media, 'media'], [spend, 'media_spend']]
      : reach && frequency && spend && !s.media ? [[reach, 'reach'], [frequency, 'frequency'], [spend, 'rf_spend']]
      : []
    if (!plan.length || plan.every(([c]) => placed.has(c))) continue
    const now = readDataset(text)
    const known = plan.map(([c, key]) => placed.has(c) && channelsOf(now, key).get(c)).find((ch) => ch && !isPlaceholder(ch))
    const channel = known || stemName(plan[0][0])
    for (const [c, key] of plan) if (!placed.has(c)) take(key, [c], channel)
  }
  for (const [lead, ...rest] of GROUPS) for (const key of rest) text = alignOrder(text, lead, key)

  take('controls', free().filter((c) => numbers(c) && says(c, 'controls') && !paidKind(c)))
  take('organic_media', free().filter((c) => numbers(c) && says(c, 'organic') && (!paidKind(c) || paidKind(c) === 'media')))
  return { text, done, left: free() }
}

/** What complete() did, in a sentence: "time, kpi conversions, 4 channels (tv, radio…), 2 controls. Left unused: misc." */
export function summarize(r: Completed, file: string): string {
  const parts: string[] = []
  const of = (key: string) => r.done.filter((d) => d.key === key).flatMap((d) => d.columns)
  for (const key of ['time', 'geo', 'kpi', 'revenue_per_kpi', 'population']) if (of(key).length) parts.push(`${key} ${of(key)[0]}`)
  if (r.done.some((d) => d.key === 'kpi_type')) parts.push('kpi_type non_revenue')
  const channels = [...new Set(r.done.filter((d) => role(d.key)?.map).map((d) => d.channel ?? ''))]
  if (channels.length) parts.push(`${channels.length} channel${channels.length > 1 ? 's' : ''} (${channels.join(', ')})`)
  for (const [key, one] of [['controls', 'control'], ['organic_media', 'organic media']]) {
    const n = of(key).length
    if (n) parts.push(`${n} ${one}${n > 1 && key === 'controls' ? 's' : ''}`)
  }
  const left = r.left.length ? ` Left unused: ${r.left.join(', ')}.` : ''
  return parts.length ? `From ${file}: ${parts.join(', ')}.${left}` : `Nothing to complete from ${file}.${left}`
}

// --- Checks: what the editor underlines, each with its fixes ------------------------------------------------

export type Fix = { title: string; edit: (text: string) => string; preferred?: boolean }
export type Problem = { start: number; end: number; severity: 'error' | 'warning'; message: string; fixes: Fix[] }

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}
/** The column a name most likely meant: the same once case and separators are dropped, else a typo away. */
export function closest(name: string, header: string[]): string | undefined {
  const same = header.find((h) => norm(h) === norm(name))
  if (same) return same
  let best: string | undefined
  let most = Math.max(1, Math.floor(name.length / 4))
  for (const h of header) {
    const d = distance(name.toLowerCase(), h.toLowerCase())
    if (d <= most) [best, most] = [h, d - 1]
  }
  return best
}

/** What is wrong in a dataset's YAML, against its CSV (undefined when the CSV cannot be read). */
export function check(text: string, csv: Profile | undefined): Problem[] {
  const ds = readDataset(text)
  const out: Problem[] = []
  const flag = (at: { start: number; end: number }, severity: Problem['severity'], message: string, ...fixes: (Fix | undefined)[]) =>
    out.push({ start: at.start, end: at.end, severity, message, fixes: fixes.filter((f): f is Fix => !!f) })
  if (ds.csv && !csv) flag(ds.csv, 'error', `${ds.csv.value} not found`)
  const file = csv?.file ?? 'the CSV'
  const header = new Set(csv?.header ?? [])
  const uses = usage(ds)
  const free = csv ? csv.header.filter((c) => !uses.has(c)) : []
  const fill: Fix | undefined = csv && { title: `Complete from ${file}`, edit: (t) => complete(t, csv).text }
  const real = (key: string) => (ds.roles[key] ?? []).filter((n) => !isPlaceholder(n.value))

  /** Whether a name is a column of the CSV; when it is not, says so (a blank to fill, or a name it does not have). */
  const known = (n: Named, what = `a column of ${file}`) => {
    if (isPlaceholder(n.value)) return flag(n, 'warning', `Name ${what} here`, fill), false
    if (!csv || header.has(n.value)) return !!csv
    const near = closest(n.value, csv.header)
    flag(n, 'error', `${n.value} is not a column of ${file}`, near ? { title: `Replace with ${near}`, edit: (t) => splice(t, n.start, n.end, yamlName(near)), preferred: true } : undefined)
    return false
  }

  // Each role's columns: in the CSV, and holding what the role needs.
  for (const [key, nodes] of Object.entries(ds.roles)) {
    const r = role(key)
    if (!r) continue // the schema flags an unknown role
    for (const n of nodes) {
      if (!known(n)) continue
      const c = csv!.columns.get(n.value)!
      const odd = c.odd ? ` ("${c.odd}")` : ''
      if (c.type === 'empty') flag(n, 'warning', `${n.value} is empty`)
      else if (key === 'time' && c.type !== 'dates') flag(n, 'error', `${n.value} holds ${c.type}${odd}, not dates`)
      else if (key === 'time' && !c.iso) flag(n, 'error', `Meridian reads dates written yyyy-mm-dd; ${n.value} has "${c.odd}"`)
      else if (key === 'time' && c.distinct < c.filled && !real('geo').length) {
        const geos = free.filter((g) => csv!.columns.get(g)?.type === 'text' && csv!.columns.get(g)!.distinct * c.distinct === c.filled)
        flag(n, 'error', `${n.value} repeats (${c.distinct} dates over ${c.filled} rows): a geo dataset names its geo column`, ...geos.map((g) => ({ title: `Use ${g} as geo`, edit: (t: string) => assign(t, [g], 'geo') })))
      } else if (r.numeric && c.type !== 'numbers') flag(n, 'error', `${n.value} holds ${c.type}${odd}, not numbers`)
    }
  }

  // A column in two roles (but media and its spend).
  for (const [c, keys] of uses) {
    const clash = keys.filter((k) => keys.some((o) => !shareable(k, o)))
    for (const k of clash)
      for (const n of real(k).filter((x) => x.value === c))
        flag(n, 'warning', `${c} is also used as ${clash.filter((o) => o !== k).join(', ')}`, { title: `Remove ${c} from ${k}`, edit: (t) => removeColumn(t, c, [k]) })
  }

  // Each *_to_channel map: the same columns as its role, each with a channel.
  for (const r of ROLES) {
    if (!r.map) continue
    const entries = ds.maps[r.map] ?? []
    const keys = new Set(entries.map((e) => e.column.value))
    const missing = real(r.key).filter((n) => !keys.has(n.value))
    const add: Fix = {
      title: missing.length > 1 ? `Add the ${missing.length} columns to ${r.map}` : `Add ${missing[0]?.value} to ${r.map}`,
      edit: (t) => {
        const now = readDataset(t)
        return addEntries(t, r.map!, missing.map((n) => [n.value, channelFor(now, n.value, r.key)]))
      },
      preferred: true
    }
    for (const n of missing) flag(n, 'error', `${n.value} has no channel: add it to ${r.map}`, add)
    const listed = new Set(real(r.key).map((n) => n.value))
    for (const e of entries) {
      if (!known(e.column, `a ${r.key} column`)) continue
      if (!listed.has(e.column.value))
        flag(e.column, 'error', `${e.column.value} is in ${r.map} but not in coord_to_columns.${r.key}`,
          { title: `Add ${e.column.value} to ${r.key}`, edit: (t) => addItems(t, r.key, [e.column.value]), preferred: true },
          { title: `Remove ${e.column.value} from ${r.map}`, edit: (t) => removeColumn(t, e.column.value, [r.key]) })
      if (!e.channel || isPlaceholder(e.channel.value)) flag(e.channel ?? e.column, 'warning', `Name the channel of ${e.column.value}`)
    }
  }

  // Roles that pair up (media and media_spend…): all there, the same channels, in the same order.
  for (const g of GROUPS) {
    const present = g.filter((k) => real(k).length)
    if (!present.length) continue
    const absent = g.filter((k) => !(ds.roles[k] ?? []).length)
    if (absent.length) {
      flag(ds.roleKeys[present[0]], 'error', `${present[0]} needs ${absent.join(' and ')} too`, fill)
      continue
    }
    if (present.length < g.length) continue // blanks left: flagged above
    const lists = g.map((k) => real(k).map((n) => channelsOf(ds, k).get(n.value)))
    if (lists.some((l) => l.some((ch) => !ch || isPlaceholder(ch)))) continue // unmapped: flagged above
    const sets = lists.map((l) => new Set(l))
    let same = true
    g.forEach((k, i) => {
      for (const e of ds.maps[role(k)!.map!] ?? []) {
        const ch = e.channel?.value
        const lacking = g.filter((_, j) => j !== i && ch && !sets[j].has(ch))
        if (!ch || !lacking.length || !listed(k, e.column.value)) continue
        same = false
        const partner = (o: string) => {
          const kind: Paid = o === 'rf_spend' ? 'media_spend' : (o as Paid)
          const c = free.find((x) => csv?.columns.get(x)?.type === 'numbers' && paidKind(x) === kind && [stemKey(e.column.value), norm(ch)].includes(stemKey(x)))
          return c ? { title: `Use ${c} as the ${o} of ${ch}`, edit: (t: string) => assign(t, [c], o, () => ch) } : undefined
        }
        flag(e.channel!, 'error', `Channel ${ch} has ${k} but no ${lacking.join(' nor ')}`, ...lacking.map(partner))
      }
    })
    if (!same) continue
    g.slice(1).forEach((k, i) => {
      const [lead, mine] = [lists[0] as string[], lists[i + 1] as string[]]
      if (mine.join('\0') !== lead.join('\0'))
        flag(ds.roleKeys[k], 'error', `${k} lists its channels as ${mine.join(', ')}, ${g[0]} as ${lead.join(', ')}: Meridian pairs them by position`, { title: `Order ${k} like ${g[0]}`, edit: (t) => alignOrder(t, g[0], k), preferred: true })
    })
  }
  function listed(key: string, column: string) {
    return real(key).some((n) => n.value === column)
  }

  if (ds.coord && !['media', 'media_spend', 'reach', 'frequency', 'rf_spend'].some((k) => (ds.roles[k] ?? []).length))
    flag(ds.coord, 'error', 'Meridian needs paid media: media and media_spend, or reach, frequency and rf_spend', fill)
  const rpk = real('revenue_per_kpi')[0]
  if (rpk && ds.kpiType?.value === 'revenue')
    flag(rpk, 'warning', 'Meridian ignores revenue_per_kpi with kpi_type: revenue (the KPI is already money)', { title: 'Set kpi_type: non_revenue', edit: (t) => setScalar(t, ['kpi_type'], 'non_revenue') })
  return out
}

// --- Where the cursor is, what to complete there, what a hover says -----------------------------------------

export type Where = ({ what: 'csv' } | { what: 'role'; role: Role } | { what: 'key'; role: Role } | { what: 'channel'; role: Role; column: string }) & {
  start: number // the value being typed, which a completion replaces
  end: number
  quoted: boolean
  flow: boolean // inside [ ] or { }
}
const MARK = '⁣' // an invisible character the cursor's scalar takes, so a half-typed YAML still says where the cursor is
/** What the cursor is on: the csv, a role's column, a *_to_channel key (a column) or value (a channel). */
export function where(text: string, offset: number): Where | undefined {
  const doc = parseDocument(text.slice(0, offset) + MARK + text.slice(offset))
  let hit: { key: unknown; node: Scalar; path: readonly unknown[] } | undefined
  visit(doc, {
    Scalar(key, node, path) {
      if (typeof node.value === 'string' && node.value.includes(MARK)) {
        hit = { key, node, path }
        return visit.BREAK
      }
    }
  })
  if (!hit?.node.range) return
  const keys = hit.path.filter(isPair).map((p) => keyOf(p as AnyPair))
  const quoted = hit.node.type === 'QUOTE_DOUBLE' || hit.node.type === 'QUOTE_SINGLE'
  const [start, end] = [hit.node.range[0] + (quoted ? 1 : 0), hit.node.range[1] - MARK.length - (quoted ? 1 : 0)]
  const flow = hit.path.some((n) => (isSeq(n) || isMap(n)) && !!n.flow)
  const at = { start, end, quoted, flow }
  const value = hit.key === 'value' || typeof hit.key === 'number'
  if (keys.length === 1 && keys[0] === 'csv' && value) return { what: 'csv', ...at }
  if (keys.length === 2 && keys[0] === 'coord_to_columns' && value) {
    const r = role(keys[1])
    return r && { what: 'role', role: r, ...at }
  }
  const r = ROLES.find((x) => x.map && x.map === keys[0])
  if (!r) return
  if (keys.length === 1 && value) return { what: 'key', role: r, ...at } // the first entry of an empty map
  if (keys.length === 2) return hit.key === 'key' ? { what: 'key', role: r, ...at } : value ? { what: 'channel', role: r, column: keys[1], ...at } : undefined
}

export type Suggestion = { label: string; detail?: string; doc?: string; insert: string; snippet?: boolean; sort: string; start: number; end: number; kind: 'column' | 'channel' | 'all' }
const pad = (i: number) => String(i).padStart(4, '0')
const snippetText = (s: string) => s.replace(/[$}\\]/g, '\\$&')
/** How well a column fits a role, 0 best: its content first (dates for time, numbers for a KPI), then its name. */
function rank(r: Role, c: ColumnProfile | undefined): number {
  if (!c) return 3
  if (r.key === 'time') return c.type === 'dates' ? 0 : 2
  if (r.key === 'geo') return c.type === 'text' ? 0 : 2
  if (c.type !== 'numbers') return 3
  return fits(r.key, c.name) ? 0 : 1
}
/** What to offer where the cursor is: the CSV's columns a role may take, a map's missing keys, the channels. */
export function suggest(text: string, offset: number, csv: Profile | undefined): Suggestion[] {
  const w = where(text, offset)
  if (!w || w.what === 'csv' || !csv) return []
  const ds = readDataset(text)
  const uses = usage(ds)
  const own = text.slice(w.start, w.end)
  const name = (c: string) => (w.quoted ? c : yamlName(c))
  const span = { start: w.start, end: w.end }
  const r = w.role
  const columns = () => {
    const mine = new Set((ds.roles[r.key] ?? []).map((n) => n.value))
    return csv.header.filter((c) => c === own || (!mine.has(c) && (uses.get(c) ?? []).every((k) => shareable(r.key, k))))
  }
  if (w.what === 'role')
    return columns().map((c, i) => {
      const p = csv.columns.get(c)!
      const doc = p.samples.length ? `e.g. ${p.samples.map((x) => `\`${x}\``).join(', ')}` : undefined
      return { label: c, detail: describe(p), doc, insert: name(c), sort: `${rank(r, p)}${pad(i)}`, kind: 'column', ...span }
    })
  if (w.what === 'key') {
    const keys = new Set((ds.maps[r.map!] ?? []).map((e) => e.column.value))
    let cols = realOf(ds, r.key).filter((c) => !keys.has(c))
    if (!realOf(ds, r.key).length) cols = columns().filter((c) => rank(r, csv.columns.get(c)) < 2) // the map written first: the columns that fit
    const ch = (c: string) => channelFor(ds, c, r.key)
    if (w.quoted) return cols.map((c, i) => ({ label: c, insert: c, sort: pad(i), kind: 'column', ...span }))
    const out: Suggestion[] = cols.map((c, i) => ({ label: c, detail: `→ ${ch(c)}`, insert: `${snippetText(name(c))}: \${1:${snippetText(ch(c))}}`, snippet: true, sort: `1${pad(i)}`, kind: 'column', ...span }))
    if (cols.length > 1)
      out.unshift({
        label: `All ${cols.length} columns of ${r.key}`,
        detail: cols.map((c) => `${c} → ${ch(c)}`).join(', '),
        insert: cols.map((c, i) => `${snippetText(name(c))}: \${${i + 1}:${snippetText(ch(c))}}`).join(w.flow ? ', ' : '\n'),
        snippet: true,
        sort: '0',
        kind: 'all',
        ...span
      })
    return out
  }
  // A channel: the one this column's partners have, then the group's others, then the ones this map already uses.
  const guess = channelFor(ds, w.column, r.key)
  const taken = new Set((ds.maps[r.map!] ?? []).filter((e) => e.column.value !== w.column).map((e) => e.channel?.value))
  const names = [guess, ...groupOf(r.key).flatMap((k) => (ds.maps[role(k)?.map ?? ''] ?? []).map((e) => e.channel?.value ?? ''))].filter((c) => c && !isPlaceholder(c))
  return [...new Set(names)].map((c, i) => ({
    label: c,
    detail: c === guess ? channelSource(ds, w.column, r.key) : taken.has(c) ? `already in ${r.map}` : undefined,
    insert: name(c),
    sort: `${c === guess ? 0 : taken.has(c) ? 2 : 1}${pad(i)}`,
    kind: 'channel',
    ...span
  }))
}
const realOf = (ds: Dataset, key: string) => (ds.roles[key] ?? []).map((n) => n.value).filter((v) => !isPlaceholder(v))

/** What a hover says, in Markdown: a column's content and roles, a channel's columns, the CSV as a whole. */
export function hover(text: string, offset: number, csv: Profile | undefined): { markdown: string; start: number; end: number } | undefined {
  let hit: { key: unknown; node: Scalar; path: readonly unknown[] } | undefined
  visit(parseDocument(text), {
    Scalar(key, node, path) {
      if (node.range && node.value != null && node.range[0] <= offset && offset <= node.range[1]) {
        hit = { key, node, path }
        return visit.BREAK
      }
    }
  })
  if (!hit || !csv) return
  const keys = hit.path.filter(isPair).map((p) => keyOf(p as AnyPair))
  const at = { start: hit.node.range![0], end: hit.node.range![1] }
  const ds = readDataset(text)
  const uses = usage(ds)
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``
  if (keys.length === 1 && keys[0] === 'csv' && hit.key === 'value') {
    const unused = csv.header.filter((h) => !uses.has(h))
    const head = `${code(csv.file)} · ${csv.rows} rows · ${csv.header.length} columns${csv.partial ? ' (profiled from its first rows)' : ''}`
    return { markdown: `${head}\n\n${unused.length ? `Not used: ${unused.map(code).join(', ')}` : 'Every column is used.'}`, ...at }
  }
  const map = keys[0]?.endsWith('_to_channel') && keys.length === 2
  const value = String(hit.node.value)
  const c = csv.columns.get(value)
  const column = (keys.length === 2 && keys[0] === 'coord_to_columns' && hit.key !== 'key') || (map && hit.key === 'key')
  if (column && c) {
    const roles = uses.get(value)
    const samples = c.samples.length ? `\n\ne.g. ${c.samples.map(code).join(', ')}` : ''
    return { markdown: `${code(c.name)} · ${describe(c)}${samples}\n\n${roles ? `Used as ${roles.join(', ')}` : 'Not used'}`, ...at }
  }
  if (map && hit.key === 'value') {
    const parts = ROLES.filter((r) => r.map).flatMap((r) => (ds.maps[r.map!] ?? []).filter((e) => e.channel?.value === value).map((e) => `${r.key} ${code(e.column.value)}`))
    return { markdown: `Channel **${value.replace(/[*_`]/g, '\\$&')}**: ${parts.join(' · ')}`, ...at }
  }
}
