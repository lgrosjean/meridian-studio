// Meridian Studio: datasets/, models/ and scenarios/ of the workspace as three trees. Each entry is a YAML
// file the person edits here. A dataset only points at a CSV (Meridian's CsvDataLoader arguments); a model's
// or a scenario's play button hands it to the Python runner (runner/), which leaves <name>.run.json and
// <name>.result.json next to it. Nothing else is stored.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import * as vscode from 'vscode'
import { parse } from 'yaml'
import { completeDataset, registerAssist, setRole } from './assist'
import { profileOf } from './csv'
import { registerDataChecks } from './datachecks'
import { ROLES, complete, isPlaceholder, readDataset, summarize } from './dataset'
import { openPanels, showReport, showResults } from './results'
import { RunsView, type RunRow } from './runs'

type Root = 'datasets' | 'models' | 'scenarios'
type Check = { status: 'fail' | 'review' | 'info'; title: string; text: string; vars?: string[] }
type RunRecord = {
  status: 'Running' | 'Done' | 'Failed'
  startedAt: string
  finishedAt?: string
  error?: string
  fingerprint: string // what the run depended on, to tell when it is outdated
  summary?: Record<string, unknown>
  checks?: Check[]
}
// Each kind: the runner's command, and the kind it depends on (named by `key` in its YAML).
const KINDS: Record<Root, { verb: string; command?: string; parent?: Root; key?: string; one: string }> = {
  datasets: { verb: 'Use', one: 'dataset' }, // nothing to run: a fit reads the CSV
  models: { verb: 'Fit', command: 'fit', parent: 'datasets', key: 'dataset', one: 'model' },
  scenarios: { verb: 'Optimize', command: 'optimize', parent: 'models', key: 'model', one: 'scenario' }
}
const ROOTS = Object.keys(KINDS) as Root[]

const sha = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const project = (): string => {
  const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!dir) throw new Error('Open a folder first: datasets/, models/ and scenarios/ live in it')
  return dir
}
const yamlOf = (root: Root, name: string) => join(project(), root, `${name}.yaml`)
const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
const recordOf = (root: Root, name: string) => readJson<RunRecord>(join(project(), root, `${name}.run.json`))
// ponytail: the tree needs one top-level scalar (`dataset:` or `model:`), read with a regex; the runner validates the YAML.
const topLevel = (text: string, key: string) => text.match(new RegExp(`^${key}:[ \\t]*([^#\\n]*?)[ \\t]*(?:#.*)?$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '')
const parentOf = (root: Root, name: string) => (KINDS[root].key ? topLevel(fs.readFileSync(yamlOf(root, name), 'utf8'), KINDS[root].key!) : undefined)
/** A dataset's CSV, absolute; relative paths are the project's. */
const csvOf = (name: string): string | undefined => {
  const csv = topLevel(fs.readFileSync(yamlOf('datasets', name), 'utf8'), 'csv')
  return csv ? (isAbsolute(csv) ? csv : join(project(), csv)) : undefined
}

/** A YAML less its top-level `checks:` block (and the indented lines under it): which data checks are off is not data. */
const withoutChecks = (text: string) => {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => /^checks:/.test(l))
  if (at < 0) return text
  let end = at + 1
  for (let i = at + 1; i < lines.length && !/^\S/.test(lines[i]); i++) if (lines[i].trim()) end = i + 1 // up to its last indented line
  return [...lines.slice(0, at), ...lines.slice(end)].join('\n')
}
/** What a run depends on: its YAML, and for a model or a scenario what its parent last produced. */
function fingerprintOf(root: Root, name: string): string {
  const { parent, key } = KINDS[root]
  // Its own name and its parent's name are not content: a rename leaves the runs current.
  const text = withoutChecks(fs.readFileSync(yamlOf(root, name), 'utf8')).replace(new RegExp(`^(name${key ? `|${key}` : ''}):.*$`, 'gm'), '')
  if (!parent) {
    const csv = csvOf(name)
    return sha(`${text}\n${csv && fs.existsSync(csv) ? sha(fs.readFileSync(csv).toString('latin1')) : 'no csv'}`)
  }
  const p = parentOf(root, name)
  const made = p && fs.existsSync(yamlOf(parent, p)) ? (parent === 'datasets' ? fingerprintOf(parent, p) : recordOf(parent, p)?.summary?.fingerprint) : undefined
  return sha(`${text}\n${String(made ?? 'nothing yet')}`)
}
/** The HTML Meridian wrote for a fit (in mlruns/) or an optimization (next to the scenario). */
function reportOf(root: Root, name: string): string | undefined {
  const r = readJson<{ mlflow?: { report?: string }; report?: string }>(join(project(), root, `${name}.result.json`))
  const rel = root === 'models' ? r?.mlflow?.report : root === 'scenarios' ? r?.report : undefined
  const abs = rel && join(project(), rel)
  return abs && fs.existsSync(abs) ? abs : undefined
}

// --- uv, which runs the Python runner ---------------------------------------------------------
// Found on PATH or where its installers put it; else, with the person's consent, installed by Astral's
// installer into this extension's storage (no PATH or shell profile change, no self-updater).

const UV_VERSION = '0.9.28' // the installer is pinned: the same uv everywhere
const exe = process.platform === 'win32' ? 'uv.exe' : 'uv'
let storage = '' // the extension's global storage, set on activation

function findUv(): string | undefined {
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(storage, 'uv'),
    join(homedir(), '.local', 'bin'), // an app started from the Dock has a short PATH
    join(homedir(), '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  for (const d of dirs) if (d && fs.existsSync(join(d, exe))) return join(d, exe)
}

let installing: Promise<string> | undefined // one install at a time, whoever asks
async function ensureUv(out: vscode.OutputChannel): Promise<string> {
  const found = findUv()
  if (found) return found
  if (installing) return installing
  const pick = await vscode.window.showInformationMessage(
    'Meridian Studio runs Meridian through uv, which is not installed.',
    { modal: true, detail: `Install uv ${UV_VERSION} from astral.sh into this extension's folder? Nothing else on the machine changes.` },
    'Install uv',
    'How to install it myself'
  )
  if (pick === 'How to install it myself') vscode.env.openExternal(vscode.Uri.parse('https://docs.astral.sh/uv/getting-started/installation/'))
  if (pick !== 'Install uv') throw new Error('uv is needed to fit and optimize')
  const dir = join(storage, 'uv')
  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', `irm https://astral.sh/uv/${UV_VERSION}/install.ps1 | iex`]]
      : ['sh', ['-c', `curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh`]]
  const install = (installing = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing uv ${UV_VERSION}…` }, () =>
    new Promise<string>((resolve, reject) => {
      fs.mkdirSync(dir, { recursive: true })
      out.show(true)
      out.appendLine(`\n$ ${cmd} ${args.join(' ')}   (UV_UNMANAGED_INSTALL=${dir})`)
      const child = spawn(cmd, args, { env: { ...process.env, UV_UNMANAGED_INSTALL: dir } })
      child.stdout.on('data', (b: Buffer) => out.append(b.toString()))
      child.stderr.on('data', (b: Buffer) => out.append(b.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        const uv = join(dir, exe)
        if (code === 0 && fs.existsSync(uv)) resolve(uv)
        else reject(new Error(`uv's installer failed (exit ${code}, see Output). Install uv yourself: https://docs.astral.sh/uv/`))
      })
    })
  )))
  try {
    return await install
  } finally {
    installing = undefined
  }
}

