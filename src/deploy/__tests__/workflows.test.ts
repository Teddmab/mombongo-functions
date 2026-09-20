import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { parse } from 'yaml'

/**
 * Static guards on .github/workflows. They exist so that the safe-deployment
 * setup cannot be quietly undone: a deploy-capable workflow gaining a push/PR/
 * schedule trigger, the Firebase project becoming an input, the default-branch
 * guard or confirmations disappearing, floating tooling, or any other workflow
 * gaining a deploy command all fail here. Run from the repo root (vitest's cwd).
 */

const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows')
const DEPLOY_FILE = 'deploy-functions.yml'
const VALIDATION_FILE = 'ci.yml'
const DEFAULT_BRANCH = 'feature/s2-00-data-foundation'
const PROJECT = 'mombongo-dev'
const ENVIRONMENT = 'mombongo-functions-deploy'
const CONFIRM_PHRASE = 'DEPLOY FUNCTIONS TO MOMBONGO-DEV'

type Json = any // parsed YAML; shape is asserted below, not typed

const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))
const rawOf = (f: string) => readFileSync(join(WORKFLOWS_DIR, f), 'utf8')
const wfOf = (f: string): Json => parse(rawOf(f))
const triggersOf = (w: Json): Json => w.on ?? w[true as unknown as string]
const jobsOf = (w: Json): Record<string, Json> => w.jobs ?? {}
const stepsOf = (job: Json): Json[] => job.steps ?? []
const runsOf = (w: Json): string[] =>
  Object.values(jobsOf(w)).flatMap((j) => stepsOf(j).map((s) => s.run).filter((r): r is string => typeof r === 'string'))
const usesOf = (w: Json): string[] =>
  Object.values(jobsOf(w)).flatMap((j) => stepsOf(j).map((s) => s.uses).filter((u): u is string => typeof u === 'string'))

/** Anything that would deploy: a firebase/gcloud deploy command, the npm deploy script, a firebase-flavoured action, or --only functions. */
const DEPLOY_COMMAND = /(firebase(-tools)?\b[^\n]*\bdeploy\b|gcloud\b[^\n]*\bdeploy\b|npm run deploy\b|--only\s+functions)/i
const isDeployCapable = (f: string) => {
  const w = wfOf(f)
  return runsOf(w).some((r) => DEPLOY_COMMAND.test(r)) || usesOf(w).some((u) => /firebase/i.test(u)) || /secrets\.FIREBASE_TOKEN/.test(rawOf(f))
}
/** Every `secrets.X` reference, by job. */
const secretRefs = (job: Json) => JSON.stringify(job).match(/secrets\.[A-Za-z0-9_]+/g) ?? []

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'))

describe('all workflows', () => {
  it('finds the two expected workflows', () => {
    expect(files.sort()).toEqual([VALIDATION_FILE, DEPLOY_FILE].sort())
  })

  it('only the dedicated manual workflow can deploy (no other workflow has a deploy command, deploy action or the deploy secret)', () => {
    expect(files.filter(isDeployCapable)).toEqual([DEPLOY_FILE])
  })

  it.each(files)('%s has no schedule, tag, release or externally-triggered event that could deploy', (f) => {
    const t = triggersOf(wfOf(f))
    const events = Object.keys(typeof t === 'string' ? { [t]: 1 } : Array.isArray(t) ? Object.fromEntries(t.map((e: string) => [e, 1])) : t)
    for (const forbidden of ['schedule', 'release', 'workflow_run', 'repository_dispatch', 'create', 'deployment', 'deployment_status']) {
      expect(events).not.toContain(forbidden)
    }
  })

  it.each(files)('%s runs on the supported Node runtime only', (f) => {
    const w = wfOf(f)
    expect(w.env?.NODE_VERSION).toBe('20')
    for (const job of Object.values(jobsOf(w))) {
      for (const s of stepsOf(job).filter((x) => /^actions\/setup-node@/.test(x.uses ?? ''))) {
        expect(['${{ env.NODE_VERSION }}', '20', 20]).toContain(s.with?.['node-version'])
      }
    }
  })

  it.each(files)('%s never grants write permissions or an OIDC token', (f) => {
    expect(JSON.stringify(wfOf(f).permissions ?? {}) + JSON.stringify(Object.values(jobsOf(wfOf(f))).map((j) => j.permissions ?? {}))).not.toMatch(/write|id-token/)
  })

  it.each(files)('%s checks out without persisting credentials', (f) => {
    for (const job of Object.values(jobsOf(wfOf(f)))) {
      for (const s of stepsOf(job).filter((x) => /^actions\/checkout@/.test(x.uses ?? ''))) {
        expect(s.with?.['persist-credentials']).toBe(false)
      }
    }
  })

  it('the repo supports exactly Node 20', () => {
    expect(pkg.engines.node).toBe('20')
  })
})

