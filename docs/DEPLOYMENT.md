# Deploying Mombongo Functions

## What you are deploying to

There is **one** Firebase project, `mombongo-dev`. There is no separate staging or
production project. It serves **real users and test-mode partners** (partner
test traffic is separated by a `testMode` flag on the data, not by a different
project). A Functions deploy here reaches live users.

For that reason the deploy target is a fixed literal in the workflow, is never an
input, and there is deliberately no dev/prod selector.

## What runs automatically

`.github/workflows/ci.yml` — **validation only**, on pull requests and on pushes
to the default branch (`feature/s2-00-data-foundation`; this repo has no
`main`/`dev`):

- `npm ci` (locked install), Node 20
- `npm run typecheck`
- `npm test` — the full suite, which includes the static checks on the workflows
  themselves (`src/deploy/__tests__/workflows.test.ts`)
- `npm run build`

No lint is configured in this repo, so none runs. The workflow has read-only
permissions and no access to any secret or deployment credential.

**Nothing deploys automatically.** No push, pull request, tag or schedule can
deploy Functions.

## How to deploy (manual only)

`.github/workflows/deploy-functions.yml` has exactly one trigger,
`workflow_dispatch`.

1. GitHub → Actions → **Deploy Functions (mombongo-dev, manual only)** → *Run workflow*.
2. Choose the default branch `feature/s2-00-data-foundation`. Any other branch,
   tag or pull-request ref is refused.
3. Type both confirmations exactly:
   - `confirm_project`: `mombongo-dev`
   - `confirm_phrase`: `DEPLOY FUNCTIONS TO MOMBONGO-DEV`

Equivalent from a terminal:

```bash
gh workflow run deploy-functions.yml --ref feature/s2-00-data-foundation \
  -f confirm_project=mombongo-dev \
  -f confirm_phrase="DEPLOY FUNCTIONS TO MOMBONGO-DEV"
```

What the run does, in order:

1. **Guard** (no credentials): manual dispatch, default-branch ref, both
   confirmations exact, and the dispatched commit equals the *live* tip of the
   remote default branch.
2. **Validate** (no credentials): locked install, checks that the pinned Firebase
   CLI is installed from the lockfile, typecheck, full tests, build.
3. **Deploy** (the only job with the credential, under the
   `mombongo-functions-deploy` environment): re-checks the commit is still the tip,
   inventories the project, runs
   `firebase deploy --only functions --project mombongo-dev`, inventories again.
4. **Verify**: compares the functions the build exports against the project and
   fails unless every one exists and is `ACTIVE`. The run summary reports the
   deployed commit, project, function count and created/updated/unchanged counts.
   It never prints the raw inventory (which also contains environment variables and
   signed upload URLs) or any credential.

The workflow deploys **Functions only**. It never deploys Firestore rules, Storage
rules or indexes.

Node is pinned to 20, and the Firebase CLI is pinned to an exact version in
`package.json` (`firebase-tools`) and installed from the lockfile — never `npx`
or `latest`. If the pinned tool is missing the run fails before deploying.

## Owner setup (one-time, after merging the workflow change)

The workflow references an environment and a secret; it does not create or move
either. Until you do these, treat deploys as not yet gated.

1. **Create the environment first.** Settings → Environments → *New environment* →
   `mombongo-functions-deploy`. If a run references an environment that does not
   exist, GitHub silently creates it with **no protection at all**, so create it
   before the first dispatch.
2. **Restrict deployment branches** on that environment to *Selected branches* →
   `feature/s2-00-data-foundation` only.
3. **Require reviewers** and enable **Prevent self-review** (available on this
   repo: it is public and the owner account is on Pro). If you are the only
   collaborator, prevent-self-review cannot be satisfied by anyone else; in that
   case the safeguards are the manual dispatch, the environment's branch
   restriction and the double confirmation.
4. **Scope the credential.** Add `FIREBASE_TOKEN` as an *environment secret* on
   `mombongo-functions-deploy` (the workflow already uses that exact name), run
   one deploy, and confirm it succeeds from the environment secret.
5. **Only then remove the repository-wide `FIREBASE_TOKEN`.** A repository secret
   is readable by any workflow in the repo; the environment secret is released only
   to the gated deploy job. Do not delete the repository secret before step 4 has
   been proven — it is your fallback.

`FIREBASE_TOKEN` is a long-lived `firebase login:ci` refresh token. Moving to a
narrowly-scoped service account is a worthwhile later hardening; it is out of scope
here and no credential is rotated by this change.

## History: the old "Manual Approval" gate did not gate anything

The previous `production.yml` deployed **all Functions on every push to the default
branch**, i.e. on every merge. It had an `approval-gate` job bound to a GitHub
environment named `production`, and its comments and log line said deployment was
"approved by required reviewers". That environment had **no protection rules and no
reviewers**, so the job passed in about two seconds and no human approved anything.
Any statement elsewhere that this repo's deploy is gated behind reviewer approval
describes intent, not what actually happened, and is superseded by this document.

## Rollback

- Functions here are first-generation: there are no traffic-splitting revisions to
  switch back to.
- Rollback means **redeploying earlier code**: revert the change on the default
  branch through a normal PR, merge it, then dispatch the deploy workflow.
- Rollback restores **code only**. It does not revert Firestore or Storage data,
  and it cannot revoke anything already issued (for example short-lived signed
  URLs stay valid until they expire).

## Indexes and rules are a separate, deliberate process

`firestore.indexes.json` and `firestore.rules` are **not** deployed by the workflow
above, on purpose. Index builds take minutes and queries fail until they finish;
rules changes affect every client. Ship them as their own reviewed change with an
explicit, separate `firebase deploy --only firestore:indexes` (or `firestore:rules`)
run by the owner, never as a side effect of a Functions deploy.
(`mombongo-functions` is the sole owner of `firestore.rules`.)

## The local `npm run deploy` script

`package.json` still has a `deploy` script (`firebase deploy --only functions`,
run with whatever CLI and login is on your machine). It is manual and is not part of
CI, but it bypasses every safeguard above. Treat it as break-glass only, from a
merged commit. Removing it is a reasonable follow-up.

## Verifying that nothing deployed

- Actions tab: the only workflow that can deploy is *Deploy Functions (mombongo-dev,
  manual only)*, and it appears only after someone dispatches it.
- Project side (read-only):
  `gcloud functions list --project mombongo-dev --format="value(name.basename(),updateTime)"`
  — `updateTime` values should not change after a merge that only ran validation.
