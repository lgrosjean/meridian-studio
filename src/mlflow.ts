// MLflow from the editor: the settings the runner reads, and MLflow's UI opened on the project's experiment or on one
// run. A tracking server is opened where it is; a store on this machine (the project's mlflow.db by default) gets a
// local `mlflow server` from the runner's environment, started on first use and stopped with the extension.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import * as vscode from 'vscode'

/** MLflow's settings as the runner reads them: the store of runs, and where a new experiment keeps their files. */
export function mlflowEnv(): Record<string, string> {
  const c = vscode.workspace.getConfiguration('meridian')
  const tracking = c.get<string>('mlflowTrackingUri')?.trim()
  const artifacts = c.get<string>('mlflowArtifactLocation')?.trim()
  return { ...(tracking && { MLFLOW_TRACKING_URI: tracking }), ...(artifacts && { MERIDIAN_MLFLOW_ARTIFACT_LOCATION: artifacts }) }
}

/** What a page of MLflow's UI is about: a run (by its experiment when known), else the experiment, else the list. */
export type Page = { experiment?: string; run?: string }
const hash = ({ experiment, run }: Page) =>
  run ? (experiment ? `#/experiments/${experiment}/runs/${run}` : `#/runs/${run}`) : experiment ? `#/experiments/${experiment}` : '#/'

type Ctx = { project: () => string; runner: string; uv: () => Promise<string>; out: vscode.OutputChannel }
let local: { store: string; child: ChildProcess; url: Promise<string> } | undefined

export async function openMlflow(ctx: Ctx, page: Page) {
  const uri = mlflowEnv().MLFLOW_TRACKING_URI ?? process.env.MLFLOW_TRACKING_URI ?? ''
  let base: string
  if (/^https?:\/\//i.test(uri)) base = uri.replace(/\/+$/, '')
  else if (/^databricks/i.test(uri)) throw new Error('Open MLflow from your Databricks workspace: its experiments hold these runs')
  else {
    const store = uri || `sqlite:///${join(ctx.project(), 'mlflow.db')}`
    if (!uri && !fs.existsSync(join(ctx.project(), 'mlflow.db'))) throw new Error('Nothing in MLflow yet: fit a model first')
    const url = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting MLflow…' }, () => server(ctx, store))
    base = (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true).replace(/\/+$/, '') // forwarded when the editor is remote
  }
  // A string, not a Uri: a Uri would encode the slashes of the fragment, which MLflow's UI routes on.
  return vscode.env.openExternal(`${base}/${hash(page)}` as unknown as vscode.Uri)
}

/** The local server on this store, started once: its URL when it answers. */
async function server(ctx: Ctx, store: string): Promise<string> {
  if (local?.store === store && local.child.exitCode === null) return local.url
  stopMlflow()
  const [uv, port] = await Promise.all([ctx.uv(), freePort()])
  const args = ['run', '--project', ctx.runner, 'mlflow', 'server', '--backend-store-uri', store, '--no-serve-artifacts']
  args.push('--host', '127.0.0.1', '--port', String(port), '--workers', '1', '--uvicorn-opts', '--log-level warning')
  ctx.out.appendLine(`\n$ uv ${args.join(' ')}`)
  // Its own process group: uvicorn runs under mlflow under uv, and all of them stop together.
  const child = spawn(uv, args, { cwd: ctx.project(), detached: process.platform !== 'win32', env: { ...process.env, MLFLOW_DISABLE_AGENT_HINT: '1' } })
  child.stdout?.on('data', (b: Buffer) => ctx.out.append(b.toString()))
  child.stderr?.on('data', (b: Buffer) => ctx.out.append(b.toString()))
  const url = up(`http://127.0.0.1:${port}`, child)
  local = { store, child, url }
  url.catch(() => (local = undefined))
  return url
}

async function up(url: string, child: ChildProcess, seconds = 90): Promise<string> {
  let exited: number | null = null
  child.on('exit', (code) => (exited = code ?? -1))
  child.on('error', () => (exited = -1))
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    if (exited !== null) throw new Error(`MLflow's server stopped (exit ${exited}): see the Meridian Studio output`)
    try {
      if ((await fetch(`${url}/health`)).ok) return url
    } catch {
      // not listening yet
    }
  }
  stopMlflow()
  throw new Error(`MLflow's server did not answer in ${seconds} s: see the Meridian Studio output`)
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer().once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })

export function stopMlflow() {
  const c = local?.child
  local = undefined
  if (!c?.pid || c.exitCode !== null) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'])
    else process.kill(-c.pid, 'SIGTERM')
  } catch {
    c.kill()
  }
}
