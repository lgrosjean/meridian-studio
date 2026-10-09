// The "Meridian Runs" tab of the bottom panel: every fit of every model, from their <model>.runs.jsonl, newest first.
// Click a row to see its results; tick two to compare them: metrics, ROI by channel, what their configs change.
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'

export type RunRow = {
  model: string
  current: boolean
  at: string
  config?: Record<string, unknown>
  mlflow: { run_id: string }
  fit: Record<string, number | null>
  channels?: { name: string; roi: number; roi_lo: number; roi_hi: number }[]
}

const SCRIPT = String.raw`
const vs = acquireVsCodeApi()
let rows = [], model = '', picked = (vs.getState() || {}).picked || []
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';')
const num = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '–')
const pct = (v) => (typeof v === 'number' && isFinite(v) ? (v * 100).toFixed(1) + '%' : '–')
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const id = (r) => r.mlflow.run_id
const secs = (v) => (typeof v === 'number' ? (Math.abs(v) < 60 ? v + ' s' : Math.round(v / 60) + ' min') : '–')
const signed = (f) => (d) => (d > 0 ? '+' : '') + f(d)
// key, label, how a value reads, which way is better (1 up, -1 down, 0 neither), how a change reads
const METRICS = [
  ['r2', 'R²', num, 1, signed(num)],
  ['mape', 'MAPE', pct, -1, signed((d) => (d * 100).toFixed(1) + ' pt')],
  ['wmape', 'wMAPE', pct, -1, signed((d) => (d * 100).toFixed(1) + ' pt')],
  ['r_hat_max', 'max r-hat', (v) => num(v, 3), -1, signed((d) => num(d, 3))],
  ['divergences', 'divergences', (v) => num(v, 0), -1, signed((d) => num(d, 0))],
  ['seconds', 'time', secs, 0, signed(secs)]
]
const flat = (o, p = '') => Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, p + k + '.') : [[p + k, JSON.stringify(v)]]))
function render() {
  const models = [...new Set(rows.map((r) => r.model))]
  $('#model').innerHTML = '<option value="">all models (' + rows.length + ' runs)</option>' + models.map((m) => '<option' + (m === model ? ' selected' : '') + '>' + esc(m) + '</option>').join('')
  const shown = rows.filter((r) => !model || r.model === model)
  $('#rows').innerHTML = shown.map((r) => '<tr data-id="' + esc(id(r)) + '" class="' + (picked.includes(id(r)) ? 'picked' : '') + '">'
    + '<td><input type="checkbox" ' + (picked.includes(id(r)) ? 'checked' : '') + ' title="Compare"></td>'
    + '<td>' + esc(r.model) + (r.current ? ' <span class="tag">current</span>' : '') + '</td><td class="dim">' + esc(when(r.at)) + '</td>'
    + METRICS.map(([k, , f]) => '<td class="n">' + f(r.fit[k]) + '</td>').join('') + '</tr>').join('')
    || '<tr><td colspan="9" class="dim">No runs yet: fit a model.</td></tr>'
  compare()
}
function compare() {
  // older first: a change always reads from the earlier run to the later one, whatever order they were ticked in
  const [a, b] = picked.map((p) => rows.find((r) => id(r) === p)).filter(Boolean).sort((x, y) => x.at.localeCompare(y.at))
  if (!a || !b) { $('#compare').innerHTML = '<p class="dim">Tick two runs to compare them.</p>'; return }
  const head = '<tr><th></th><th class="n">' + esc(a.model) + '<div class="dim">' + esc(when(a.at)) + '</div></th><th class="n">' + esc(b.model) + '<div class="dim">' + esc(when(b.at)) + '</div></th><th class="n">change</th></tr>'
  const both = (x, y) => typeof x === 'number' && typeof y === 'number'
  const metrics = METRICS.map(([k, label, f, dir, change]) => {
    const d = both(a.fit[k], b.fit[k]) ? b.fit[k] - a.fit[k] : null
    const text = d === null ? '' : /[1-9]/.test(change(d)) ? change(d) : '0'  // a change that rounds to nothing reads 0, uncoloured
    const cls = text && text !== '0' && dir ? (d * dir > 0 ? 'up' : 'down') : 'dim'
    return '<tr><td>' + label + '</td><td class="n">' + f(a.fit[k]) + '</td><td class="n">' + f(b.fit[k]) + '</td><td class="n ' + cls + '">' + text + '</td></tr>'
  }).join('')
  const roi = (r) => Object.fromEntries((r.channels || []).map((c) => [c.name, c]))
  const ra = roi(a), rb = roi(b)
  const channels = [...new Set([...Object.keys(ra), ...Object.keys(rb)])]
  const rois = channels.map((c) => { const x = ra[c], y = rb[c]
    return '<tr><td>' + esc(c) + '</td><td class="n">' + (x ? num(x.roi) + ' <span class="dim">' + num(x.roi_lo) + '–' + num(x.roi_hi) + '</span>' : '–') + '</td><td class="n">' + (y ? num(y.roi) + ' <span class="dim">' + num(y.roi_lo) + '–' + num(y.roi_hi) + '</span>' : '–') + '</td><td class="n">' + (x && y ? (y.roi - x.roi > 0 ? '+' : '') + num(y.roi - x.roi) : '') + '</td></tr>' }).join('')
  const ca = Object.fromEntries(flat(a.config)), cb = Object.fromEntries(flat(b.config))
  const keys = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].filter((k) => ca[k] !== cb[k]).sort()
  const diff = keys.map((k) => '<tr><td><code>' + esc(k) + '</code></td><td class="n"><code>' + esc(ca[k] ?? '–') + '</code></td><td class="n"><code>' + esc(cb[k] ?? '–') + '</code></td><td></td></tr>').join('')
  // one table, three sections: the columns line up (a, b, change) and nothing overlaps however narrow the panel
  const section = (title) => '<tr class="section"><th colspan="4">' + title + '</th></tr>'
  $('#compare').innerHTML = '<div class="scroll"><table class="compare"><thead>' + head + '</thead><tbody>'
    + section('Fit') + metrics + section('ROI by channel') + rois
    + section('Configuration that differs') + (diff || '<tr><td colspan="4" class="dim">Same configuration.</td></tr>') + '</tbody></table></div>'
}
window.addEventListener('message', (e) => { rows = e.data.rows; picked = picked.filter((p) => rows.some((r) => id(r) === p)); render() })
$('#model').addEventListener('change', (e) => { model = e.target.value; render() })
$('#rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return
  const runId = tr.dataset.id
  if (e.target.matches('input')) {
    picked = picked.includes(runId) ? picked.filter((p) => p !== runId) : [...picked, runId].slice(-2)
    vs.setState({ picked }); render()
  } else vs.postMessage({ open: runId })
})
vs.postMessage({ ready: true })
`