/** The results panel of a model or a scenario, opened beside the editor (reveal) or only refreshed if open. */
function results(root: Root, name: string, reveal = true) {
  if (root === 'datasets') return
  const file = join(project(), root, `${name}.result.json`)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
  showResults(root, name, file, text, () => openReport(root, name), reveal)
}
/** A past fit's results, from its line in the index: its own panel, beside the latest one. */
function showRun(name: string, r: PastRun) {
  const file = join(project(), 'models', `${name}.result.json`)
  showResults('models', `${name} · ${when(r.at)}`, `${file}#${r.mlflow.run_id}`, JSON.stringify(r), () => {
    const abs = join(project(), r.mlflow.report)
    if (!fs.existsSync(abs)) return vscode.window.showErrorMessage(`Meridian's report of this run is gone from mlruns/`)
    showReport(`Report · ${name} · ${when(r.at)}`, fs.readFileSync(abs, 'utf8'), abs)
  })
}
function openReport(root: Root, name: string) {
  const abs = reportOf(root, name)
  if (!abs) return vscode.window.showErrorMessage(`${name}: Meridian's report is gone (deleted, or made on another machine)`)
  showReport(`Report · ${name}`, fs.readFileSync(abs, 'utf8'), abs)
}

// --- The link above the file ------------------------------------------------------------------
// ▶ Fit / ▶ Optimize (or ■ Stop) on the first line of a model or a scenario, its last run's state, Show results.

// --- What a file names: its dataset, its model, its CSV ------------------------------------------
// The line `dataset: x` of a model, `model: x` of a scenario, `csv: path` of a dataset: where the value sits on
// its line and the file it means. The link above that line and Cmd+click (go to definition) both use it.

export type Reference = { line: number; start: number; end: number; kind: 'dataset' | 'model' | 'csv'; value: string; file: string }
const REFERENCE_KEY: Partial<Record<Root, 'dataset' | 'model' | 'csv'>> = { models: 'dataset', scenarios: 'model', datasets: 'csv' }
function referenceIn(text: string, root: Root, dir: string): Reference | undefined {
  const kind = REFERENCE_KEY[root]
  if (!kind) return
  const lines = text.split(/\r?\n/)
  for (let line = 0; line < lines.length; line++) {
    const m = lines[line].match(new RegExp(`^(${kind}:[ \\t]*)(["']?)([^#"'\\n]*?)\\2[ \\t]*(?:#.*)?$`))
    if (!m || !m[3]) continue
    const value = m[3]
    const start = m[1].length + m[2].length
    const file = kind === 'csv' ? (isAbsolute(value) ? value : join(dir, value)) : join(dir, kind === 'dataset' ? 'datasets' : 'models', `${value}.yaml`)
    return { line, start, end: start + value.length, kind, value, file }
  }
}
/** A YAML of this project's datasets/, models/ or scenarios/: its kind and name, or nothing. */
function studioFile(uri: vscode.Uri): { root: Root; name: string; dir: string } | undefined {
  let dir: string
  try {
    dir = project()
  } catch {
    return
  }
  const root = basename(dirname(uri.fsPath)) as Root
  if (uri.scheme !== 'file' || !ROOTS.includes(root) || dirname(dirname(uri.fsPath)) !== dir || !uri.fsPath.endsWith('.yaml')) return
  return { root, name: basename(uri.fsPath, '.yaml'), dir }
}

const definitions: vscode.DefinitionProvider = {
  provideDefinition(doc, position) {
    const f = studioFile(doc.uri)
    const ref = f && referenceIn(doc.getText(), f.root, f.dir)
    if (!ref || position.line !== ref.line || position.character < ref.start || position.character > ref.end || !fs.existsSync(ref.file)) return
    return [{ originSelectionRange: new vscode.Range(ref.line, ref.start, ref.line, ref.end), targetUri: vscode.Uri.file(ref.file), targetRange: new vscode.Range(0, 0, 0, 0) }]
  }
}

class Lenses implements vscode.CodeLensProvider {
  private changed = new vscode.EventEmitter<void>()
  onDidChangeCodeLenses = this.changed.event
  refresh = () => this.changed.fire()
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const f = studioFile(doc.uri)
    if (!f || f.root === 'datasets') return []
    const { root, name, dir } = f
    const at = new vscode.Range(0, 0, 0, 0)
    const lens = (title: string, command: string, tooltip?: string) => new vscode.CodeLens(at, { title, command, tooltip, arguments: [{ root, name }] })
    const item = new Item(root, name)
    const running = item.contextValue === 'running'
    const out = [running ? lens('$(debug-stop) Stop', 'meridian.stop') : lens(`$(play) ${KINDS[root].verb}`, 'meridian.run', 'Saves the file, then runs it')]
    if (item.description) out.push(lens(String(item.description), 'meridian.output', 'Show the runner output'))
    if (fs.existsSync(join(dir, root, `${name}.result.json`))) out.push(lens('$(preview) Show results', 'meridian.results'))
    // Above the line naming its dataset or model: open it (Cmd+click on the name does the same).
    const ref = referenceIn(doc.getText(), root, dir)
    if (ref) {
      const range = new vscode.Range(ref.line, 0, ref.line, 0)
      out.push(
        fs.existsSync(ref.file)
          ? new vscode.CodeLens(range, { title: `$(go-to-file) Open ${ref.kind} ${ref.value}`, command: 'vscode.open', arguments: [vscode.Uri.file(ref.file)], tooltip: `Cmd+click ${ref.value} does the same` })
          : new vscode.CodeLens(range, { title: `$(warning) No ${ref.kind} ${ref.value} in ${ref.kind}s/`, command: '' })
      )
    }
    return out
  }
}

