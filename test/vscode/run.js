// The extension in a real VS Code, with the YAML extension it depends on, on a copy of examples/ and a dataset made to
// break the data checks: what the editor does (diagnostics, quick fixes, completion, hover, lenses, data checks),
// asserted through VS Code's own API in suite.js.
// Run: bun run test:vscode   (downloads VS Code into .vscode-test/ the first time; without a display, xvfb-run -a first)
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const cache = path.join(root, '.vscode-test')

async function main() {
  const exe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: cache })
  const extensions = path.join(cache, 'extensions')
  const user = path.join(cache, 'user') // short: VS Code's socket lives in it, and a socket path has a length limit
  if (!fs.existsSync(extensions) || !fs.readdirSync(extensions).some((d) => d.startsWith('redhat.vscode-yaml-'))) {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(exe)
    const r = cp.spawnSync(cli, [...args, '--extensions-dir', extensions, '--user-data-dir', user, '--install-extension', 'redhat.vscode-yaml'], { stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status !== 0) throw new Error('Could not install redhat.vscode-yaml')
  }

  // The examples, without what runs left; and a weekly dataset with a week missing (T001), a negative spend (M001)
  // and a control that never varies (C001).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-vscode-'))
  fs.cpSync(path.join(root, 'examples'), ws, { recursive: true, filter: (src) => !/(mlruns|mlflow\.db|\.result\.json|\.runs\.jsonl|\.run\.json|\.html)$/.test(src) })
  const weeks = [...Array(12).keys()].filter((k) => k !== 6).map((k) => new Date(Date.UTC(2024, 0, 1 + 7 * k)).toISOString().slice(0, 10))
  const rows = weeks.map((w, i) => [w, 100 + i, 1000 + 10 * i, i === 3 ? -1 : 50 + i, 9 + (i % 3), 1].join(','))
  fs.writeFileSync(path.join(ws, 'data', 'broken.csv'), ['week,sales,tv_imps,tv_spend,price,covid', ...rows].join('\n') + '\n')
  fs.writeFileSync(
    path.join(ws, 'datasets', 'broken.yaml'),
    'csv: data/broken.csv\nkpi_type: revenue\ncoord_to_columns:\n  time: week\n  kpi: sales\n  controls: [price, covid]\n  media: [tv_imps]\n  media_spend: [tv_spend]\nmedia_to_channel: { tv_imps: tv }\nmedia_spend_to_channel: { tv_spend: tv }\n'
  )
  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [ws, '--extensions-dir', extensions, '--user-data-dir', user, '--disable-workspace-trust', '--disable-gpu', '--skip-welcome', '--skip-release-notes']
    })
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
