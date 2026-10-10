// A dataset's YAML in the editor, helped by its CSV: the CSV's columns and the channels completed where they go,
// a hover on a column (what it holds, its role), the checks underlined as you type with their quick fixes,
// "Complete from <the CSV>" above the file, and the role of a column set from the tree. The logic is dataset.ts's;
// this file only speaks VS Code.
import { basename, isAbsolute, join, relative } from 'node:path'
import * as vscode from 'vscode'
import { profileOf, type Profile } from './csv'
import { ROLES, assign, channelFor, channelSource, check, complete, diff, fits, hover, isPlaceholder, parses, readDataset, removeColumn, suggest, summarize, usage, where } from './dataset'

type Env = { project: () => string; isDataset: (uri: vscode.Uri) => boolean }

/** The CSV a dataset's text names, profiled; undefined when it names none or the file cannot be read. */
const csvOf = (env: Env, text: string): Profile | undefined => {
  const value = readDataset(text).csv?.value
  return value ? profileOf(isAbsolute(value) ? value : join(env.project(), value)) : undefined
}
const span = (doc: vscode.TextDocument, start: number, end: number) => new vscode.Range(doc.positionAt(start), doc.positionAt(end))
/** The edit that turns the document's text into this one, as one replacement. */
const editTo = (doc: vscode.TextDocument, after: string) => {
  const e = diff(doc.getText(), after)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, span(doc, e.start, e.end), e.text)
  return edit
}
/** The YAML rewritten and saved, so the tree (which reads the file) follows; undoable in an open editor. */
async function rewrite(doc: vscode.TextDocument, after: string) {
  if (after === doc.getText()) return
  await vscode.workspace.applyEdit(editTo(doc, after))
  await doc.save()
}

/** Fills the dataset's blanks from its CSV, then says what it did and what it left. */
export async function completeDataset(env: Env, uri: vscode.Uri) {
  const doc = await vscode.workspace.openTextDocument(uri)
  const csv = csvOf(env, doc.getText())
  if (!csv) throw new Error(`${basename(uri.fsPath)}: its csv: is missing or unreadable`)
  if (!parses(doc.getText())) throw new Error(`${basename(uri.fsPath)} does not read as YAML: fix it first (see Problems)`)
  const r = complete(doc.getText(), csv)
  await rewrite(doc, r.text)
  vscode.window.showInformationMessage(summarize(r, csv.file))
}

/** The role of these columns of a dataset (one, or several picked together in the tree), and for one column its channel. */
export async function setRole(env: Env, uri: vscode.Uri, columns: string[]) {
  const doc = await vscode.workspace.openTextDocument(uri)
  const text = doc.getText()
  if (!parses(text)) throw new Error(`${basename(uri.fsPath)} does not read as YAML: fix it first (see Problems)`)
  const csv = csvOf(env, text)
  const ds = readDataset(text)
  const one = columns.length === 1 ? columns[0] : undefined
  const now = one ? (usage(ds).get(one) ?? []) : []
  const fit = (key: string) =>
    one && csv?.columns.get(one) && (key === 'time' ? csv.columns.get(one)!.type === 'dates' : key === 'geo' ? csv.columns.get(one)!.type === 'text' : fits(key, one))
  type Pick = vscode.QuickPickItem & { key?: string }
  const roles: Pick[] = ROLES.filter((r) => one || r.many)
    .map((r) => ({ label: r.key, key: r.key, description: [now.includes(r.key) ? 'its role now' : fit(r.key) ? 'its name or content fits' : '', r.hint].filter(Boolean).join(' · ') }))
    .sort((a, b) => Number(!now.includes(b.key!)) - Number(!now.includes(a.key!)) || Number(!!fit(b.key!)) - Number(!!fit(a.key!)))
  const items: Pick[] = [...roles, { label: '', kind: vscode.QuickPickItemKind.Separator }, { label: 'Not used', description: 'out of every role' }]
  const pick = await vscode.window.showQuickPick(items, { placeHolder: one ? `The role of ${one} in ${basename(uri.fsPath)}` : `The role of ${columns.length} columns: ${columns.join(', ')}` })
  if (!pick) return
  if (!pick.key) return rewrite(doc, columns.reduce((t, c) => removeColumn(t, c), text))
  const r = ROLES.find((x) => x.key === pick.key)!
  if (!r.map || !one) return rewrite(doc, assign(text, columns, r.key))
  // One column of a role with channels: its channel, from the group's (tv for tv_spend when tv_imps is tv) or a new one.
  const guess = channelFor(ds, one, r.key)
  const known = [...new Set(ROLES.filter((x) => x.map).flatMap((x) => (ds.maps[x.map!] ?? []).map((e) => e.channel?.value ?? '')))].filter((c) => !isPlaceholder(c) && c !== guess)
  const other = '$(edit) Another name…'
  const ch = await vscode.window.showQuickPick([guess, ...known, other].map((label) => ({ label, description: label === guess ? channelSource(ds, one, r.key) : undefined })), {
    placeHolder: `The channel ${one} measures`
  })
  if (!ch) return
  const channel = ch.label === other ? await vscode.window.showInputBox({ prompt: `The channel ${one} measures`, value: guess, validateInput: (v) => (v.trim() ? undefined : 'A name') }) : ch.label
  if (channel) await rewrite(doc, assign(text, [one], r.key, () => channel.trim()))
}