// --- The trees ------------------------------------------------------------------------------

const children = new Map<string, ChildProcess>() // runs this window started, by root/name

class Item extends vscode.TreeItem {
  constructor(
    public root: Root,
    public name: string
  ) {
    super(name)
    this.resourceUri = vscode.Uri.file(yamlOf(root, name))
    this.command = { command: 'vscode.open', title: 'Open', arguments: [this.resourceUri] }
    if (root === 'datasets') {
      const csv = csvOf(name)
      const ok = !!csv && fs.existsSync(csv)
      this.description = csv ? basename(csv) : 'no csv:'
      this.tooltip = ok ? csv : `${csv ?? 'csv: is missing'}: not found`
      this.iconPath = ok ? new vscode.ThemeIcon('table') : new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      this.contextValue = 'dataset'
      this.collapsibleState = ok ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      return
    }
    const r = recordOf(root, name)
    const running = r?.status === 'Running' && children.has(`${root}/${name}`)
    const cut = r?.status === 'Running' && !running
    let stale = false
    try {
      stale = r?.status === 'Done' && r.fingerprint !== fingerprintOf(root, name)
    } catch {
      stale = true
    }
    const icon = (id: string, color?: string) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined)
    if (!r) [this.description, this.iconPath] = ['', icon('circle-outline')]
    else if (running) [this.description, this.iconPath] = ['running', icon('sync~spin')]
    else if (cut) [this.description, this.iconPath] = ['interrupted', icon('warning', 'list.warningForeground')]
    else if (r.status === 'Failed') [this.description, this.iconPath] = ['failed', icon('error', 'list.errorForeground')]
    else if (stale) [this.description, this.iconPath] = ['outdated', icon('history', 'list.warningForeground')]
    else [this.description, this.iconPath] = [summaryLine(root, r), icon('check', 'testing.iconPassed')]
    this.tooltip = r?.error ?? (r?.summary && JSON.stringify(r.summary, null, 2))
    this.contextValue = running ? 'running' : reportOf(root, name) ? 'report' : 'file'
    if (root === 'models') this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed
  }
}
const fixed = (v: unknown, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v))
const num = (v: unknown, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '?')
function summaryLine(root: Root, r: RunRecord): string {
  const s = r.summary ?? {}
  if (root === 'models') return `r-hat ${num(s.r_hat_max)}, R² ${num(s.r2)}`
  const roi = s.roi as { before?: number; after?: number } | undefined
  return `ROI ${num(roi?.before)} → ${num(roi?.after)}`
}

// A dataset unfolds into its CSV's columns, each with the role its YAML gives it. Unused ones are greyed
// (through a file decoration: the only way to colour a tree label); columns named but absent come last, in red.
// Right-click (or the inline button) sets a column's role: the YAML is rewritten, the tree follows.
const UNUSED = 'meridian-column'
class Column extends vscode.TreeItem {
  constructor(
    public dataset: string,
    public column: string,
    role: string | undefined,
    icon: string,
    channel: string | undefined,
    absent = false
  ) {
    super(column)
    this.description = absent ? `${role}: not in the CSV` : role ? [role, channel].filter(Boolean).join(' · ') : ''
    this.iconPath = new vscode.ThemeIcon(absent ? 'error' : icon, absent ? new vscode.ThemeColor('list.errorForeground') : undefined)
    this.contextValue = absent ? 'column-absent' : role ? 'column' : 'column-unused'
    if (!role) this.resourceUri = vscode.Uri.from({ scheme: UNUSED, path: `/${column}` })
  }
}
function columnsOf(name: string): Column[] {
  const csv = csvOf(name)
  const header = csv ? profileOf(csv)?.header : undefined
  if (!header) return []
  const ds = readDataset(fs.readFileSync(yamlOf('datasets', name), 'utf8'))
  const roles = new Map<string, [string, string, string | undefined]>()
  for (const r of ROLES) {
    const channels = new Map((r.map ? (ds.maps[r.map] ?? []) : []).map((e) => [e.column.value, e.channel?.value]))
    for (const n of ds.roles[r.key] ?? []) if (!isPlaceholder(n.value)) roles.set(n.value, [r.label, r.icon, channels.get(n.value)])
  }
  const absent = [...roles].filter(([c]) => !header.includes(c))
  return [
    ...header.map((c) => (roles.has(c) ? new Column(name, c, ...roles.get(c)!) : new Column(name, c, undefined, 'circle-slash', undefined))),
    ...absent.map(([c, [role, icon]]) => new Column(name, c, role, icon, undefined, true))
  ]
}

// A model unfolds into its dataset's channels, each with the priors the YAML gives it (or Meridian's
// default), and the fitted ROI once there is one. Priors naming a channel the dataset lacks come last, in red.
const readYaml = (abs: string): Record<string, any> => {
  try {
    return parse(fs.readFileSync(abs, 'utf8')) ?? {}
  } catch {
    return {} // a YAML being typed
  }
}
const yes = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
class Prior extends vscode.TreeItem {
  constructor(channel: string, description: string, tooltip: string, absent = false) {
    super(channel)
    this.description = description
    this.tooltip = new vscode.MarkdownString(tooltip)
    this.iconPath = new vscode.ThemeIcon(absent ? 'error' : 'symbol-parameter', absent ? new vscode.ThemeColor('list.errorForeground') : undefined)
  }
}
// priors: PriorDistribution fields, each { dist, …arguments } once for all, or per channel with a default.
const PRIOR_ARGS = new Set(['loc', 'scale', 'mean', 'sd', 'low', 'high', 'concentration1', 'concentration0', 'concentration', 'rate', 'df'])
const PRIOR_LABEL: Record<string, string> = { roi: 'ROI', mroi: 'mROI', alpha: 'adstock', ec: 'half-saturation', slope: 'slope', contribution: 'contribution', beta: 'β', eta: 'η' }
type PriorSpec = Record<string, any>
const perItem = (spec: PriorSpec) => Object.keys(spec).some((k) => k !== 'dist' && k !== 'shift' && !PRIOR_ARGS.has(k))
/** The arguments a prior gives this item: its own, the default, or the ones for all. */
const argsFor = (spec: PriorSpec, item: string): PriorSpec | undefined =>
  perItem(spec) ? (spec[item] ?? spec.default) : Object.fromEntries(Object.entries(spec).filter(([k]) => PRIOR_ARGS.has(k)))
