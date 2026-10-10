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
  Range: class { constructor(a, b, c, d) { Object.assign(this, { line: a, start: b, endLine: c, end: d }) } },
  TreeItem, MarkdownString: class { constructor(v) { this.value = v } }, ThemeIcon: class { constructor(id) { this.id = id } }, ThemeColor: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, EventEmitter: class { event = () => {}; fire() {} },
  Uri: { from: (u) => u, file: (path) => ({ scheme: 'file', fsPath: path }) },
  workspace: { get workspaceFolders() { return [{ uri: { fsPath: folder } }] } }
}
const load = Module._load
Module._load = (request, ...rest) => (request === 'vscode' ? vscode : load(request, ...rest))
const { _columnsOf, _priorsOf, _modelChildren, _folderChildren, _referenceIn, _wordRange, _dataset: D, _csv } = require('../out/extension.js')

const cols = Object.fromEntries(_columnsOf('synthetic').map((c) => [c.label, c]))
assert.equal(cols.time.description, 'time')
assert.equal(cols.conversions.description, 'KPI')
assert.equal(cols.Channel0_impression.description, 'media · ch0')
assert.equal(cols.Channel2_spend.description, 'spend · ch2')
assert.equal(cols.sentiment_score_control.description, 'control')
assert.equal(cols.revenue_per_conversion.description, 'revenue per KPI')

// A model's channels: its priors, Meridian's default for the others (a model of the example dataset, made here).
fs.writeFileSync(join(folder, 'models', 'check-priors.yaml'), 'dataset: synthetic\npriors:\n  roi_m: { dist: LogNormal, default: { mean: 1, sd: 1 }, ch0: { mean: 1.5, sd: 0.8 } }\n  alpha_m: { dist: Beta, concentration1: 2, concentration0: 3 }\n  sigma: { dist: HalfNormal, scale: 3 }\n')
let priors
try {
  priors = Object.fromEntries(_priorsOf('check-priors').map((p) => [p.label, p.description]))
} finally {
  fs.rmSync(join(folder, 'models', 'check-priors.yaml'))
}
assert.deepEqual(Object.keys(priors), ['ch0', 'ch1', 'ch2', 'ch3', 'model-wide'])
assert.equal(priors.ch0, 'ROI 1.50 ± 0.80 · adstock Beta(2.00, 3.00)')
assert.equal(priors.ch1, 'ROI 1.00 ± 1.00 · adstock Beta(2.00, 3.00)')
assert.equal(priors['model-wide'], 'sigma HalfNormal')