/** Completion, hover, the checks as diagnostics with their fixes, and the lens; returns what re-checks open datasets (after a CSV changed). */
export function registerAssist(context: vscode.ExtensionContext, env: Env): { recheck: () => void } {
  const selector: vscode.DocumentSelector = { language: 'yaml', scheme: 'file', pattern: '**/datasets/*.yaml' }
  const diagnostics = vscode.languages.createDiagnosticCollection('meridian-dataset')
  const severity = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning }
  const diagnose = (doc: vscode.TextDocument) => {
    if (!env.isDataset(doc.uri)) return
    const text = doc.getText()
    diagnostics.set(
      doc.uri,
      check(text, csvOf(env, text)).map((p) => {
        const d = new vscode.Diagnostic(span(doc, p.start, p.end), p.message, severity[p.severity])
        d.source = 'Meridian Studio'
        return d
      })
    )
  }
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const later = (doc: vscode.TextDocument) => {
    clearTimeout(timers.get(doc.uri.toString()))
    timers.set(doc.uri.toString(), setTimeout(() => diagnose(doc), 250))
  }
  const lensChanged = new vscode.EventEmitter<void>()
  const recheck = () => {
    vscode.workspace.textDocuments.forEach(diagnose)
    lensChanged.fire()
  }

  const completion: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, position) {
      if (!env.isDataset(doc.uri)) return
      const text = doc.getText()
      const offset = doc.offsetAt(position)
      const w = where(text, offset)
      if (w?.what === 'csv') {
        const files = await vscode.workspace.findFiles('**/*.csv', '{**/node_modules/**,**/mlruns/**,**/.venv/**}', 500)
        return files.map((f) => {
          const item = new vscode.CompletionItem(relative(env.project(), f.fsPath).split('\\').join('/'), vscode.CompletionItemKind.File)
          item.range = span(doc, w.start, w.end)
          return item
        })
      }
      const kinds = { column: vscode.CompletionItemKind.Field, channel: vscode.CompletionItemKind.EnumMember, all: vscode.CompletionItemKind.Snippet }
      return suggest(text, offset, csvOf(env, text)).map((s) => {
        const item = new vscode.CompletionItem(s.label, kinds[s.kind])
        item.detail = s.detail
        if (s.doc) item.documentation = new vscode.MarkdownString(s.doc)
        item.insertText = s.snippet ? new vscode.SnippetString(s.insert) : s.insert
        item.range = span(doc, s.start, s.end)
        item.sortText = s.sort
        return item
      })
    }
  }
  const hovers: vscode.HoverProvider = {
    provideHover(doc, position) {
      if (!env.isDataset(doc.uri)) return
      const text = doc.getText()
      const h = hover(text, doc.offsetAt(position), csvOf(env, text))
      return h && new vscode.Hover(new vscode.MarkdownString(h.markdown), span(doc, h.start, h.end))
    }
  }
  const actions: vscode.CodeActionProvider = {
    provideCodeActions(doc, range, ctx) {
      if (!env.isDataset(doc.uri)) return
      const text = doc.getText()
      const [from, to] = [doc.offsetAt(range.start), doc.offsetAt(range.end)]
      const out: vscode.CodeAction[] = []
      const titles = new Set<string>()
      for (const p of check(text, csvOf(env, text))) {
        if (p.end < from || p.start > to) continue
        const diagnostic = ctx.diagnostics.find((d) => d.message === p.message && d.range.isEqual(span(doc, p.start, p.end)))
        for (const f of p.fixes) {
          if (titles.has(f.title)) continue
          const after = f.edit(text)
          if (after === text) continue
          titles.add(f.title)
          const a = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix)
          a.edit = editTo(doc, after)
          a.isPreferred = f.preferred
          if (diagnostic) a.diagnostics = [diagnostic]
          out.push(a)
        }
      }
      return out
    }
  }
  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      if (!env.isDataset(doc.uri)) return []
      const text = doc.getText()
      const csv = csvOf(env, text)
      const r = csv && complete(text, csv)
      if (!csv || !r || r.text === text) return []
      const n = new Set(r.done.flatMap((d) => d.columns)).size
      return [
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: `$(sparkle) Complete from ${csv.file}${n ? `: ${n} column${n > 1 ? 's' : ''}` : ''}`,
          command: 'meridian.complete',
          arguments: [doc.uri],
          tooltip: summarize(r, csv.file)
        })
      ]
    }
  }
  context.subscriptions.push(
    diagnostics,
    lensChanged,
    { dispose: () => timers.forEach(clearTimeout) },
    vscode.languages.registerCompletionItemProvider(selector, completion, ' ', '[', ','),
    vscode.languages.registerHoverProvider(selector, hovers),
    vscode.languages.registerCodeActionsProvider(selector, actions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCodeLensProvider(selector, lenses),
    vscode.workspace.onDidOpenTextDocument(diagnose),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri))
  )
  vscode.workspace.textDocuments.forEach(diagnose)
  return { recheck }
}