const describePrior = (spec: PriorSpec, args: PriorSpec) =>
  spec.dist === 'LogNormal' && yes(args.mean) && yes(args.sd)
    ? `${fixed(args.mean)} ± ${fixed(args.sd)}`
    : `${spec.dist}(${Object.values(args).map((v) => fixed(v)).join(', ')})${yes(spec.shift) ? ` + ${spec.shift}` : ''}`

function priorsOf(name: string): Prior[] {
  const m = readYaml(yamlOf('models', name))
  const ds = typeof m.dataset === 'string' && fs.existsSync(yamlOf('datasets', m.dataset)) ? readYaml(yamlOf('datasets', m.dataset)) : {}
  const media = [...new Set(Object.values(ds.media_to_channel ?? {}).map(String))]
  const rf = [...new Set(Object.values(ds.reach_to_channel ?? {}).map(String))]
  const priors: Record<string, PriorSpec> = m.priors && typeof m.priors === 'object' ? m.priors : {}
  const type = m.model_spec?.media_prior_type ?? 'roi'
  const result = readJson<{ channels?: { name: string; roi: number; roi_lo: number; roi_hi: number }[] }>(join(project(), 'models', `${name}.result.json`))
  const fitted = new Map((result?.channels ?? []).map((c) => [c.name, c]))
  const channelFields = (suffix: string) => Object.keys(priors).filter((f) => f.endsWith(suffix) && !f.endsWith(`_o${suffix.slice(1)}`))

  const row = (ch: string, suffix: '_m' | '_rf') => {
    const parts: string[] = []
    const tip = [`**${ch}**`]
    for (const field of channelFields(suffix)) {
      const spec = priors[field]
      const args = spec && typeof spec === 'object' ? argsFor(spec, ch) : undefined
      if (!args) continue
      const what = PRIOR_LABEL[field.replace(/_(m|rf)$/, '')] ?? field
      const unused = ['roi', 'mroi', 'contribution', 'beta'].includes(field.replace(/_(m|rf)$/, '')) && !field.startsWith(type === 'coefficient' ? 'beta' : type)
      parts.push(`${what} ${describePrior(spec, args)}${unused ? ' (unused)' : ''}`)
      tip.push(`\`${field}\`: ${spec.dist} ${JSON.stringify(args)}${spec[ch] ? '' : perItem(spec) ? ' (its default)' : ''}${unused ? ` — not used: media_prior_type is \`${type}\`` : ''}`)
    }
    // Meridian's default ROI prior is LogNormal(0.2, 0.9): mean e^(0.2 + 0.9²/2) = 1.83, sd 1.83·√(e^(0.9²) − 1) = 2.04.
    if (!channelFields(suffix).some((f) => f.startsWith(type === 'coefficient' ? 'beta' : type)))
      parts.unshift(type === 'roi' ? 'ROI 1.83 ± 2.04 (default)' : `${type} (default)`)
    const f = fitted.get(ch)
    if (f) {
      parts.push(`fit ${fixed(f.roi)}`)
      tip.push(`Fitted ROI: ${fixed(f.roi)}, 90% interval ${fixed(f.roi_lo)}–${fixed(f.roi_hi)}.`)
    }
    return new Prior(ch, parts.join(' · '), tip.join('\n\n'))
  }

  const items = [...media.map((ch) => row(ch, '_m')), ...rf.map((ch) => row(ch, '_rf'))]
  // Priors on the whole model or on controls: one line naming them.
  const other = Object.keys(priors).filter((f) => !/_(m|rf)$/.test(f) || /_o(m|rf)$/.test(f))
  if (other.length)
    items.push(new Prior('model-wide', other.map((f) => `${f} ${priors[f]?.dist ?? '?'}`).join(' · '), other.map((f) => `\`${f}\`: ${JSON.stringify(priors[f])}`).join('\n\n')))
  const known = new Set([...media, ...rf, 'dist', 'shift', 'default', ...PRIOR_ARGS])
  const unknown = [...new Set([...channelFields('_m'), ...channelFields('_rf')].flatMap((f) => (priors[f] && perItem(priors[f]) ? Object.keys(priors[f]) : [])))].filter((k) => !known.has(k))
  return [...items, ...unknown.map((c) => new Prior(c, 'not a channel of the dataset', `**${c}** has a prior, but ${m.dataset ?? 'the dataset'} has no such channel: the fit will refuse it.`, true))]
}

