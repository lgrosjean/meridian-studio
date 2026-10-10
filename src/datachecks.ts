// A dataset's data checks (runner/checks.py: T001 weeks missing, M002 a channel rarely active…), each on the line
// naming its column, in Problems, and counted in a lens above the file. They run by themselves, quietly, when a
// dataset or a CSV is saved and when the window opens, once Meridian's environment is installed; "Check data" runs
// them on request, and installs that environment the first time.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { mention } from './dataset'

type Item = { status: 'fail' | 'review' | 'info'; code?: string; text: string; vars?: string[] }
type State = { running?: boolean; errors?: number; warnings?: number; failed?: string }
type Env = {
  project: () => string
  runner: string
  findUv: () => string | undefined
  ensureUv: () => Promise<string>
  out: vscode.OutputChannel
  datasets: () => string[]
  isDataset: (uri: vscode.Uri) => boolean
}

export type RunnerEvent = Record<string, any>
/** The runner run quietly (no record, no notification): its events, and what it said on stderr. */
export function runQuietly(uv: string, runner: string, project: string, args: string[], started?: (child: ChildProcess) => void) {
  return new Promise<{ events: RunnerEvent[]; err: string; code: number | null; child: ChildProcess }>((resolve) => {
    const child = spawn(uv, ['run', '--project', runner, join(runner, 'runner.py'), ...args], { cwd: project, env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    started?.(child)
    let out = ''
    let err = ''
    child.stdout!.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr!.on('data', (b: Buffer) => (err += b.toString()))
    child.on('error', (e) => (err += e.message))
    child.on('close', (code) => {
      const events = out.split('\n').flatMap((l) => {
        try {
          return [JSON.parse(l)]
        } catch {
          return []
        }
      })
      resolve({ events, err, code, child })
    })
  })
}

/** Line and character of an offset, for a file no editor has open. */
const positionIn = (text: string, offset: number) => {
  const before = text.slice(0, offset)
  const line = before.split('\n').length - 1
  return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1))
}

