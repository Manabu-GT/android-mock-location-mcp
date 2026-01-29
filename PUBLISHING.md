# Publishing

Server and Android releases are independent — each has its own GitHub Actions workflow, version, and git tag.

## Release Process

### Server (npm)

The MCP server is published as [`android-mock-location-mcp`](https://www.npmjs.com/package/android-mock-location-mcp) on npm.

**Steps:**

1. Update `version` in `server/package.json` to the new version (e.g., `"0.2.0"`)
2. Commit and push to `main`:
   ```bash
   cd server
   npm version 0.2.0 --no-git-tag-version
   cd ..
   git add server/package.json server/package-lock.json
   git commit -m "chore(server): bump version to 0.2.0"
   git push
   ```
3. Go to **Actions → Release Server → Run workflow**
4. Enter the same version (e.g., `0.2.0`) and click **Run workflow**
   - Use **Dry run** first to validate without publishing

The workflow will:
1. Validate the version format and verify `package.json` matches
2. Build and publish to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) (OIDC trusted publishing — no npm token needed)
3. Create git tag `server-v0.2.0` and a GitHub Release with auto-generated notes

### Android (APK)

**Steps:**

1. Update `versionName` in `android/app/build.gradle.kts` (`versionCode` is auto-derived — see [Version Files](#version-files))
2. Commit and push to `main`:
   ```bash
   git add android/app/build.gradle.kts
   git commit -m "chore(android): bump version to 0.2.0"
   git push
   ```
3. Go to **Actions → Release Android → Run workflow**
4. Enter the same version (e.g., `0.2.0`) and click **Run workflow**
   - Use **Dry run** first to validate without releasing

The workflow will:
1. Validate the version format and verify `build.gradle.kts` matches
2. Build the release APK
3. Create git tag `android-v0.2.0` and a GitHub Release with the APK attached as `android-mock-location-mcp-agent.apk`

## Version Files

| Component | File                           | Field         |
|-----------|--------------------------------|---------------|
| Server    | `server/package.json`          | `"version"`   |
| Android   | `android/app/build.gradle.kts` | `versionName` |

`versionCode` is automatically derived from `versionName` using the formula `major * 10000 + minor * 100 + patch` (e.g., `0.2.0` → `200`, `1.0.0` → `10000`). Only `versionName` needs to be updated manually.

Before triggering a release workflow, update the relevant version file for that component. The CI validates that the version in the file matches the workflow input to prevent mismatches.

## Tag Format

- Server: `server-v{version}` (e.g., `server-v0.2.0`)
- Android: `android-v{version}` (e.g., `android-v0.2.0`)

## CI Workflows

| Workflow        | File                  | Trigger                             | Purpose                                    |
|-----------------|-----------------------|-------------------------------------|--------------------------------------------|
| Server CI       | `server-ci.yml`       | Push/PR to `main` (server changes)  | Build + typecheck on Node 18/20/22         |
| Android CI      | `android-ci.yml`      | Push/PR to `main` (android changes) | Lint (Spotless + Detekt) + build debug APK |
| Release Server  | `server-release.yml`  | Manual dispatch                     | Publish to npm + GitHub Release            |
| Release Android | `android-release.yml` | Manual dispatch                     | Build release APK + GitHub Release         |

Release workflows are restricted to the repository owner.

## npm Trusted Publishing

The server release uses npm's OIDC trusted publishing (`--provenance` flag). This means:
- No `NPM_TOKEN` secret is needed
- npm verifies the package was built by this GitHub Actions workflow
- Published packages show a verified provenance badge on npmjs.com

**Setup**: Link the npm package to this GitHub repository in npm's package settings under "Publishing access" → "Trusted publishing".
