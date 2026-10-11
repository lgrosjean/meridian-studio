// The documentation keeps up with the code: every YAML key of the schemas, every data check, every setting and every
// command of the sidebar has its line in docs/. Run: node scripts/check-docs.js (bun run docs:build runs it).
const fs = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const read = (f) => fs.readFileSync(join(root, f), 'utf8')
const json = (f) => JSON.parse(read(f))
const keys = (o) => Object.keys(o?.properties ?? {})
const missing = []
const expect = (page, names, as = (n) => `\`${n}\``) => {
  const text = read(page)
  for (const n of names) if (!text.includes(as(n))) missing.push(`${page}: ${as(n)}`)
}

const dataset = json('schemas/dataset.schema.json')
expect('docs/reference/dataset.md', [...keys(dataset), ...keys(dataset.properties.coord_to_columns), ...keys(dataset.properties.checks), ...keys(dataset.properties.checks.properties.thresholds)])
const model = json('schemas/model.schema.json')
expect('docs/reference/model.md', [...keys(model), ...keys(model.properties.model_spec), ...keys(model.properties.priors), ...keys(model.properties.sampling)])
const scenario = json('schemas/scenario.schema.json')
expect('docs/reference/scenario.md', [...keys(scenario), ...keys(scenario.definitions.bounds), ...keys(scenario.properties.target)])

const codes = [...read('runner/checks.py').matchAll(/@rule\("([A-Z]\d{3})"/g)].map((m) => m[1])
if (!codes.length) missing.push('runner/checks.py: no @rule found')
expect('docs/guide/data-checks.md', codes, (c) => `| ${c} |`)

const pkg = json('package.json').contributes
expect('docs/reference/commands.md', Object.keys(pkg.configuration.properties))
const shown = new Set(Object.entries(pkg.menus).filter(([m]) => m !== 'commandPalette').flatMap(([, items]) => items.map((i) => i.command)))
expect('docs/reference/commands.md', pkg.commands.filter((c) => shown.has(c.command)).map((c) => c.title), (t) => t.replace(/…$/, ''))

if (missing.length) {
  console.error(`Not in the documentation:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}
console.log('docs: every key, check, setting and command documented')
