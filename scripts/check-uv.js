// Self-check of the uv install when uv is missing: run with HOME and PATH that hold no uv.
// Run: bun run build && HOME=$(mktemp -d) PATH=/usr/bin:/bin node scripts/check-uv.js   (downloads uv, ~20 MB)
const Module = require('node:module')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const asked = []
const vscode = {
  TreeItem: class {}, EventEmitter: class { event = () => {}; fire() {} },
  window: {
    showInformationMessage: async (msg, opts, ...buttons) => (asked.push(msg), buttons[0]), // "Install uv"
    withProgress: (_o, task) => task()
  },
  ProgressLocation: { Notification: 15 },
  env: { openExternal() {} },
  Uri: { parse: (u) => u }
}
const load = Module._load
Module._load = (request, ...rest) => (request === 'vscode' ? vscode : load(request, ...rest))
const ext = require('../out/extension.js')
const storage = fs.mkdtempSync(join(os.tmpdir(), 'meridian-uv-'))
ext._setStorage(storage)
const out = { show() {}, append: (t) => process.stderr.write(t), appendLine: (t) => process.stderr.write(t + '\n') }
;(async () => {
  const uv = await ext._ensureUv(out)
  assert.equal(uv, join(storage, 'uv', 'uv'))
  assert.match(execFileSync(uv, ['--version'], { encoding: 'utf8' }), /^uv 0\.9\.28/)
  assert.equal(asked.length, 1)
  assert.equal(await ext._ensureUv(out), uv) // found next time, nothing asked
  assert.equal(asked.length, 1)
  fs.rmSync(storage, { recursive: true })
  console.log('ok')
})()
