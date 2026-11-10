# Releasing

A release is a version in `package.json`, a matching entry in `CHANGELOG.md`, and a merge to `main`. Nothing is
triggered by hand.

## Cutting a release

1. On your branch, run the `changelog` skill (or do its steps by hand, see [CONTRIBUTING.md](../CONTRIBUTING.md)).
   It bumps `package.json`, `package-lock.json` and `CHANGELOG.md` together and commits them.
2. Open the pull request. CI checks that the version matches the changelog and that no release has used it yet.
3. Merge it. [`release.yaml`](../.github/workflows/release.yaml) then:
   - runs the whole test workflow on the merged commit;
   - if there is no release `vX.Y.Z` yet, builds the `.vsix`, tags `vX.Y.Z` and publishes a GitHub release with the
     changelog entry as its notes and the `.vsix` attached;
   - if Marketplace publishing is switched on (below), publishes that same `.vsix` there.

A merge that does not change `src/` or `package.json` (docs, tests, CI) releases nothing: the version already has a
release, so the workflow stops after the tests.

## Publishing to the VS Code Marketplace

Off until you opt in, because it publishes to the world. It uses the Marketplace's *trusted publishing*: the workflow
proves to the Marketplace that it is this repository's `release.yaml` (an OIDC token from GitHub), so there is no
token to create, store or renew.

1. **Publisher.** The `publisher` in `package.json` (`albertobaraza`) must be one you own at
   <https://marketplace.visualstudio.com/manage>.
2. **Policy.** On that publisher open the *Trusted Publishing* tab > *Create*: Provider *GitHub Actions*, Repository
   owner `albertobaraza`, Repository `claude-limits-meter`, Workflow `release.yaml` (the file holding the `publish`
   job), Environment empty. If you fill the environment in, the `publish` job must declare the same `environment:`.
3. **Switch publishing on:**

   ```bash
   gh variable set PUBLISH_TO_MARKETPLACE --body true
   ```

4. The next release is published to the Marketplace after its GitHub release. To retry a failed publish, run the
   *Release* workflow by hand on `main` (`gh workflow run release.yaml`): it skips the GitHub release that already
   exists and publishes unless that version is already on the Marketplace.

To stop publishing, set `PUBLISH_TO_MARKETPLACE` to anything but `true`.

Both release jobs run only on `main` (`github.ref == 'refs/heads/main'`), so a manual run of the workflow on another branch
stops after the tests. The policy above does not look at the branch, and an empty Environment accepts any run of
`release.yaml`: for a second lock, create a GitHub environment (for example `marketplace`) limited to `main`, fill in the
policy's *Environment* with its name and add the same `environment:` to the `publish` job.

## Before the first public release

- Make the repository public (the README, issue and homepage links in the listing point at it) and run
  `scripts/protect-main.sh --apply`, which GitHub only allows on a public repository on a free account.
- The commits carry the author e-mail you committed with; they become public with the repository.
- Add an `icon` (a 128x128 PNG, not Anthropic's logo) to `package.json` and the package.
- The Marketplace page shows `README.md` and `CHANGELOG.md` as they are in the `.vsix`.

## If a release is wrong

Versions are never reused. Delete the bad GitHub release and its tag only if nothing was published from it; on the
Marketplace use *Unpublish* only for a security problem. Otherwise fix forward with a new patch version.
