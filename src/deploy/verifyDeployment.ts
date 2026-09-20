import * as fs from 'fs'

/**
 * Post-deploy verification for .github/workflows/deploy-functions.yml.
 *
 * Compares what the built code exports (the functions this deploy intends to
 * exist) against `firebase functions:list --json` taken before and after, and
 * fails if any intended function is missing or not ACTIVE. Prints only ids,
 * counts, commit and project — never the raw list, which also carries
 * environment variables and signed source-upload URLs.
 */

export interface ListedFunction {
  id: string
  state?: string
  hash?: string
  project?: string
}

export interface VerifyInput {
  expectedIds: string[]
  before: ListedFunction[]
  after: ListedFunction[]
  project: string
}

export interface VerifyReport {
  ok: boolean
  problems: string[]
  expected: number
  deployed: number
  active: number
  created: string[]
  updated: string[]
  unchanged: number
}

/** A firebase-functions v1/v2 export carries `__endpoint`; one level of grouping ("group-name") is expanded like the CLI does. */
export function collectExpectedFunctionIds(exportsObj: Record<string, unknown>): string[] {
  const ids: string[] = []
  const isEndpoint = (v: unknown) => typeof v === 'function' && !!(v as { __endpoint?: unknown }).__endpoint
  for (const [name, value] of Object.entries(exportsObj)) {
    if (isEndpoint(value)) {
      ids.push(name)
    } else if (value && typeof value === 'object') {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (isEndpoint(innerValue)) ids.push(`${name}-${inner}`)
      }
    }
  }
  return ids.sort()
}

export function verifyDeployment(input: VerifyInput): VerifyReport {
  const { expectedIds, before, after, project } = input
  const problems: string[] = []
  const afterById = new Map(after.map((f) => [f.id, f]))
  const beforeById = new Map(before.map((f) => [f.id, f]))

  if (expectedIds.length === 0) problems.push('no functions were found in the built code, so nothing can be verified')
  for (const id of expectedIds) {
    const f = afterById.get(id)
    if (!f) problems.push(`missing after deploy: ${id}`)
    else if (f.state !== 'ACTIVE') problems.push(`not ACTIVE after deploy: ${id} (${f.state ?? 'no state'})`)
  }
  for (const f of after) {
    if (f.project && f.project !== project) problems.push(`function ${f.id} reports project ${f.project}, expected ${project}`)
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) problems.push(`present before but gone after deploy: ${id}`)
  }

  const created = after.filter((f) => !beforeById.has(f.id)).map((f) => f.id).sort()
  const updated = after
    .filter((f) => beforeById.has(f.id) && beforeById.get(f.id)!.hash !== f.hash)
    .map((f) => f.id)
    .sort()

  return {
    ok: problems.length === 0,
    problems,
    expected: expectedIds.length,
    deployed: after.length,
    active: after.filter((f) => f.state === 'ACTIVE').length,
    created,
    updated,
    unchanged: after.length - created.length - updated.length,
  }
}

export function renderSummary(report: VerifyReport, ctx: { project: string; commit: string }): string {
  const lines = [
    `## Functions deploy ${report.ok ? 'verified' : 'FAILED verification'}`,
    '',
    `- Project: \`${ctx.project}\``,
    `- Commit: \`${ctx.commit}\``,
    `- Functions in this build: ${report.expected}`,
    `- Functions in the project after deploy: ${report.deployed} (${report.active} ACTIVE)`,
    `- Created: ${report.created.length} · Updated: ${report.updated.length} · Unchanged: ${report.unchanged}`,
  ]
  if (report.created.length) lines.push(`- Created ids: ${report.created.join(', ')}`)
  if (report.problems.length) lines.push('', '### Problems', ...report.problems.map((p) => `- ${p}`))
  return lines.join('\n') + '\n'
}

function readList(path: string): ListedFunction[] {
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as { result?: ListedFunction[] } | ListedFunction[]
  const list = Array.isArray(parsed) ? parsed : parsed.result
  if (!Array.isArray(list)) throw new Error(`${path} is not a functions:list --json result`)
  return list.map((f) => ({ id: f.id, state: f.state, hash: f.hash, project: f.project }))
}

function main(): void {
  const args = process.argv.slice(2)
  const arg = (name: string): string => {
    const i = args.indexOf(`--${name}`)
    if (i === -1 || !args[i + 1]) throw new Error(`missing --${name}`)
    return args[i + 1]
  }
  const project = arg('project')
  const commit = arg('commit')

  // Loading the built index is exactly what the Firebase CLI does to discover
  // functions; it makes no network calls, but firebase-admin wants a project.
  process.env.GCLOUD_PROJECT ??= project
  process.env.FIREBASE_CONFIG ??= JSON.stringify({ projectId: project })
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const built = require('../index') as Record<string, unknown>

  const report = verifyDeployment({
    expectedIds: collectExpectedFunctionIds(built),
    before: readList(arg('before')),
    after: readList(arg('after')),
    project,
  })
  const summary = renderSummary(report, { project, commit })
  process.stdout.write(summary)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (!report.ok) process.exit(1)
}

if (require.main === module) main()
