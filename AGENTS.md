# PiSuite

PiSuite is a curated public collection of complementary Pi extensions and skills. Each package works on its own. The package structure below is planned; inspect the current repo before editing.

## Core behavior

- `/pisuite-setup` installs missing published packages only. Preserve existing package entries and `pi config` choices, including disabled packages; reruns do nothing. When the suite gains a package, remind users to rerun setup; never install it at startup.
- Enable extensions and skills by default. Those requiring configuration stay inactive until configured and explain setup if invoked.
- Aim for one `pi config` toggle per extension or skill package. Expose any tied skills or prompts from one extension entry point via `resources_discover`; expose a lone skill directly. Verify all parts turn off together.

## Common pitfalls

- Do not load extensions from individual packages in the main PiSuite package; a separate install could register duplicate tools or handlers.

## Working in this repo

- Use a private npm workspace at the repo root. Put the published setup package in `packages/pisuite/` and standalone packages in `packages/<name>/`. Use one public naming prefix.
- Each package owns its manifest, dependencies, configuration, and tests.
- Check installed Pi docs and examples before changing Pi APIs; use `pi-documentation` when available.

## Verification and releases

- Test each package alone. Test setup with clean Pi settings and with a disabled package already listed. Confirm one `pi config` toggle disables each package. Test published contents and install commands against current Pi.
- Release changed packages deliberately from `main` with independent versions. Update the main PiSuite package when its package list or setup changes.

## Documentation

The root README links to packages. Package READMEs cover purpose, install, use, configuration, and minimum Pi version. Document `pi install npm:<pisuite-package>`, restart, `/pisuite-setup`, then reload. `pi-documentation` is a skill moving existing guidance out of the system prompt for relevant tasks.