export function registerDataChecks(context: vscode.ExtensionContext, env: Env) {
  const diagnostics = vscode.languages.createDiagnosticCollection('meridian-data')
  const states = new Map<string, State>()
  const children = new Map<string, ChildProcess>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const changed = new vscode.EventEmitter<void>()
  const uriOf = (name: string) => vscode.Uri.file(join(env.project(), 'datasets', `${name}.yaml`))
  const nameOf = (uri: vscode.Uri) => (env.isDataset(uri) ? uri.fsPath.replace(/^.*[\\/]/, '').replace(/\.yaml$/, '') : undefined)
  /** Whether checks can run without asking: uv there, and Meridian's environment installed (by a fit, or a first check). */
  const ready = () => !!env.findUv() && fs.existsSync(join(env.runner, '.venv'))
  const severity = { fail: vscode.DiagnosticSeverity.Error, review: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information }

  /** Each finding on the line naming its column (the YAML as open in an editor, else as saved). */
  const place = (name: string, items: Item[]) => {
    const uri = uriOf(name)
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath)
    const text = doc?.getText() ?? fs.readFileSync(uri.fsPath, 'utf8')
    const at = (offset: number) => (doc ? doc.positionAt(offset) : positionIn(text, offset))
    diagnostics.set(
      uri,
      items.map((i) => {
        const m = mention(text, i.vars?.[0])
        const d = new vscode.Diagnostic(new vscode.Range(at(m.start), at(m.end)), i.text, severity[i.status] ?? severity.info)
        d.source = 'Meridian Studio'
        d.code = i.code
        return d
      })
    )
  }

  /** Runs one dataset's checks; quietly, or on request (which may install the environment, and says how it went). */
  async function check(name: string, asked = false) {
    if (!asked && !ready()) return
    const firstTime = !ready()
    const uv = asked ? await env.ensureUv() : env.findUv()!
    children.get(name)?.kill() // a newer run supersedes an older one
    states.set(name, { ...states.get(name), running: true })
    changed.fire()
    const done = runQuietly(uv, env.runner, env.project(), ['check', env.project(), `datasets/${name}.yaml`], (child) => children.set(name, child)).then(({ events, err, code, child }) => {
      if (children.get(name) !== child) return states.get(name) ?? {} // superseded by a newer run
      children.delete(name)
      const items: Item[] | undefined = events.find((e) => e.event === 'checks')?.items
      const message: string | undefined = events.find((e) => e.event === 'error')?.message
      let state: State
      if (items) {
        place(name, items)
        state = { errors: items.filter((i) => i.status === 'fail').length, warnings: items.filter((i) => i.status === 'review').length }
      } else {
        diagnostics.delete(uriOf(name))
        state = { failed: message ?? `the runner stopped (exit ${code}), see Output` }
        if (!message) env.out.appendLine(`Check ${name}:\n${err}`)
      }
      states.set(name, state)
      changed.fire()
      return state
    })
    if (!asked) return void (await done)
    const title = `Checking the data of ${name}${firstTime ? ' (the first time installs Meridian: a few minutes)' : ''}…`
    const s = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => done)
    if (s.failed) vscode.window.showErrorMessage(`Data checks of ${name}: ${s.failed}`)
    else if (!s.errors && !s.warnings) vscode.window.showInformationMessage(`${name}: the data checks find nothing`)
  }
  /** Soon, once: saves come in bursts. */
  const later = (name: string) => {
    clearTimeout(timers.get(name))
    timers.set(name, setTimeout(() => void check(name), 300))
  }
  const all = () => {
    try {
      env.datasets().forEach(later)
    } catch {
      // no folder open: nothing to check
    }
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(doc) {
      const name = nameOf(doc.uri)
      if (!name) return []
      const s = states.get(name)
      const lens = (title: string, tooltip: string) => new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title, tooltip, command: 'meridian.checkData', arguments: [doc.uri] })
      if (s?.running) return [lens('$(sync~spin) Checking the data…', 'runner/checks.py on the CSV')]
      if (s?.failed) return [lens('$(warning) Data checks failed', `${s.failed}. Click to run them again`)]
      if (!s) return [lens('$(checklist) Check the data', ready() ? 'Runs the data checks' : "Runs the data checks; the first time installs Meridian's environment (a few minutes, about 1 GB, once)")]
      const n = (s.errors ?? 0) + (s.warnings ?? 0)
      const title = n ? `$(${s.errors ? 'error' : 'warning'}) Data: ${[s.errors ? `${s.errors} error${s.errors > 1 ? 's' : ''}` : '', s.warnings ? `${s.warnings} warning${s.warnings > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')}` : '$(pass) Data checks pass'
      return [lens(title, 'In Problems, on the lines naming the columns. Click to run the checks again')]
    }
  }

  const datasets = vscode.workspace.createFileSystemWatcher('**/datasets/*.yaml', false, true, false) // created (or renamed to), deleted
  context.subscriptions.push(
    diagnostics,
    changed,
    datasets,
    { dispose: () => (timers.forEach(clearTimeout), children.forEach((c) => c.kill())) },
    vscode.languages.registerCodeLensProvider({ language: 'yaml', scheme: 'file', pattern: '**/datasets/*.yaml' }, lenses),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const name = nameOf(doc.uri)
      if (name) later(name)
    }),
    datasets.onDidCreate((uri) => {
      const name = nameOf(uri)
      if (name) later(name)
    }),
    datasets.onDidDelete((uri) => {
      diagnostics.delete(uri)
      states.delete(uri.fsPath.replace(/^.*[\\/]/, '').replace(/\.yaml$/, ''))
    })
  )
  all()
  return {
    /** "Check data": a dataset's checks, on request. */
    check: (name: string) => check(name, true),
    /** Before a fit: the dataset's errors as the checks find them now (none when the checks cannot run yet). */
    errors: async (name: string): Promise<string[]> => {
      if (!ready()) return []
      await check(name)
      const uri = uriOf(name)
      return diagnostics.get(uri)?.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).map((d) => `${d.code}: ${d.message}`) ?? []
    },
    /** A CSV changed: every dataset's checks again (each reads its own CSV). */
    all
  }
}
