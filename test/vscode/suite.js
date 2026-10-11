// Runs in VS Code's extension host (run.js starts it): Meridian Studio and the YAML extension on a copy of examples/.
// Each step does what a person does in the editor, then asserts on what VS Code shows.
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

const log = (...a) => console.log('  ', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, test, ms = 30000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await test()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out: ${what}`)
    await sleep(200)
  }
}
// The dataset's own checks (no code) and the data checks (a code like T001), both from Meridian Studio.
const studio = (uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Meridian Studio')
const dataChecks = (uri) => studio(uri).filter((d) => /^[A-Z]\d{3}$/.test(String(d.code)))
const yamlChecks = (uri) => studio(uri).filter((d) => !d.code)
const label = (i) => (typeof i.label === 'string' ? i.label : i.label.label)
const at = (doc, needle, after = 0) => {
  const i = doc.getText().indexOf(needle)
  assert.ok(i >= 0, `${needle} in ${doc.uri.fsPath}`)
  return doc.positionAt(i + after)
}
async function replace(doc, from, to, text) {
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(from, to), text)
  assert.ok(await vscode.workspace.applyEdit(edit))
}
const lenses = async (doc) => (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri)).filter((l) => l.command)

exports.run = async () => {
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const ext = vscode.extensions.getExtension('lgrosjean.meridian-studio')
  await ext.activate()

  // A new dataset as New dataset writes it before filling it: its blanks underlined, the lens to fill them.
  const header = fs.readFileSync(path.join(ws, 'data', 'national_media.csv'), 'utf8').split('\n')[0]
  const values = { name: 'fresh', csv: 'data/national_media.csv', columns: header.split(',').join(', '), time: 'time' }
  const template = fs.readFileSync(path.join(ext.extensionPath, 'runner', 'templates', 'dataset.yaml'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? '')
  const file = path.join(ws, 'datasets', 'fresh.yaml')
  fs.writeFileSync(file, template)
  const doc = await vscode.workspace.openTextDocument(file)
  await vscode.window.showTextDocument(doc)
  const blanks = await until('the template underlined', () => yamlChecks(doc.uri).length && yamlChecks(doc.uri))
  assert.ok(blanks.some((d) => d.message === 'Name a column of national_media.csv here'), blanks.map((d) => d.message))
  const complete = await until('the Complete lens', async () => (await lenses(doc)).find((l) => l.command.command === 'meridian.complete'))
  assert.equal(complete.command.title, '$(sparkle) Complete from national_media.csv: 12 columns')
  log('template: blanks underlined, lens', complete.command.title)

  await vscode.commands.executeCommand(complete.command.command, ...complete.command.arguments)
  await until('the dataset filled and saved', () => !doc.isDirty && fs.readFileSync(file, 'utf8').includes('Channel3_spend: Channel3'))
  await until('no problem left', () => !yamlChecks(doc.uri).length)
  log('Complete from the CSV: filled, nothing left to flag')

  // A typo, underlined, and its fix.
  await replace(doc, at(doc, 'sentiment_score_control]'), at(doc, 'sentiment_score_control]', 'sentiment_score_control'.length), 'sentiment_score_contrl')
  const typo = await until('the typo underlined', () => yamlChecks(doc.uri).find((d) => d.message.includes('contrl')))
  assert.equal(typo.message, 'sentiment_score_contrl is not a column of national_media.csv')
  const fixes = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, typo.range)
  const fix = fixes.find((a) => a.title === 'Replace with sentiment_score_control')
  assert.ok(fix, fixes.map((a) => a.title))
  await vscode.workspace.applyEdit(fix.edit)
  await until('the typo fixed', () => !yamlChecks(doc.uri).length)
  log('typo: underlined, fixed by its quick fix')

  // Completion: the CSV's free columns in a list, with what each holds; a channel from its partner column.
  const list = 'controls: [competitor_activity_score_control, sentiment_score_control]'
  await replace(doc, at(doc, list), at(doc, list, list.length), 'controls: [competitor_activity_score_control, ]')
  const inList = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, at(doc, 'controls: [competitor_activity_score_control, ', 'controls: [competitor_activity_score_control, '.length))
  const column = inList.items.find((i) => label(i) === 'sentiment_score_control')
  assert.equal(column?.detail, 'numbers · -2.49 – 1.7')
  const entry = '  Channel3_spend: Channel3'
  await replace(doc, at(doc, entry), at(doc, entry, entry.length), '  Channel3_spend: ')
  const channels = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, at(doc, '  Channel3_spend: ', '  Channel3_spend: '.length))
  const channel = channels.items.filter((i) => i.kind === vscode.CompletionItemKind.EnumMember).sort((a, b) => a.sortText.localeCompare(b.sortText))[0]
  assert.deepEqual([label(channel), channel.detail], ['Channel3', 'the channel of Channel3_impression'])
  log('completion: a column with what it holds, a channel from its partner')

  // A hover on a column: what it holds, its role.
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, at(doc, 'media_spend: [Channel0_spend, Channel1_spend, Channel2_spend', 'media_spend: [Channel0_spend, Channel1_spend, '.length + 2))
  const said = hovers.flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join('\n')
  assert.ok(said.includes('`Channel2_spend` · numbers · 28.2K – 355K') && said.includes('Used as media_spend'), said)
  log('hover: a column, what it holds, its role')
  await vscode.commands.executeCommand('workbench.action.files.revert')

  // The data checks: on their own once Meridian's environment is installed (uv sync --project runner).
  if (!fs.existsSync(path.join(ext.extensionPath, 'runner', '.venv'))) {
    log('data checks: skipped, runner/.venv missing (uv sync --project runner)')
    return
  }
  const broken = await vscode.workspace.openTextDocument(path.join(ws, 'datasets', 'broken.yaml'))
  await vscode.window.showTextDocument(broken)
  const found = await until('the data checks', () => dataChecks(broken.uri).length && dataChecks(broken.uri), 60000)
  assert.deepEqual(found.map((d) => [d.code, broken.getText(d.range)]).sort(), [['C001', 'covid'], ['M001', 'tv_spend'], ['T001', 'week']])
  assert.ok(dataChecks(vscode.Uri.file(path.join(ws, 'datasets', 'synthetic.yaml'))).length === 0) // checked too: nothing to say
  const counted = await until('the data lens', async () => (await lenses(broken)).find((l) => l.command.title.startsWith('$(error) Data')))
  assert.equal(counted.command.title, '$(error) Data: 3 errors')
  log('data checks: on the lines naming the columns,', counted.command.title)

  const line = 'controls: [price, covid]'
  await replace(broken, at(broken, line, line.length), at(broken, line, line.length), '   # noqa: C001')
  await broken.save()
  await until('C001 turned off', () => dataChecks(broken.uri).length === 2, 60000)
  log('data checks: # noqa: C001, saved, C001 off')

  // The schema lists the checks' codes, each with what it checks.
  await replace(broken, new vscode.Position(broken.lineCount, 0), new vscode.Position(broken.lineCount, 0), 'checks:\n  ignore: []\n')
  const codes = await until('the codes completed', async () => {
    const r = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', broken.uri, broken.positionAt(broken.getText().lastIndexOf('[]') + 1))
    return r.items.filter((i) => /^[A-Z]\d{3}$/.test(label(i))).length && r.items.filter((i) => /^[A-Z]\d{3}$/.test(label(i)))
  })
  assert.ok(codes.some((i) => label(i) === 'T001'), codes.map(label))
  log(`schema: ${codes.length} check codes completed`)
}
