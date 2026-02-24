# Contributing to android-mock-location-mcp

Thank you for considering contributing to android-mock-location-mcp! This document outlines how to contribute effectively.

## Code of Conduct

- Be respectful and constructive in discussions
- Focus on the problem, not the person
- Welcome newcomers and help them get started

## Getting Started

### Prerequisites

- Node.js 18+ (tested on 18, 20, 22)
- npm
- Android SDK Platform Tools (for `adb`)
- Android emulator

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
4. Set up the server:
   ```bash
   cd server
   npm install
   npm run build
   ```

## How to Contribute

### Reporting Bugs

Before creating an issue, search [existing issues](https://github.com/Manabu-GT/android-mock-location-mcp/issues) to avoid duplicates.

When ready, [file a bug report](https://github.com/Manabu-GT/android-mock-location-mcp/issues/new).

### Suggesting Features

Open a [feature request issue](https://github.com/Manabu-GT/android-mock-location-mcp/issues/new).

### Pull Requests

1. **Create an issue first** for significant changes to discuss the approach
2. **Branch from `main`** using the naming conventions below
3. **Keep changes focused** — one feature or fix per PR
4. **Update documentation** if needed (keep `server/README.md` and `CLAUDE.md` in sync with code changes)
5. **Run checks** before submitting:
   ```bash
   cd server
   npm run build    # TypeScript typecheck + compile
   npm test         # Run tests
   ```

## Branch Naming

| Prefix      | Use Case            |
|-------------|---------------------|
| `feature/`  | New features        |
| `fix/`      | Bug fixes           |
| `docs/`     | Documentation only  |
| `refactor/` | Code restructuring  |
| `test/`     | Test additions      |

Example: `feature/add-mapbox-isochrone`, `fix/nmea-checksum-error`

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): description

[optional body]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`

**Scope:** `server`

Examples:
```text
feat(server): add HERE provider for geocoding
fix(server): correct NMEA checksum calculation
docs: update provider configuration table
```

## Code Style

### Server (TypeScript)

- TypeScript strict mode, ES modules (`"type": "module"`)
- [Zod](https://zod.dev/) for MCP tool input validation (schemas in `src/index.ts`)
- Provider pattern: implement `GeocodeProvider` or `RoutingProvider` type, add case to `selectProvider()` in the respective file
- Keep `server/README.md` in sync when changing tool parameters or adding providers

## Adding a New Provider

Both `server/src/geocode.ts` and `server/src/routing.ts` use the same pattern:

1. Implement the `GeocodeProvider` type (in `geocode.ts`) and/or `RoutingProvider` type (in `routing.ts`)
2. Add a case to `selectProvider()` in the respective file
3. Validate required env vars in the `selectProvider()` switch case
4. Document the new env var in `server/README.md` and `CLAUDE.md`

## Project Structure

| Directory    | Description                                                                |
|--------------|----------------------------------------------------------------------------|
| `server/`    | MCP server — TypeScript/Node.js, exposes 9 location tools via MCP protocol |

See [CLAUDE.md](CLAUDE.md) for detailed file-level structure and architecture notes.

## CI Workflows

Pull requests targeting `main` run the following checks automatically:

| Workflow   | Trigger                 | What it checks                          |
|------------|-------------------------|-----------------------------------------|
| Server CI  | Changes in `server/`    | Build + typecheck on Node 18, 20, 22    |

Make sure the CI checks pass before requesting review.

## Questions?

If you have questions, feel free to [open an issue](https://github.com/Manabu-GT/android-mock-location-mcp/issues/new).

Thank you for contributing!
