# Contributing to android-mock-location-mcp

Thank you for considering contributing to android-mock-location-mcp! This document outlines how to contribute effectively.

## Code of Conduct

- Be respectful and constructive in discussions
- Focus on the problem, not the person
- Welcome newcomers and help them get started

## Getting Started

This project has two components — an **MCP server** (TypeScript/Node.js) and an **Android agent** (Kotlin/Compose). You may contribute to one or both.

### Prerequisites

**Server:**
- Node.js 18+ (tested on 18, 20, 22)
- npm

**Android:**
- Android Studio (Ladybug 2024.2+ recommended for bundled JDK 21)
- JDK 21+
- Android device or emulator (minSdk 26 / Android 8.0+)

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/android-mock-location-mcp.git
   cd android-mock-location-mcp
   ```
3. Add the upstream remote:
   ```bash
   git remote add upstream https://github.com/Manabu-GT/android-mock-location-mcp.git
   ```
4. Set up the component(s) you'll be working on:

   **Server:**
   ```bash
   cd server
   npm install
   npm run build
   ```

   **Android:**
   ```bash
   cd android
   ./gradlew assembleDebug
   ```

5. (Optional) Set up a test device — see [android/README.md](android/README.md) for device setup and mock location configuration.

## How to Contribute

### Reporting Bugs

Before creating an issue, search [existing issues](https://github.com/Manabu-GT/android-mock-location-mcp/issues) to avoid duplicates.

When ready, [file a bug report](https://github.com/Manabu-GT/android-mock-location-mcp/issues/new). Please specify which component is affected (server, Android, or both).

### Suggesting Features

Open a [feature request issue](https://github.com/Manabu-GT/android-mock-location-mcp/issues/new).

### Pull Requests

1. **Create an issue first** for significant changes to discuss the approach
2. **Branch from `main`** using the naming conventions below
3. **Keep changes focused** — one feature or fix per PR
4. **Update documentation** if needed (keep `server/README.md` and `CLAUDE.md` in sync with code changes)
5. **Run checks** before submitting:

   **Server:**
   ```bash
   cd server
   npm run build    # TypeScript typecheck + compile
   ```

   **Android:**
   ```bash
   cd android
   ./gradlew spotlessApply  # Format code (must run before check)
   ./gradlew check          # Run all checks (Spotless + Detekt)
   ```

## Branch Naming

| Prefix      | Use Case            |
|-------------|---------------------|
| `feature/`  | New features        |
| `fix/`      | Bug fixes           |
| `docs/`     | Documentation only  |
| `refactor/` | Code restructuring  |
| `test/`     | Test additions      |

Example: `feature/add-mapbox-isochrone`, `fix/socket-reconnect-crash`

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): description

[optional body]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`

**Scopes:** `server`, `android`, `protocol`

Examples:
```text
feat(server): add HERE provider for geocoding
fix(android): prevent crash when service restarts
docs: update provider configuration table
ci(release): add dry-run validation step
```

## Code Style

### Server (TypeScript)

- TypeScript strict mode, ES modules (`"type": "module"`)
- [Zod](https://zod.dev/) for MCP tool input validation (schemas in `src/index.ts`)
- Provider pattern: implement `GeocodeProvider` or `RoutingProvider` type, add case to `selectProvider()` in the respective file
- Keep `server/README.md` in sync when changing tool parameters or adding providers

### Android (Kotlin)

- Jetpack Compose for UI
- `kotlinx.serialization` for JSON
- Coroutines for async
- Run `./gradlew spotlessApply` before committing to auto-format
- Detekt for static analysis — `./gradlew check` runs both Spotless and Detekt

## Adding a New Provider

Both `server/src/geocode.ts` and `server/src/routing.ts` use the same pattern:

1. Implement the `GeocodeProvider` type (in `geocode.ts`) and/or `RoutingProvider` type (in `routing.ts`)
2. Add a case to `selectProvider()` in the respective file
3. Validate required env vars in the `selectProvider()` switch case
4. Document the new env var in `server/README.md` and `CLAUDE.md`

## Project Structure

| Directory    | Description                                                                    |
|--------------|--------------------------------------------------------------------------------|
| `server/`    | MCP server — TypeScript/Node.js, exposes 8 location tools via MCP protocol     |
| `android/`   | Android agent — Kotlin/Compose app, foreground service that sets mock locations |
| `protocol/`  | JSON protocol spec for server ↔ agent communication                            |

See [CLAUDE.md](CLAUDE.md) for detailed file-level structure and architecture notes.

## CI Workflows

Pull requests targeting `main` run the following checks automatically:

| Workflow   | Trigger                 | What it checks                          |
|------------|-------------------------|-----------------------------------------|
| Server CI  | Changes in `server/`    | Build + typecheck on Node 18, 20, 22    |
| Android CI | Changes in `android/`   | Spotless + Detekt lint, debug APK build |

Make sure the relevant CI checks pass before requesting review.

## Questions?

If you have questions, feel free to [open an issue](https://github.com/Manabu-GT/android-mock-location-mcp/issues/new).

Thank you for contributing!