describe(`${VALIDATION_FILE} (validation only)`, () => {
  const w = wfOf(VALIDATION_FILE)
  const raw = rawOf(VALIDATION_FILE)

  it('runs for pull requests and pushes to the actual default branch, and nothing else', () => {
    const t = triggersOf(w)
    expect(Object.keys(t).sort()).toEqual(['pull_request', 'push'])
    expect(t.pull_request.branches).toEqual([DEFAULT_BRANCH])
    expect(t.push.branches).toEqual([DEFAULT_BRANCH])
  })

  it('is read-only workflow-wide and no job widens it', () => {
    expect(w.permissions).toEqual({ contents: 'read' })
    for (const job of Object.values(jobsOf(w))) expect(job.permissions).toBeUndefined()
  })

  it('references no secret and no deployment credential, has no environment, and contains no deploy command', () => {
    expect(raw).not.toMatch(/secrets\./)
    expect(raw).not.toMatch(/FIREBASE_TOKEN/)
    for (const job of Object.values(jobsOf(w))) expect(job.environment).toBeUndefined()
    for (const r of runsOf(w)) expect(r).not.toMatch(DEPLOY_COMMAND)
    expect(raw).not.toMatch(/firebase deploy|firebase-tools/i)
  })

  it('validates with locked installs, typecheck, the full test suite and build', () => {
    const runs = runsOf(w)
    expect(runs).toEqual(expect.arrayContaining(['npm ci', 'npm run typecheck', 'npm test', 'npm run build']))
    expect(runs.some((r) => /npm install/.test(r))).toBe(false)
  })
})