// A model's history, from <name>.runs.jsonl (one line per fit, written by the runner): newest first, the
// one in <name>.result.json marked current. A click opens that run's results.
export type PastRun = { at: string; config?: Record<string, unknown>; mlflow: { run_id: string; report: string }; fit: Record<string, number> }
function runsOf(name: string): PastRun[] {
  const file = join(project(), 'models', `${name}.runs.jsonl`)
  if (!fs.existsSync(file)) return []
  const runs: PastRun[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n'))
    try {
      if (line.trim()) runs.push(JSON.parse(line))
    } catch {
      // a line cut by a crash: the others still count
    }
  return runs.filter((r) => r?.mlflow?.run_id && r.at).reverse()
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
class Run extends vscode.TreeItem {
  constructor(name: string, r: PastRun, current: boolean) {
    super(when(r.at))
    const f = r.fit ?? {}
    this.description = [`R² ${fixed(f.r2)}`, `MAPE ${yes(f.mape) ? (f.mape * 100).toFixed(1) + '%' : '–'}`, yes(f.r_hat_max) ? `r-hat ${fixed(f.r_hat_max)}` : '', current ? 'current' : '']
      .filter(Boolean)
      .join(' · ')
    this.iconPath = new vscode.ThemeIcon(current ? 'pass-filled' : 'circle-small-filled', current ? new vscode.ThemeColor('testing.iconPassed') : undefined)
    this.tooltip = `MLflow run ${r.mlflow.run_id}`
    this.command = { command: 'meridian.showRun', title: 'Show results', arguments: [name, r] }
  }
}
class Folder extends vscode.TreeItem {
  constructor(
    public model: string,
    public kind: 'priors' | 'runs',
    count: number
  ) {
    super(kind === 'priors' ? 'Priors' : 'Runs', count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
    this.description = kind === 'runs' ? (count ? String(count) : 'none yet') : ''
    this.iconPath = new vscode.ThemeIcon(kind === 'priors' ? 'symbol-parameter' : 'history')
  }
}
function modelChildren(name: string): Folder[] {
  return [new Folder(name, 'runs', runsOf(name).length), new Folder(name, 'priors', priorsOf(name).length)]
}
function folderChildren(f: Folder): vscode.TreeItem[] {
  if (f.kind === 'priors') return priorsOf(f.model)
  const current = readJson<{ mlflow?: { run_id?: string } }>(join(project(), 'models', `${f.model}.result.json`))?.mlflow?.run_id
  return runsOf(f.model).map((r) => new Run(f.model, r, r.mlflow.run_id === current))
}

class Tree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changed = new vscode.EventEmitter<void>()
  onDidChangeTreeData = this.changed.event
  constructor(public root: Root) {}
  refresh = () => this.changed.fire()
  getTreeItem = (i: vscode.TreeItem) => i
  getChildren(i?: vscode.TreeItem): vscode.TreeItem[] {
    if (i instanceof Folder) return folderChildren(i)
    if (i instanceof Item) return i.root === 'datasets' ? columnsOf(i.name) : i.root === 'models' ? modelChildren(i.name) : []
    return this.list()
  }
  list(): Item[] {
    const dir = join(project(), this.root)
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') && !f.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => new Item(this.root, f.slice(0, -5)))
  }
}

// --- Running the runner ---------------------------------------------------------------------

const write = (root: Root, name: string, r: RunRecord) => fs.writeFileSync(join(project(), root, `${name}.run.json`), JSON.stringify(r, null, 2) + '\n')

// --- Meridian's data checks, on the lines they are about ----------------------------------------------
// A check names its variables (channels, controls); each lands where the YAML says that name: the model's
// line (its prior), else its `dataset:` line, and the dataset's line that maps it. One without names: line 1.

const wordRange = (text: string, word: string): vscode.Range | undefined => {
  const re = new RegExp(`(?<![\\w.-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`)
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i].replace(/#.*$/, ''))
    if (m) return new vscode.Range(i, m.index, i, m.index + word.length)
  }
}
function placeChecks(problems: vscode.DiagnosticCollection, root: Root, name: string, checks: Check[]) {
  const severity = { fail: vscode.DiagnosticSeverity.Error, review: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Hint }
  const file = yamlOf(root, name)
  const text = fs.readFileSync(file, 'utf8')
  const ref = referenceIn(text, root, project())
  const dataset = ref?.kind === 'dataset' && fs.existsSync(ref.file) ? { file: ref.file, text: fs.readFileSync(ref.file, 'utf8') } : undefined
  const here: vscode.Diagnostic[] = []
  const there: vscode.Diagnostic[] = []
  const diag = (range: vscode.Range, c: Check, note = '') => {
    const d = new vscode.Diagnostic(range, `${c.text}${note}`, severity[c.status] ?? severity.info)
    d.source = 'Meridian'
    d.code = c.title
    return d
  }
  for (const c of checks) {
    const vars = c.vars ?? []
    if (!vars.length) {
      here.push(diag(new vscode.Range(0, 0, 0, 1), c))
      continue
    }
    for (const v of vars) {
      const own = wordRange(text, v)
      here.push(own ? diag(own, c) : diag(ref ? new vscode.Range(ref.line, ref.start, ref.line, ref.end) : new vscode.Range(0, 0, 0, 1), c, ` (${v})`))
      const mapped = dataset && wordRange(dataset.text, v)
      if (mapped) there.push(diag(mapped, c, ` (from fitting ${name})`))
    }
  }
  problems.set(vscode.Uri.file(file), here)
  if (dataset) problems.set(vscode.Uri.file(dataset.file), there)
}

// --- Runs in progress: the view's progress bar, the status bar, the notification at the end ------------

type Live = { verb: string; name: string; started: number; phase: string }
const live = new Map<string, Live>() // by root/name, in start order
let status: vscode.StatusBarItem | undefined
let ticker: ReturnType<typeof setInterval> | undefined
const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`
}
/** The status bar item: the first run going, its phase and time; how many others. Ticks each second while any runs. */
function showLive() {
  if (!status) return
  const runs = [...live.values()]
  if (!runs.length) {
    status.hide()
    clearInterval(ticker)
    ticker = undefined
    return
  }
  const line = (r: Live) => `${r.verb} ${r.name} · ${r.phase || 'starting'} · ${elapsed(Date.now() - r.started)}`
  status.text = `$(sync~spin) ${line(runs[0])}${runs.length > 1 ? ` (+${runs.length - 1})` : ''}`
  status.tooltip = `${runs.map(line).join('\n')}\n\nClick for the runner's output`
  status.show()
  ticker ??= setInterval(showLive, 1000)
}

/** Where a run started as a task writes, and how it tells the task it ended. */
type Term = { write: (line: string) => void; end: (ok: boolean) => void }