const STYLE = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 12px 12px}
.bar{display:flex;gap:8px;align-items:center;margin:8px 0}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:2px 4px}
table{border-collapse:collapse;width:100%}th,td{padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);text-align:left;white-space:nowrap;vertical-align:top}
th{font-weight:normal;color:var(--vscode-descriptionForeground)}.n{text-align:right;font-variant-numeric:tabular-nums}.dim{color:var(--vscode-descriptionForeground)}
#rows tr{cursor:pointer}#rows tr:hover{background:var(--vscode-list-hoverBackground)}#rows tr.picked{background:var(--vscode-list-inactiveSelectionBackground)}
.tag{font-size:.85em;padding:0 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.scroll{overflow-x:auto;margin-top:8px}table.compare{width:auto;min-width:60%}table.compare td:first-child{padding-right:24px}
tr.section th{padding-top:14px;color:var(--vscode-foreground);font-weight:600;border-bottom:1px solid var(--vscode-panel-border)}
.up{color:var(--vscode-testing-iconPassed)}.down{color:var(--vscode-editorWarning-foreground)}
code{font-family:var(--vscode-editor-font-family);font-size:.92em}h3{font-size:1em;margin:16px 0 4px}`

export class RunsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView
  constructor(
    private rows: () => RunRow[],
    private open: (row: RunRow) => void
  ) {}
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    const nonce = randomBytes(16).toString('base64')
    view.webview.options = { enableScripts: true }
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
      <style>${STYLE}</style></head><body>
      <div class="bar"><select id="model"></select><span class="dim">Click a run for its results; tick two to compare.</span></div>
      <table><thead><tr><th></th><th>Model</th><th>When</th><th class="n">R²</th><th class="n">MAPE</th><th class="n">wMAPE</th><th class="n">max r-hat</th><th class="n">divergences</th><th class="n">time</th></tr></thead>
      <tbody id="rows"></tbody></table>
      <h3>Compare</h3><div id="compare"></div>
      <script nonce="${nonce}">${SCRIPT}</script></body></html>`
    view.webview.onDidReceiveMessage((m) => {
      if (m.ready) this.update()
      const row = m.open && this.rows().find((r) => r.mlflow.run_id === m.open)
      if (row) this.open(row)
    })
    view.onDidChangeVisibility(() => view.visible && this.update())
  }
  /** Sends the runs again: after a fit, or any change to a runs.jsonl. */
  update() {
    if (this.view?.visible) void this.view.webview.postMessage({ rows: this.rows() })
  }
}