describe(`${DEPLOY_FILE} (manual deploy)`, () => {
  const w = wfOf(DEPLOY_FILE)
  const raw = rawOf(DEPLOY_FILE)
  const jobs = jobsOf(w)
  const allRuns = runsOf(w)
  const deployLines = allRuns.flatMap((r) => r.split('\n')).filter((l) => DEPLOY_COMMAND.test(l))

  it('is triggered by workflow_dispatch and nothing else', () => {
    const t = triggersOf(w)
    expect(Object.keys(t)).toEqual(['workflow_dispatch'])
    expect(raw).not.toMatch(/^\s*(push|pull_request|pull_request_target|schedule|tags|branches)\s*:/m)
  })

  it('has exactly two required string inputs and the Firebase project is not one of them', () => {
    const inputs = triggersOf(w).workflow_dispatch.inputs
    expect(Object.keys(inputs).sort()).toEqual(['confirm_phrase', 'confirm_project'])
    for (const i of Object.values<Json>(inputs)) {
      expect(i.required).toBe(true)
      expect(i.type).toBe('string')
    }
  })

  it('uses inputs only for the two confirmations, and only inside the guard job', () => {
    const exprs = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').match(/\$\{\{[^}]*\binputs\.[^}]*\}\}/g) ?? []
    expect(exprs.map((e) => e.replace(/\s+/g, ' ')).sort()).toEqual(['${{ inputs.confirm_phrase }}', '${{ inputs.confirm_project }}'])
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== 'guard') expect(JSON.stringify(job)).not.toMatch(/inputs\./)
    }
  })

  it(`targets the fixed literal project ${PROJECT}, on every firebase command, never a variable`, () => {
    expect(w.env.FIREBASE_PROJECT).toBe(PROJECT)
    const firebaseCalls = allRuns.flatMap((r) => r.split('\n')).filter((l) => /node_modules\/\.bin\/firebase\s+(deploy|functions:list)/.test(l))
    expect(firebaseCalls).toHaveLength(3) // inventory before, deploy, inventory after
    for (const line of firebaseCalls) {
      expect(line).toMatch(new RegExp(`--project ${PROJECT}(\\s|$)`))
    }
    for (const r of allRuns) for (const m of r.matchAll(/--project\s+(\S+)/g)) expect(m[1]).toBe(PROJECT)
    expect(raw).not.toMatch(/GCLOUD_PROJECT|GOOGLE_CLOUD_PROJECT|FIREBASE_PROJECT_ID/)
  })

  it('refuses anything but a manual dispatch from the default branch, and checks both confirmations exactly', () => {
    expect(w.env.DEFAULT_BRANCH).toBe(DEFAULT_BRANCH)
    const guardRuns = stepsOf(jobs.guard).map((s) => s.run ?? '').join('\n')
    expect(guardRuns).toMatch(/\[ "\$EVENT_NAME" = "workflow_dispatch" \]/)
    expect(guardRuns).toMatch(/\[ "\$REF_TYPE" = "branch" \]/)
    expect(guardRuns).toMatch(/\[ "\$REF" = "refs\/heads\/\$DEFAULT_BRANCH" \]/)
    expect(guardRuns).toMatch(/\[ "\$CONFIRM_PROJECT" = "\$FIREBASE_PROJECT" \]/)
    expect(guardRuns).toContain(`[ "$CONFIRM_PHRASE" = "${CONFIRM_PHRASE}" ]`)
  })

  it('requires the dispatched commit to equal the live remote tip, in the guard and again right before deploying', () => {
    const tipCheck = /gh api "repos\/\$REPO\/git\/ref\/heads\/\$DEFAULT_BRANCH"/
    expect(stepsOf(jobs.guard).map((s) => s.run ?? '').join('\n')).toMatch(tipCheck)
    expect(stepsOf(jobs.deploy).map((s) => s.run ?? '').join('\n')).toMatch(tipCheck)
    // and every job works on the pinned sha, not on whatever the ref becomes
    for (const name of ['validate', 'deploy']) {
      const checkout = stepsOf(jobs[name]).find((s) => /^actions\/checkout@/.test(s.uses ?? ''))
      expect(checkout.with.ref).toBe('${{ needs.guard.outputs.sha }}')
    }
  })

  it('orders guard -> validate -> deploy, and validates with tests, typecheck and build before the deploy job starts', () => {
    expect(jobs.validate.needs).toBe('guard')
    expect([...jobs.deploy.needs].sort()).toEqual(['guard', 'validate'])
    const v = runsOf({ jobs: { validate: jobs.validate } })
    expect(v).toEqual(expect.arrayContaining(['npm ci', 'npm run typecheck', 'npm test', 'npm run build']))
  })

  it('runs the deploy job under the dedicated environment, and no other job', () => {
    expect(jobs.deploy.environment).toBe(ENVIRONMENT)
    expect(jobs.guard.environment).toBeUndefined()
    expect(jobs.validate.environment).toBeUndefined()
  })

  it('exposes the deployment credential only to steps of the final deploy job', () => {
    expect(secretRefs(jobs.guard)).toEqual([])
    expect(secretRefs(jobs.validate)).toEqual([])
    expect(new Set(secretRefs(jobs.deploy))).toEqual(new Set(['secrets.FIREBASE_TOKEN']))
    // never workflow-level or job-level env, never inline in a script
    expect(JSON.stringify(w.env)).not.toMatch(/secrets\./)
    expect(JSON.stringify(jobs.deploy.env ?? {})).not.toMatch(/secrets\./)
    for (const s of stepsOf(jobs.deploy)) expect(s.run ?? '').not.toMatch(/secrets\./)
    // the step that loads project code to verify has no credential
    const verify = stepsOf(jobs.deploy).find((s) => /verifyDeployment/.test(s.run ?? ''))
    expect(JSON.stringify(verify.env ?? {})).not.toMatch(/FIREBASE_TOKEN|secrets\./)
  })

  it('is read-only by default and per job', () => {
    expect(w.permissions).toEqual({})
    for (const j of Object.values<Json>(jobs)) expect(j.permissions).toEqual({ contents: 'read' })
  })

  it('deploys Functions only: one deploy command, --only functions, no rules/indexes/storage/hosting/force', () => {
    expect(deployLines).toHaveLength(1)
    const cmd = deployLines[0]
    expect(cmd).toMatch(/node_modules\/\.bin\/firebase deploy --only functions( |$)/)
    for (const r of allRuns) {
      expect(r).not.toMatch(/firestore|storage|hosting|indexes|rules|extensions|database|--force|--only\s+\S*,/i)
    }
    expect(allRuns.every((r) => !/--only\s+(?!functions(\s|$))/.test(r))).toBe(true)
  })

  it('uses only the pinned, lockfile-installed Firebase CLI — no floating tooling', () => {
    const version = pkg.devDependencies['firebase-tools']
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lock.packages['node_modules/firebase-tools'].version).toBe(version)
    for (const r of allRuns) {
      expect(r).not.toMatch(/\bnpx\b|firebase-tools@|npm (i|install)\b|-g\b|@latest|\blatest\b|curl|wget/)
    }
    expect(allRuns.filter((r) => /npm ci/.test(r)).length).toBeGreaterThanOrEqual(2)
    for (const l of allRuns.flatMap((r) => r.split('\n')).filter((l) => /\bfirebase\b/.test(l) && !/^\s*(#|echo|\[|expected=|actual=|.*::error)/.test(l))) {
      expect(l).toMatch(/\.\/node_modules\/\.bin\/firebase/)
    }
  })

  it('pins third-party actions to full commit SHAs', () => {
    for (const u of usesOf(w)) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  it('fails closed when the credential or the pinned tool is missing', () => {
    expect(raw).toMatch(/\[ -n "\$\{FIREBASE_TOKEN:-\}" \]/)
    expect(raw).toMatch(/\[ -x \.\/node_modules\/\.bin\/firebase \]/)
    expect(raw).toMatch(/set -euo pipefail/)
  })
})