async function run(runner: string, out: vscode.OutputChannel, problems: vscode.DiagnosticCollection, root: Root, name: string, refresh: () => void, term?: Term) {
  const kind = KINDS[root]
  const key = `${root}/${name}`
  if (children.has(key)) throw new Error(`${name} is already running`)
  if (kind.parent) {
    const p = parentOf(root, name)
    if (!p || !fs.existsSync(yamlOf(kind.parent, p))) throw new Error(`${name} names no ${KINDS[kind.parent].one} of this project (${kind.key}: …)`)
    if (kind.parent === 'datasets') {
      const csv = csvOf(p)
      if (!csv || !fs.existsSync(csv)) throw new Error(`${p}: its csv is missing (${csv ?? 'no csv:'})`)
    } else if (recordOf(kind.parent, p)?.status !== 'Done') throw new Error(`${KINDS[kind.parent].verb} ${p} first`)
  }
  const say = (line: string) => {
    out.appendLine(line)
    term?.write(line)
  }
  const uv = await ensureUv(out)
  const dir = project()
  const uri = vscode.Uri.file(yamlOf(root, name))
  await vscode.workspace.saveAll(false)
  const record: RunRecord = { status: 'Running', startedAt: new Date().toISOString(), fingerprint: fingerprintOf(root, name) }
  write(root, name, record)
  problems.delete(uri)
  const ref = referenceIn(fs.readFileSync(uri.fsPath, 'utf8'), root, dir)
  if (ref?.kind === 'dataset') problems.delete(vscode.Uri.file(ref.file))

  const mlflow = vscode.workspace.getConfiguration('meridian').get<string>('mlflowTrackingUri')?.trim()
  const env = { ...process.env, PYTHONUNBUFFERED: '1', ...(mlflow && { MLFLOW_TRACKING_URI: mlflow }) }
  const args = ['run', '--project', runner, join(runner, 'runner.py'), kind.command!, dir, `${root}/${name}.yaml`]
  if (!term) out.show(true)
  say(`\n$ uv ${args.join(' ')}`)
  const child = spawn(uv, args, { cwd: dir, env })
  children.set(key, child)
  const started = Date.now()
  const going: Live = { verb: kind.verb, name, started, phase: '' }
  live.set(key, going)
  let stopProgress = () => {}
  const progress = new Promise<void>((resolve) => (stopProgress = resolve))
  vscode.window.withProgress({ location: { viewId: `meridian.${root}` } }, () => progress) // the bar atop the view
  showLive()
  refresh()

  let last: { event: string; summary?: Record<string, unknown>; message?: string } | undefined
  const checks: Check[] = []
  const lines = (stream: NodeJS.ReadableStream, each: (line: string) => void) => {
    let rest = ''
    stream.on('data', (b: Buffer) => {
      const parts = (rest + b.toString('utf8')).split('\n')
      rest = parts.pop() ?? ''
      parts.forEach(each)
    })
    stream.on('end', () => rest && each(rest))
  }
  lines(child.stdout!, (line) => {
    let e: Record<string, unknown>
    try {
      e = JSON.parse(line)
    } catch {
      return say(line)
    }
    if (e.event === 'checks' && Array.isArray(e.items)) {
      checks.push(...(e.items as Check[]))
      placeChecks(problems, root, name, checks)
    }
    if (e.event === 'done' || e.event === 'error') last = e as typeof last
    if (e.event === 'phase' && e.state === 'run') {
      going.phase = String(e.name)
      showLive()
    }
    say(describe(e))
  })
  lines(child.stderr!, (l) => say(l))

  let finished = false // 'error' and 'close' can both fire
  const finish = (error?: string) => {
    if (finished) return
    finished = true
    children.delete(key)
    live.delete(key)
    stopProgress()
    showLive()
    if (error) say(`Error: ${error}`)
    const ok = !error && last?.event === 'done'
    const ended: RunRecord = {
      ...record,
      status: ok ? 'Done' : 'Failed',
      finishedAt: new Date().toISOString(),
      ...(ok ? { summary: last!.summary } : { error: error ?? last?.message ?? 'The runner stopped without saying why (see Output)' }),
      ...(checks.length && { checks })
    }
    write(root, name, ended)
    term?.end(ok)
    refresh()
    results(root, name, false) // a panel already open shows the new results
    // Told when it ends, whatever is in front: a fit can take ten minutes.
    const took = elapsed(Date.now() - started)
    if (ok)
      vscode.window.showInformationMessage(`${kind.verb} ${name} done in ${took}: ${summaryLine(root, ended)}`, 'Show results').then((pick) => pick && results(root, name))
    else if (child.killed) vscode.window.showInformationMessage(`${kind.verb} ${name} stopped after ${took}`)
    else
      vscode.window.showErrorMessage(`${kind.verb} ${name} failed after ${took}: ${error ?? last?.message ?? 'see the output'}`, 'Show output').then((pick) => pick && out.show())
  }
  child.on('error', (e) => finish(e.message))
  child.on('close', (code) => finish(code === 0 || last?.event === 'error' ? undefined : child.killed ? 'Stopped' : `The runner exited with code ${code}`))
}

// One readable line per runner event, for the Output panel.
function describe(e: Record<string, unknown>): string {
  if (e.event === 'step') return `${e.kind} ${e.name}: ${e.state === 'run' ? 'running' : e.reused ? 'reused' : `${e.rows} rows in ${e.ms} ms`}`
  if (e.event === 'phase') return `${e.name}: ${e.state === 'run' ? 'running' : 'done'}`
  if (e.event === 'checks') return (e.items as Check[]).map((c) => `  ${c.status}: ${c.title}${c.text ? ` (${c.text})` : ''}`).join('\n')
  if (e.event === 'done') return `Done ${JSON.stringify(e.summary)}`
  if (e.event === 'error') return `Error: ${e.message}`
  return String(e.line ?? JSON.stringify(e))
}

// --- New files, from the runner's templates ---------------------------------------------------

async function create(templates: string, root: Root): Promise<void> {
  const kind = KINDS[root]
  const values: Record<string, string> = {}
  let profile: ReturnType<typeof profileOf>
  if (kind.parent) {
    const parents = new Tree(kind.parent).list().map((i) => i.name)
    if (!parents.length) throw new Error(`Create a ${KINDS[kind.parent].one} first`)
    const p = await vscode.window.showQuickPick(parents, { placeHolder: `The ${KINDS[kind.parent].one} this ${kind.one} uses` })
    if (!p) return
    values[kind.key!] = p
    // ponytail: the channel names are not parsed out of the dataset's YAML; add the yaml package to prefill them.
    if (root === 'models') values.roi = '#     <channel>: { mean: 1.0, sd: 0.5 }'
  } else {
    const [csv] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(project()), title: 'The CSV this dataset reads' })) ?? []
    if (!csv) return
    const rel = relative(project(), csv.fsPath)
    // Inside the project: relative, so the project moves with its data. Elsewhere: absolute, as picked.
    values.csv = rel.startsWith('..') || isAbsolute(rel) ? csv.fsPath : rel.split('\\').join('/')
    profile = profileOf(csv.fsPath)
    const header = profile?.header ?? []
    values.columns = header.join(', ')
    // The time column: the one holding dates, else the one named like it.
    values.time = header.find((c) => profile?.columns.get(c)?.type === 'dates') ?? header.find((c) => /date|time|week|period/i.test(c)) ?? header[0] ?? 'time'
  }
  const name = await vscode.window.showInputBox({
    prompt: `Name of the ${kind.one} (its file name in ${root}/)`,
    validateInput: (v) => (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v) ? 'Letters, digits, - _ .' : fs.existsSync(yamlOf(root, v)) ? `${v} already exists` : undefined)
  })
  if (!name) return
  values.name = name
  let text = fs.readFileSync(join(templates, `${kind.one}.yaml`), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? '')
  // A new dataset starts filled from its CSV, as far as the CSV's content and names allow; the rest is left blank.
  const filled = profile && complete(text, profile)
  if (filled) text = filled.text
  fs.mkdirSync(join(project(), root), { recursive: true })
  fs.writeFileSync(yamlOf(root, name), text)
  await vscode.window.showTextDocument(vscode.Uri.file(yamlOf(root, name)))
  if (filled && profile) vscode.window.showInformationMessage(summarize(filled, profile.file))
}

