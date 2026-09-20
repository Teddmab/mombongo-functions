import { describe, it, expect } from 'vitest'
import { collectExpectedFunctionIds, renderSummary, verifyDeployment, ListedFunction } from '../verifyDeployment'

const fn = (id: string, hash = 'h1', state = 'ACTIVE', project = 'mombongo-dev'): ListedFunction => ({ id, hash, state, project })
const endpoint = () => Object.assign(() => undefined, { __endpoint: { platform: 'gcfv1' } })

describe('collectExpectedFunctionIds', () => {
  it('collects exported endpoints, expands one level of grouping, and ignores everything else', () => {
    const ids = collectExpectedFunctionIds({
      b: endpoint(),
      a: endpoint(),
      group: { inner: endpoint(), notAFunction: 42 },
      helper: () => 1,
      constant: 'x',
      nothing: null,
    })
    expect(ids).toEqual(['a', 'b', 'group-inner'])
  })
})

describe('verifyDeployment', () => {
  const project = 'mombongo-dev'

  it('passes when every intended function is ACTIVE, and counts created/updated/unchanged', () => {
    const r = verifyDeployment({
      project,
      expectedIds: ['a', 'b', 'c'],
      before: [fn('a', 'old'), fn('b', 'same')],
      after: [fn('a', 'new'), fn('b', 'same'), fn('c', 'fresh')],
    })
    expect(r).toMatchObject({ ok: true, problems: [], expected: 3, deployed: 3, active: 3, created: ['c'], updated: ['a'], unchanged: 1 })
  })

  it('fails when an intended function is missing after deploy', () => {
    const r = verifyDeployment({ project, expectedIds: ['a', 'b'], before: [fn('a')], after: [fn('a')] })
    expect(r.ok).toBe(false)
    expect(r.problems).toContain('missing after deploy: b')
  })

  it('fails when an intended function is not ACTIVE', () => {
    const r = verifyDeployment({ project, expectedIds: ['a'], before: [fn('a')], after: [fn('a', 'h', 'DEPLOY_IN_PROGRESS')] })
    expect(r.ok).toBe(false)
    expect(r.problems.join()).toContain('not ACTIVE after deploy: a (DEPLOY_IN_PROGRESS)')
  })

  it('fails if any function reports a different project, or a function disappeared', () => {
    const r = verifyDeployment({
      project,
      expectedIds: ['a'],
      before: [fn('a'), fn('gone')],
      after: [fn('a', 'h', 'ACTIVE', 'some-other-project')],
    })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/reports project some-other-project/)
    expect(r.problems.join('\n')).toMatch(/present before but gone after deploy: gone/)
  })

  it('refuses to pass when the build exposes no functions at all', () => {
    const r = verifyDeployment({ project, expectedIds: [], before: [], after: [] })
    expect(r.ok).toBe(false)
  })

  it('renders commit, project and counts, and never prints anything from the raw list', () => {
    const report = verifyDeployment({ project, expectedIds: ['a'], before: [], after: [{ ...fn('a'), ...({ environmentVariables: { SECRET: 'hunter2' }, sourceUploadUrl: 'https://signed.example/upload?sig=abc' } as object) }] })
    const md = renderSummary(report, { project, commit: 'deadbeef' })
    expect(md).toContain('verified')
    expect(md).toContain('`mombongo-dev`')
    expect(md).toContain('`deadbeef`')
    expect(md).toContain('Functions in the project after deploy: 1 (1 ACTIVE)')
    expect(md).not.toMatch(/hunter2|signed\.example|sig=abc/)
  })
})
