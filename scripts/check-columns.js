// Self-check of a dataset's columns, a model's priors and its runs in the tree, against examples/ with a stand-in for the vscode module.
// Run: bun run build && node scripts/check-columns.js
const Module = require('node:module')
const { join } = require('node:path')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
let folder = join(__dirname, '..', 'examples')
class TreeItem { constructor(label) { this.label = label } }
const vscode = {
  TreeItem, MarkdownString: class { constructor(v) { this.value = v } }, ThemeIcon: class { constructor(id) { this.id = id } }, ThemeColor: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, EventEmitter: class { event = () => {}; fire() {} },
  Uri: { from: (u) => u, file: (path) => ({ scheme: 'file', fsPath: path }) },
  workspace: { get workspaceFolders() { return [{ uri: { fsPath: folder } }] } }
}
const load = Module._load
Module._load = (request, ...rest) => (request === 'vscode' ? vscode : load(request, ...rest))
const { _columnsOf, _priorsOf, _modelChildren, _folderChildren, _referenceIn } = require('../out/extension.js')

const cols = Object.fromEntries(_columnsOf('synthetic').map((c) => [c.label, c]))
assert.equal(cols.time.description, 'time')
assert.equal(cols.conversions.description, 'KPI')
assert.equal(cols.Channel0_impression.description, 'media · ch0')
assert.equal(cols.Channel2_spend.description, 'spend · ch2')
assert.equal(cols.sentiment_score_control.description, 'control')
assert.equal(cols.revenue_per_conversion.description, 'revenue per KPI')

// A model's channels: its priors, Meridian's default for the others (a model of the example dataset, made here).
fs.writeFileSync(join(folder, 'models', 'check-priors.yaml'), 'dataset: synthetic\npriors: { roi: { ch0: { mean: 1.5, sd: 0.8 } } }\n')
let priors
try {
  priors = Object.fromEntries(_priorsOf('check-priors').map((p) => [p.label, p.description]))
} finally {
  fs.rmSync(join(folder, 'models', 'check-priors.yaml'))
}
assert.deepEqual(Object.keys(priors), ['ch0', 'ch1', 'ch2', 'ch3'])
assert.equal(priors.ch0, 'ROI 1.50 ± 0.80 · adstock uniform')
assert.equal(priors.ch1, 'ROI 1.83 ± 2.04 (default) · adstock uniform')

// A column the CSV lacks comes last in red; a CSV column the YAML leaves out is greyed.
folder = fs.mkdtempSync(join(os.tmpdir(), 'meridian-'))
fs.mkdirSync(join(folder, 'datasets'))
fs.writeFileSync(join(folder, 'data.csv'), 'week,sales,tv_imp,tv_spend,unused\n2024-01-01,1,2,3,4\n')
fs.writeFileSync(join(folder, 'datasets', 'd.yaml'), 'csv: data.csv\ncoord_to_columns:\n  time: week\n  kpi: sales\n  media: [tv_imp, radio_imp]\n  media_spend: [tv_spend]\nmedia_to_channel:\n  tv_imp: tv\n')
const got = _columnsOf('d').map((c) => [c.label, c.description, c.resourceUri?.scheme ?? ''])
assert.deepEqual(got, [
  ['week', 'time', ''], ['sales', 'KPI', ''], ['tv_imp', 'media · tv', ''], ['tv_spend', 'spend', ''],
  ['unused', '', 'meridian-column'], ['radio_imp', 'media: not in the CSV', '']
])
fs.mkdirSync(join(folder, 'models'))
fs.writeFileSync(join(folder, 'models', 'm.yaml'), 'dataset: d\npriors:\n  roi: { tv: { mean: 2, sd: 1 }, radio: { mean: 1, sd: 1 } }\n  adstock: { tv: { loc: 0.6, low: 0.4, high: 0.85 } }\n')
assert.deepEqual(_priorsOf('m').map((p) => [p.label, p.description]), [
  ['tv', 'ROI 2.00 ± 1.00 · adstock 0.60 [0.40–0.85]'], ['radio', 'not a channel of the dataset']
])
// A model's runs: newest first, a cut line skipped, the one in result.json marked current.
const line = (at, id, r2) => JSON.stringify({ at, mlflow: { run_id: id, report: 'x.html' }, fit: { r2, mape: 0.05, r_hat_max: null } })
fs.writeFileSync(join(folder, 'models', 'm.runs.jsonl'), [line('2026-10-01T10:00:00+00:00', 'a', 0.9), line('2026-10-02T10:00:00+00:00', 'b', 0.95), '{"at": "cut'].join('\n'))
fs.writeFileSync(join(folder, 'models', 'm.result.json'), JSON.stringify({ mlflow: { run_id: 'a' } }))
const [runs, priorsFolder] = _modelChildren('m')
assert.deepEqual([runs.label, runs.description, priorsFolder.label], ['Runs', '2', 'Priors'])
assert.deepEqual(_folderChildren(runs).map((r) => [r.command.arguments[1].mlflow.run_id, r.description]), [
  ['b', 'R² 0.95 · MAPE 5.0%'], ['a', 'R² 0.90 · MAPE 5.0% · current']
])
fs.rmSync(folder, { recursive: true })
// The line naming a file: where its value sits, and the file it means.
const ref = (text, root) => _referenceIn(text, root, '/p')
assert.deepEqual(ref('name: m\ndataset: national-media   # the data\n', 'models'),
  { line: 1, start: 9, end: 23, kind: 'dataset', value: 'national-media', file: '/p/datasets/national-media.yaml' })
assert.deepEqual(ref('# model: no\nmodel: "v1"\n', 'scenarios'),
  { line: 1, start: 8, end: 10, kind: 'model', value: 'v1', file: '/p/models/v1.yaml' })
assert.equal(ref('csv: /data/x.csv\n', 'datasets').file, '/data/x.csv')
assert.equal(ref('csv: data/x.csv\n', 'datasets').file, '/p/data/x.csv')
assert.equal(ref('  dataset: nested\nsampling: {}\n', 'models'), undefined) // top-level keys only
assert.equal(ref('dataset:\n', 'models'), undefined)
console.log('ok')
