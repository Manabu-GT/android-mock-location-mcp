# Publishing

## npm

The MCP server is published as `android-mock-location-mcp` on npm.

### Prerequisites

- npm account with publish access
- Logged in: `npm login`

### Steps

```bash
cd server
npm run build
npm publish --access public
```

### Version bump

Update `version` in `server/package.json` before publishing:

```bash
cd server
npm version patch   # or minor / major
```

## GitHub Release

Tag-based releases trigger CI to build the APK and publish to npm.

```bash
git tag v0.1.0
git push --tags
```

The `release.yml` workflow:
1. Builds the server and publishes to npm
2. Builds the Android APK (`assembleRelease`)
3. Attaches the APK to the GitHub release

### Manual release

If CI is not configured, create a release manually:

1. Build the APK: `cd android && ./gradlew assembleRelease`
2. Go to GitHub → Releases → "Draft a new release"
3. Tag: `v0.1.0`, attach the APK, publish