// --- Rename and delete ------------------------------------------------------------------------
// A file goes with what its runs left next to it. A rename also rewrites the files naming it
// (the models of a dataset, the scenarios of a model); a delete leaves them, named in the warning.

const followers = (root: Root, name: string) =>
  ['.yaml', '.run.json', '.result.json', ...(root === 'models' ? ['.runs.jsonl'] : []), ...(root === 'scenarios' ? ['.html'] : [])].map((ext) => join(project(), root, name + ext))
const childOf = (root: Root) => ROOTS.find((r) => KINDS[r].parent === root)
/** The files naming this one as their dataset or model. */
const usersOf = (root: Root, name: string): string[] => {
  const child = childOf(root)
  return child ? new Tree(child).list().filter((i) => parentOf(child, i.name) === name).map((i) => i.name) : []
}
const setKey = (abs: string, key: string, value: string) => {
  const text = fs.readFileSync(abs, 'utf8')
  const re = new RegExp(`^${key}:([ \\t]*)[^#\\n]*?([ \\t]*(?:#.*)?)$`, 'm')
  if (re.test(text)) fs.writeFileSync(abs, text.replace(re, `${key}: ${value}$2`))
}

async function rename(i: Item) {
  if (children.has(`${i.root}/${i.name}`)) throw new Error('Wait for the run to end, or stop it, before renaming')
  const to = await vscode.window.showInputBox({
    prompt: `Rename ${i.name}`,
    value: i.name,
    validateInput: (v) => (v === i.name ? undefined : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v) ? 'Letters, digits, - _ .' : fs.existsSync(yamlOf(i.root, v)) ? `${v} already exists` : undefined)
  })
  if (!to || to === i.name) return
  await vscode.workspace.saveAll(false)
  const olds = followers(i.root, i.name)
  const news = followers(i.root, to)
  olds.forEach((o, n) => fs.existsSync(o) && fs.renameSync(o, news[n]))
  setKey(news[0], 'name', to)
  if (i.root === 'scenarios' && fs.existsSync(news[2])) {
    const r = JSON.parse(fs.readFileSync(news[2], 'utf8'))
    if (r.report) fs.writeFileSync(news[2], JSON.stringify({ ...r, report: `scenarios/${to}.html` }, null, 2) + '\n')
  }
  const child = childOf(i.root)
  const users = usersOf(i.root, i.name)
  if (child) for (const u of users) setKey(yamlOf(child, u), KINDS[child].key!, to)
  // An editor open on the old YAML would write it back on save: show the new one instead.
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs))
    if (tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === olds[0]) {
      await vscode.window.tabGroups.close(tab)
      await vscode.window.showTextDocument(vscode.Uri.file(news[0]), { preview: false })
    }
  if (users.length) vscode.window.showInformationMessage(`Renamed ${i.name} to ${to}, and in ${users.join(', ')}`)
}

async function remove(i: Item) {
  if (children.has(`${i.root}/${i.name}`)) throw new Error('Wait for the run to end, or stop it, before deleting')
  const users = usersOf(i.root, i.name)
  const what = i.root === 'datasets' ? 'Its CSV stays where it is.' : i.root === 'models' ? 'Its MLflow runs stay in mlruns/.' : ''
  const pick = await vscode.window.showWarningMessage(
    `Delete ${i.name}?`,
    { modal: true, detail: [`Its YAML and run records go to the Trash. ${what}`, users.length ? `${users.join(', ')} will name a ${KINDS[i.root].one} that no longer exists.` : ''].filter(Boolean).join('\n') },
    'Move to Trash'
  )
  if (pick !== 'Move to Trash') return
  for (const f of followers(i.root, i.name)) if (fs.existsSync(f)) await vscode.workspace.fs.delete(vscode.Uri.file(f), { useTrash: true })
}

// --- Fits and optimizations as VS Code tasks ---------------------------------------------------------------
// type: meridian, file: models/<name>.yaml or scenarios/<name>.yaml. A task runs exactly what Play runs, in the
// integrated terminal: Terminate stops the runner, Restart reruns it, dependsOn chains a fit and its scenarios.

function makeTasks(start: (root: Root, name: string, term: Term) => Promise<void>) {
  const task = (file: string, scope: vscode.WorkspaceFolder | vscode.TaskScope = vscode.TaskScope.Workspace, def?: vscode.TaskDefinition) => {
    const m = file.match(/^(models|scenarios)\/([^/\\]+)\.yaml$/)
    if (!m) return
    const [root, name] = [m[1] as Root, m[2]]
    const t = new vscode.Task(def ?? { type: 'meridian', file }, scope, `${KINDS[root].verb} ${name}`, 'meridian',
      new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
        const write = new vscode.EventEmitter<string>()
        const close = new vscode.EventEmitter<number>()
        return {
          onDidWrite: write.event,
          onDidClose: close.event,
          open: () =>
            void start(root, name, { write: (l) => write.fire(l.replace(/\r?\n/g, '\r\n') + '\r\n'), end: (ok) => close.fire(ok ? 0 : 1) }).catch((e) => {
              write.fire(`${e instanceof Error ? e.message : e}\r\n`)
              close.fire(1)
            }),
          close: () => children.get(`${root}/${name}`)?.kill()
        }
      }),
      [] // no problem matcher: Meridian's checks reach Problems directly, and VS Code would ask for one otherwise
    )
    t.detail = file
    return t
  }
  return {
    provideTasks: () =>
      (['models', 'scenarios'] as Root[]).flatMap((root) => new Tree(root).list().map((i) => task(`${root}/${i.name}.yaml`)!)),
    resolveTask: (t: vscode.Task) => (typeof t.definition.file === 'string' ? task(t.definition.file, t.scope as vscode.WorkspaceFolder, t.definition) : undefined)
  } satisfies vscode.TaskProvider
}