// A column the CSV lacks comes last in red; a CSV column the YAML leaves out is greyed.
folder = fs.mkdtempSync(join(os.tmpdir(), 'meridian-'))
fs.mkdirSync(join(folder, 'datasets'))
fs.writeFileSync(join(folder, 'data.csv'), 'week,sales,tv_imp,tv_spend,unused\n2024-01-01,1,2,3,4\n')
fs.writeFileSync(join(folder, 'datasets', 'd.yaml'), 'csv: data.csv\ncoord_to_columns:\n  time: week\n  kpi: sales\n  media: [tv_imp, radio_imp]\n  media_spend: [tv_spend]\nmedia_to_channel:\n  tv_imp: tv\n')
const got = _columnsOf('d').map((c) => [c.label, c.description, c.resourceUri?.scheme ?? '', c.contextValue])
assert.deepEqual(got, [
  ['week', 'time', '', 'column'], ['sales', 'KPI', '', 'column'], ['tv_imp', 'media · tv', '', 'column'], ['tv_spend', 'spend', '', 'column'],
  ['unused', '', 'meridian-column', 'column-unused'], ['radio_imp', 'media: not in the CSV', '', 'column-absent']
])
fs.mkdirSync(join(folder, 'models'))
fs.writeFileSync(join(folder, 'models', 'm.yaml'), 'dataset: d\nmodel_spec: { media_prior_type: mroi }\npriors:\n  roi_m: { dist: LogNormal, tv: { mean: 2, sd: 1 }, radio: { mean: 1, sd: 1 } }\n  alpha_m: { dist: TruncatedNormal, tv: { loc: 0.6, scale: 0.2, low: 0.4, high: 0.85 } }\n')
assert.deepEqual(_priorsOf('m').map((p) => [p.label, p.description]), [
  ['tv', 'mroi (default) · ROI 2.00 ± 1.00 (unused) · adstock TruncatedNormal(0.60, 0.20, 0.40, 0.85)'], ['radio', 'not a channel of the dataset']
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
// A data check lands on the line naming its variable: not in a comment, not a longer name that starts like it.
const yaml = '# channel_1 in a comment\npriors:\n  roi_m:\n    channel_10: { mean: 1, sd: 1 }\n    channel_1: { mean: 2, sd: 1 }\n'
assert.deepEqual({ ..._wordRange(yaml, 'channel_1') }, { line: 4, start: 4, endLine: 4, end: 13 })
assert.equal(_wordRange(yaml, 'channel_2'), undefined)
// --- A dataset's YAML helped by its CSV (src/csv.ts, src/dataset.ts) ---------------------------------------------
// The CSV as pandas reads it: quoted commas, NA strings, dates written yyyy-mm-dd or not.
const csv = _csv.profileCsv('week,geo,sales,tv_imps,TV Spend,radio_grp,radio_cost,price,"note, x",day\n'
  + '2024-01-01,north,10,5,1,2,3,0,a,01/01/2024\n2024-01-01,south,11,5,1,2,3,NA,"b,c",01/01/2024\n'
  + '2024-01-08,north,12,0,1,2,3,1,d,08/01/2024\n2024-01-08,south,13,0,1,2,3,1,e,08/01/2024\n', 'data.csv')
const col = (c) => _csv.describe(csv.columns.get(c))
assert.deepEqual(csv.header.slice(-2), ['note, x', 'day'])
assert.deepEqual([col('week'), col('tv_imps'), col('price'), col('geo'), col('day')], [
  'dates · 2024-01-01 → 2024-01-08 · 2 dates over 4 rows', 'numbers · 0 – 5 · 2 zeros', 'numbers · 0 – 1 · 1 zero · 1 empty', 'text · 2 values', 'dates · 01/01/2024 → 08/01/2024 · not yyyy-mm-dd · 2 dates over 4 rows'
])
// Complete from the CSV: the template's blanks filled, each column's role from its content and its name, impressions paired with spend.
const template = 'csv: data.csv\nkpi_type: revenue\ncoord_to_columns:\n  time: <column>\n  kpi: <column>\n  controls: []   # season, price\n  media: [<impressions column>, ...]\n  media_spend: [<spend column>, ...]\nmedia_to_channel:\n  <impressions column>: <channel>\nmedia_spend_to_channel:\n  <spend column>: <channel>\n'
const done = D.complete(template, csv)
assert.equal(done.text, 'csv: data.csv\nkpi_type: revenue\ncoord_to_columns:\n  time: week\n  kpi: sales\n  controls: [price]   # season, price\n  media: [tv_imps, radio_grp]\n  media_spend: [TV Spend, radio_cost]\n  geo: geo\nmedia_to_channel:\n  tv_imps: tv\n  radio_grp: radio\nmedia_spend_to_channel:\n  TV Spend: tv\n  radio_cost: radio\n')
assert.deepEqual(done.left, ['note, x', 'day'])
assert.equal(D.summarize(done, 'data.csv'), 'From data.csv: time week, geo geo, kpi sales, 2 channels (tv, radio), 1 control. Left unused: note, x, day.')
assert.deepEqual(D.check(done.text, csv), [])
// What the editor underlines, and the fixes it offers.
const broken = 'csv: data.csv\nkpi_type: revenue\ncoord_to_columns:\n  time: day\n  kpi: geo\n  revenue_per_kpi: price\n  controls: [Price, tv_imps]\n  media: [tv_imps, radio_grp]\n  media_spend: [radio_cost, TV Spend]\nmedia_to_channel: { tv_imps: tv, radio_grp: radio }\nmedia_spend_to_channel: { radio_cost: radio }\n'
const problems = D.check(broken, csv)
assert.deepEqual(problems.map((p) => [broken.slice(p.start, p.end), p.message, p.fixes.map((f) => f.title)]), [
  ['day', 'Meridian reads dates written yyyy-mm-dd; day has "01/01/2024"', []],
  ['geo', 'geo holds text ("north"), not numbers', []],
  ['Price', 'Price is not a column of data.csv', ['Replace with price']],
  ['tv_imps', 'tv_imps is also used as media', ['Remove tv_imps from controls']],
  ['tv_imps', 'tv_imps is also used as controls', ['Remove tv_imps from media']],
  ['TV Spend', 'TV Spend has no channel: add it to media_spend_to_channel', ['Add TV Spend to media_spend_to_channel']],
  ['price', 'Meridian ignores revenue_per_kpi with kpi_type: revenue (the KPI is already money)', ['Set kpi_type: non_revenue']]
])
const fixed = problems.reduce((t, p) => (p.fixes[0] && !p.message.startsWith('tv_imps is also used as controls') ? p.fixes[0].edit(t) : t), broken)
assert.equal(fixed.split('\n').slice(1, 11).join('\n'), 'kpi_type: non_revenue\ncoord_to_columns:\n  time: day\n  kpi: geo\n  revenue_per_kpi: price\n  controls: [price]\n  media: [tv_imps, radio_grp]\n  media_spend: [radio_cost, TV Spend]\nmedia_to_channel: { tv_imps: tv, radio_grp: radio }\nmedia_spend_to_channel: { radio_cost: radio, TV Spend: tv }')
const order = D.check(fixed, csv).find((p) => p.message.includes('pairs them by position'))
assert.equal(order.message, 'media_spend lists its channels as radio, tv, media as tv, radio: Meridian pairs them by position')
assert.match(order.fixes[0].edit(fixed), /media_spend: \[TV Spend, radio_cost\]/)
// The repeated dates of a geo dataset name their geo column.
assert.deepEqual(D.check('csv: data.csv\ncoord_to_columns:\n  time: week\n  kpi: sales\n  media: [tv_imps]\n  media_spend: [TV Spend]\nmedia_to_channel: { tv_imps: tv }\nmedia_spend_to_channel: { TV Spend: tv }\n', csv)
  .map((p) => [p.message, p.fixes.map((f) => f.title)]), [['week repeats (2 dates over 4 rows): a geo dataset names its geo column', ['Use geo as geo']]])
// Edits keep the person's layout: block lists stay blocks, comments stay, the last item out leaves [].
let block = 'csv: data.csv\ncoord_to_columns:\n  controls:\n    - price   # p\n  media:\n    - tv_imps\nmedia_to_channel:\n  tv_imps: tv   # the TV\n'
block = D.assign(block, ['radio_grp'], 'media')
assert.equal(block, 'csv: data.csv\ncoord_to_columns:\n  controls:\n    - price   # p\n  media:\n    - tv_imps\n    - radio_grp\nmedia_to_channel:\n  tv_imps: tv   # the TV\n  radio_grp: radio\n')
assert.equal(D.assign(block, ['price'], 'non_media_treatments'), 'csv: data.csv\ncoord_to_columns:\n  controls: []\n  media:\n    - tv_imps\n    - radio_grp\n  non_media_treatments: [price]\nmedia_to_channel:\n  tv_imps: tv   # the TV\n  radio_grp: radio\n')
assert.equal(D.removeColumn(block, 'tv_imps'), 'csv: data.csv\ncoord_to_columns:\n  controls:\n    - price   # p\n  media:\n    - radio_grp\nmedia_to_channel:\n  radio_grp: radio\n')
// The template's commented line for a role becomes the real one.
assert.equal(D.setScalar('coord_to_columns:\n  kpi: sales\n  # revenue_per_kpi: <column>\n  controls: []\n', ['coord_to_columns', 'revenue_per_kpi'], 'x'), 'coord_to_columns:\n  kpi: sales\n  revenue_per_kpi: x\n  controls: []\n')
assert.equal(D.diff('a: [x, y]\n', 'a: [x, z, y]\n').text, 'z, ')
// A YAML that does not read is left as it is: the edits need its structure.
const unread = 'csv: data.csv\ncoord_to_columns:\n  media: [tv_imps\n  kpi: sales\n'
assert.equal(D.complete(unread, csv).text, unread)
assert.equal(D.assign(unread, ['radio_grp'], 'media'), unread)
// Completion where the cursor is (| marks it), even in a half-typed YAML: the free columns, the best fits first; a map's keys; channels.
const suggest = (t) => D.suggest(t.replace('|', ''), t.indexOf('|'), csv).sort((a, b) => a.sort.localeCompare(b.sort)).map((s) => s.insert)
const head = 'csv: data.csv\ncoord_to_columns:\n  time: week\n  geo: geo\n'
assert.deepEqual(suggest(head + '  controls: [price, |\n').slice(0, 3), ['sales', 'tv_imps', 'TV Spend'])
assert.deepEqual(suggest(head + '  media_spend: [TV Spend]\n  media: [tv_imps]\nmedia_to_channel: { tv_imps: tv }\nmedia_spend_to_channel:\n  |\n'), ['TV Spend: ${1:tv}'])
assert.deepEqual(suggest(head + '  media: [tv_imps]\n  media_spend: [TV Spend]\nmedia_to_channel: { tv_imps: tv }\nmedia_spend_to_channel:\n  TV Spend: |\n'), ['tv'])
assert.deepEqual(D.suggest(head + '  media: [tv_imps]\n  media_spend: [TV Spend]\nmedia_to_channel: { tv_imps: tv }\nmedia_spend_to_channel:\n  TV Spend: |\n'.replace('|', ''), (head + '  media: [tv_imps]\n  media_spend: [TV Spend]\nmedia_to_channel: { tv_imps: tv }\nmedia_spend_to_channel:\n  TV Spend: |\n').indexOf('|'), csv)[0].detail, 'the channel of tv_imps')
assert.equal(D.suggest('kpi_type: re', 12, csv).length, 0)
// A hover on a column says what it holds and its role; on a role's own key, nothing (the schema's hover says it).
const hovered = (t, word) => D.hover(t, t.indexOf(word) + 1, csv)?.markdown
assert.equal(hovered(head + '  kpi: sales\n', 'sales'), '`sales` · numbers · 10 – 13\n\ne.g. `10`, `11`, `12`\n\nUsed as kpi')
assert.equal(hovered(head + '  kpi: sales\n', 'kpi'), undefined)
console.log('ok')
