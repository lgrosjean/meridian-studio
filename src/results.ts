// The results panel: a fit's quality and ROI per channel, or a scenario's spend before and after, read from
// <name>.result.json. One panel per file, beside the editor; it re-renders when the file changes.
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { stringify } from 'yaml'

type Fit = {
  fit: { r_hat_max: number; divergences: number; r2: number; mape: number; wmape: number; seconds: number }
  channels: { name: string; roi: number; roi_lo: number; roi_hi: number; contribution: number; spend: number }[]
  currency: string | null
  mlflow: { run_id: string }
  at?: string
  config?: Record<string, unknown>
}
type Scenario = {
  model: string
  window: { start: string; end: string }
  budget: { historical: number; before: number; after: number }
  outcome: { before: number; after: number }
  roi: { before: number; after: number }
  channels: { name: string; spend_before: number; spend_after: number; roi_before: number; roi_after: number; outcome_before: number; outcome_after: number }[]
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const money = (v: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
const pct = (v: number, signed = false) => `${signed && v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
const fixed = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–')

function fitBody(r: Fit): string {
  const f = r.fit
  const ok = (good: boolean, v: number = 0) => (!Number.isFinite(v) ? '' : good ? 'good' : 'warn')
  const tiles = [
    ['R²', fixed(f.r2), ok(f.r2 >= 0.8)],
    ['MAPE', pct(f.mape), ok(f.mape <= 0.15)],
    ['wMAPE', pct(f.wmape), ok(f.wmape <= 0.15)],
    ['max r-hat', fixed(f.r_hat_max, 3), ok(f.r_hat_max < 1.2, f.r_hat_max ?? NaN)],
    ['divergences', String(f.divergences), ok(f.divergences === 0)],
    ['fit time', f.seconds < 60 ? `${f.seconds} s` : `${Math.round(f.seconds / 60)} min`, '']
  ]
  const top = Math.max(...r.channels.map((c) => c.roi_hi), 1)
  const x = (v: number) => `${(Math.max(v, 0) / top) * 100}%`
  const rows = [...r.channels]
    .sort((a, b) => b.roi - a.roi)
    .map(
      (c) => `<tr><td>${esc(c.name)}</td>
      <td class="bar"><div class="track"><span class="ci" style="left:${x(c.roi_lo)};width:calc(${x(c.roi_hi)} - ${x(c.roi_lo)})"></span><span class="dot" style="left:${x(c.roi)}"></span><span class="one" style="left:${x(1)}"></span></div></td>
      <td class="n">${fixed(c.roi)}</td><td class="n dim">${fixed(c.roi_lo)}–${fixed(c.roi_hi)}</td>
      <td class="n">${pct(c.contribution)}</td><td class="n">${money(c.spend)}</td></tr>`
    )
    .join('')
  return `<div class="tiles">${tiles.map(([k, v, cls]) => `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
  <h2>ROI by channel</h2>
  <table><thead><tr><th>Channel</th><th>ROI, 90% interval <span class="dim">(line at 1)</span></th><th class="n">ROI</th><th class="n">interval</th><th class="n">of KPI</th><th class="n">spend${r.currency ? ` (${esc(r.currency)})` : ''}</th></tr></thead><tbody>${rows}</tbody></table>
  ${r.config ? `<h2>Configuration</h2><pre>${esc(stringify(r.config, { flowCollectionPadding: false }))}</pre>` : ''}
  <p class="dim">MLflow run ${esc(r.mlflow.run_id)}</p>`
}

function scenarioBody(r: Scenario): string {
  const d = (a: number, b: number) => (a ? (b - a) / a : 0)
  const tiles = [
    ['budget', `${money(r.budget.after)}`, `${pct(d(r.budget.historical, r.budget.after), true)} vs historical`],
    ['incremental outcome', money(r.outcome.after), `${pct(d(r.outcome.before, r.outcome.after), true)} vs historical mix`],
    ['ROI', fixed(r.roi.after), `from ${fixed(r.roi.before)}`]
  ]
  const top = Math.max(...r.channels.flatMap((c) => [c.spend_before, c.spend_after]), 1)
  const rows = r.channels
    .map((c) => {
      const delta = d(c.spend_before, c.spend_after)
      return `<tr><td>${esc(c.name)}</td>
      <td class="bar"><div class="pair"><span class="before" style="width:${(c.spend_before / top) * 100}%"></span><span class="after" style="width:${(c.spend_after / top) * 100}%"></span></div></td>
      <td class="n">${money(c.spend_before)}</td><td class="n">${money(c.spend_after)}</td>
      <td class="n ${delta > 0.005 ? 'up' : delta < -0.005 ? 'down' : 'dim'}">${pct(delta, true)}</td>
      <td class="n">${fixed(c.roi_before)} → ${fixed(c.roi_after)}</td></tr>`
    })
    .join('')
  return `<div class="tiles">${tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s dim">${s}</div></div>`).join('')}</div>
  <h2>Spend by channel</h2>
  <p class="dim">Before is the historical mix at the same budget, so the gap is the reallocation alone. Model ${esc(r.model)}, ${esc(r.window.start)} to ${esc(r.window.end)}.</p>
  <table><thead><tr><th>Channel</th><th><span class="key before"></span>before <span class="key after"></span>after</th><th class="n">before</th><th class="n">after</th><th class="n">change</th><th class="n">ROI</th></tr></thead><tbody>${rows}</tbody></table>`
}

const STYLE = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px 20px;max-width:960px}
h1{font-size:1.3em;margin:0 0 4px}h2{font-size:1.05em;margin:24px 0 8px}
.dim{color:var(--vscode-descriptionForeground)}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:4px 10px;border-radius:2px;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:12px}
.tile{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:8px 10px}
.tile .k{font-size:.85em;color:var(--vscode-descriptionForeground)}.tile .v{font-size:1.4em;font-variant-numeric:tabular-nums;margin-top:2px}.tile .s{font-size:.85em}
.tile.good .v{color:var(--vscode-testing-iconPassed)}.tile.warn .v{color:var(--vscode-editorWarning-foreground)}
table{border-collapse:collapse;width:100%}th,td{padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);text-align:left;white-space:nowrap}
th{font-weight:normal;color:var(--vscode-descriptionForeground)}.n{text-align:right;font-variant-numeric:tabular-nums}
td.bar{width:40%}.track,.pair{position:relative;height:12px}
.ci{position:absolute;top:4px;height:4px;background:var(--vscode-charts-blue);opacity:.35;border-radius:2px}
.dot{position:absolute;top:1px;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:var(--vscode-charts-blue)}
.one{position:absolute;top:-2px;bottom:-2px;width:1px;background:var(--vscode-descriptionForeground);opacity:.6}
.pair span{display:block;height:5px;border-radius:2px;margin-bottom:2px}
.before{background:var(--vscode-descriptionForeground);opacity:.5}.after{background:var(--vscode-charts-blue)}
.key{display:inline-block;width:10px;height:5px;margin:0 4px 1px 8px;border-radius:2px;vertical-align:middle}
pre{font-family:var(--vscode-editor-font-family);font-size:.92em;background:var(--vscode-textCodeBlock-background);padding:8px 10px;border-radius:4px;overflow:auto}
.up{color:var(--vscode-testing-iconPassed)}.down{color:var(--vscode-editorWarning-foreground)}`

function page(title: string, body: string, hasReport: boolean): string {
  const nonce = randomBytes(16).toString('base64')
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <style>${STYLE}</style></head><body>
  <div class="head"><h1>${esc(title)}</h1>${hasReport ? '<button id="report">Open Meridian report</button>' : ''}</div>
  ${body}
  <script nonce="${nonce}">const vs=acquireVsCodeApi();document.getElementById('report')?.addEventListener('click',()=>vs.postMessage('report'))</script>
  </body></html>`
}

const panels = new Map<string, vscode.WebviewPanel>() // by result.json path

/** Shows (or refreshes) the panel of a model or a scenario. `result` is its result.json's text, undefined if none yet. */
export function showResults(kind: 'models' | 'scenarios', name: string, file: string, result: string | undefined, openReport: () => void, reveal = true) {
  let panel = panels.get(file)
  if (!panel) {
    if (!reveal) return
    panel = vscode.window.createWebviewPanel('meridian.results', name, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true })
    panel.iconPath = new vscode.ThemeIcon(kind === 'models' ? 'graph-line' : 'pie-chart')
    panel.webview.onDidReceiveMessage((m) => m === 'report' && openReport())
    panel.onDidDispose(() => panels.delete(file))
    panels.set(file, panel)
  } else if (reveal) panel.reveal(undefined, true)
  let body = `<p class="dim">No results yet: ${kind === 'models' ? 'fit' : 'optimize'} it first.</p>`
  if (result)
    try {
      body = kind === 'models' ? fitBody(JSON.parse(result)) : scenarioBody(JSON.parse(result))
    } catch (e) {
      body = `<p>Could not read ${esc(file)}: ${esc(e instanceof Error ? e.message : e)}</p>`
    }
  panel.title = name
  panel.webview.html = page(`${kind === 'models' ? 'Fit' : 'Scenario'} · ${name}`, body, !!result)
}

/** Re-renders the open panels, after a file changed. */
export const openPanels = () => [...panels.keys()]

// Meridian's own HTML report, in a panel beside the editor. It is a self-contained page whose charts are
// Vega, loaded from gstatic.com, and whose fonts come from Google Fonts: the policy allows those and nothing else.
// ponytail: charts need the network; vendor vega/vega-lite/vega-embed into the extension if offline matters.
const REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com", // Vega compiles its expressions
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src https: data:'
].join('; ')
const reports = new Map<string, vscode.WebviewPanel>() // by report path

export function showReport(title: string, html: string, key: string) {
  let panel = reports.get(key)
  if (panel) panel.reveal(undefined, true)
  else {
    panel = vscode.window.createWebviewPanel('meridian.report', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true })
    panel.iconPath = new vscode.ThemeIcon('graph')
    panel.onDidDispose(() => reports.delete(key))
    reports.set(key, panel)
  }
  const csp = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`
  panel.webview.html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + csp) : csp + html
}
