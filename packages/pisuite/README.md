# pisuite-setup

Installs missing published packages in PiSuite. Requires Pi 0.84.4 or newer. No configuration is needed.

## Install and use

```sh
pi install npm:pisuite-setup
```

Restart Pi, run `/pisuite-setup`, then `/reload`. Rerun setup after updating PiSuite to install newly listed packages. PiSuite reminds you when a package is missing but never installs anything at startup.

The npm commands require the packages to be published. For local development, use `pi -e ./packages/pisuite` from the repository root. Setup still installs standalone packages from npm.

## Configuration

Setup adds missing packages to global Pi settings. Packages already listed in global or project settings are left alone, including pinned versions, filters, and disabled entries. Local or git installs whose manifest names match a standalone package also count as configured. Existing entries are skipped even if their installation is missing from disk. Setup does not repair or update them.

Invalid settings or unreadable package manifests suppress the startup reminder. Explicit setup reports the error and leaves package entries unchanged.

Use `pi config` to toggle setup's single `index.ts` entry. Each standalone package has its own toggle; the setup package does not load their extensions or bundle them as dependencies.

## Included packages

- [pisuite-pi-documentation](../pi-documentation/README.md)
- [pisuite-subagents](../subagents/README.md) (requires Pi 0.99.1 or newer)

## Verification and releases

Run `npm test --workspace pisuite-setup` from the repository root. Tests cover clean settings, reruns, disabled and pinned entries, project overrides, and startup behavior.

Maintain the package list in `index.ts`. Publish new standalone packages first, then release a new setup version from `main`. Package versions are independent.