// --- Wiring ---------------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const runner = join(context.extensionPath, 'runner')
  storage = context.globalStorageUri.fsPath
  const out = vscode.window.createOutputChannel('Meridian Studio')
  const problems = vscode.languages.createDiagnosticCollection('meridian')
  const trees = Object.fromEntries(ROOTS.map((r) => [r, new Tree(r)])) as Record<Root, Tree>
  status = vscode.window.createStatusBarItem('meridian.run', vscode.StatusBarAlignment.Left, 50)
  status.name = 'Meridian run'
  status.command = 'meridian.output'
  context.subscriptions.push(status, { dispose: () => clearInterval(ticker) })
  const lenses = new Lenses()
  const current = (model: string) => readJson<{ mlflow?: { run_id?: string } }>(join(project(), 'models', `${model}.result.json`))?.mlflow?.run_id
  const runsView = new RunsView(
    () =>
      new Tree('models')
        .list()
        .flatMap((i) => runsOf(i.name).map((r): RunRow => ({ ...(r as unknown as RunRow), model: i.name, current: r.mlflow.run_id === current(i.name) })))
        .sort((a, b) => b.at.localeCompare(a.at)),
    (row) => showRun(row.model, row as unknown as PastRun)
  )
  const refresh = () => {
    runsView.update()
    ROOTS.forEach((r) => trees[r].refresh())
    lenses.refresh()
    for (const file of openPanels().filter((f) => !f.includes('#'))) results(basename(dirname(file)) as Root, basename(file, '.result.json'), false)
  }
  const guarded = (f: (...a: any[]) => unknown) => async (...a: any[]) => {
    try {
      await f(...a)
    } catch (e) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
    }
  }
  const isDataset = (uri: vscode.Uri) => studioFile(uri)?.root === 'datasets'
  const assist = registerAssist(context, { project, isDataset })
  const data = registerDataChecks(context, {
    project,
    runner,
    findUv,
    ensureUv: () => ensureUv(out),
    out,
    datasets: () => new Tree('datasets').list().map((i) => i.name),
    isDataset
  })
  const watcher = vscode.workspace.createFileSystemWatcher('**/{datasets,models,scenarios}/*.{yaml,json,jsonl}')
  // A CSV edited or replaced: the datasets' columns, their checks and their lenses follow.
  const csvs = vscode.workspace.createFileSystemWatcher('**/*.csv')
  const csvChanged = () => {
    trees.datasets.refresh()
    assist.recheck()
    data.all()
  }
  /** The dataset a command acts on: a tree item, a URI (the lens), or the active editor (the palette). */
  const datasetUri = (a?: Item | vscode.Uri) =>
    a instanceof vscode.Uri ? a : a instanceof Item ? vscode.Uri.file(yamlOf('datasets', a.name)) : vscode.window.activeTextEditor?.document.uri
  context.subscriptions.push(
    out,
    problems,
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidChange(refresh),
    watcher.onDidDelete(refresh),
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) => (uri.scheme === UNUSED ? { color: new vscode.ThemeColor('disabledForeground'), tooltip: 'Not used by the model' } : undefined)
    }),
    csvs,
    csvs.onDidCreate(csvChanged),
    csvs.onDidChange(csvChanged),
    csvs.onDidDelete(csvChanged),
    // Datasets: several columns can be picked at once, to give them one role.
    vscode.window.createTreeView('meridian.datasets', { treeDataProvider: trees.datasets, canSelectMany: true }),
    ...ROOTS.filter((r) => r !== 'datasets').map((r) => vscode.window.registerTreeDataProvider(`meridian.${r}`, trees[r])),
    vscode.commands.registerCommand('meridian.complete', guarded(async (a?: Item | vscode.Uri) => {
      const uri = datasetUri(a)
      if (!uri || !isDataset(uri)) throw new Error('Open a dataset (datasets/<name>.yaml) first')
      await completeDataset({ project, isDataset }, uri)
    })),
    vscode.commands.registerCommand('meridian.checkData', guarded(async (a?: Item | vscode.Uri) => {
      const uri = datasetUri(a)
      if (!uri || !isDataset(uri)) throw new Error('Open a dataset (datasets/<name>.yaml) first')
      await vscode.workspace.saveAll(false)
      await data.check(basename(uri.fsPath, '.yaml'))
    })),
    vscode.commands.registerCommand('meridian.setRole', guarded(async (c: Column, picked?: Column[]) => {
      // the columns picked together when the one clicked is among them, of its dataset; else the one clicked
      const columns = (picked?.includes(c) ? picked : [c]).filter((p) => p instanceof Column && p.dataset === c.dataset).map((p) => p.column)
      await setRole({ project, isDataset }, vscode.Uri.file(yamlOf('datasets', c.dataset)), columns)
    })),
    vscode.commands.registerCommand('meridian.refresh', refresh),
    vscode.commands.registerCommand('meridian.run', guarded((i: Item) => run(runner, out, problems, i.root, i.name, refresh))),
    vscode.window.registerWebviewViewProvider('meridian.runs', runsView),
    vscode.tasks.registerTaskProvider('meridian', makeTasks((root, name, term) => run(runner, out, problems, root, name, refresh, term))),
    vscode.commands.registerCommand('meridian.stop', (i: Item) => children.get(`${i.root}/${i.name}`)?.kill()),
    vscode.commands.registerCommand('meridian.rename', guarded(rename)),
    vscode.commands.registerCommand('meridian.delete', guarded(remove)),
    vscode.commands.registerCommand('meridian.report', guarded((i: Item) => openReport(i.root, i.name))),
    vscode.commands.registerCommand('meridian.results', guarded((i: Item) => results(i.root, i.name))),
    vscode.commands.registerCommand('meridian.showRun', guarded(showRun)),
    vscode.commands.registerCommand('meridian.output', () => out.show(true)),
    vscode.languages.registerCodeLensProvider({ language: 'yaml', scheme: 'file' }, lenses),
    vscode.languages.registerDefinitionProvider({ language: 'yaml', scheme: 'file' }, definitions),
    vscode.commands.registerCommand('meridian.newDataset', guarded(() => create(join(runner, 'templates'), 'datasets'))),
    vscode.commands.registerCommand('meridian.newModel', guarded(() => create(join(runner, 'templates'), 'models'))),
    vscode.commands.registerCommand('meridian.newScenario', guarded(() => create(join(runner, 'templates'), 'scenarios'))),
    { dispose: () => children.forEach((c) => c.kill()) } // a record left at Running reads as interrupted next time
  )
}

export function deactivate() {}
export const _setStorage = (dir: string) => (storage = dir)
export * as _dataset from './dataset' // for scripts/check-columns.js, like the ones below
export * as _csv from './csv'
export { wordRange as _wordRange, referenceIn as _referenceIn, fingerprintOf as _fingerprintOf, withoutChecks as _withoutChecks, ensureUv as _ensureUv, columnsOf as _columnsOf, priorsOf as _priorsOf, modelChildren as _modelChildren, folderChildren as _folderChildren } // for scripts/check-columns.js
