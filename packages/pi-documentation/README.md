# pisuite-pi-documentation

Moves Pi's built-in documentation instructions out of the system prompt and into an on-demand `pi-documentation` skill. Requires Pi 0.84.4 or newer. No configuration is needed.

## Install and use

```sh
pi install npm:pisuite-pi-documentation
```

Restart Pi or run `/reload`. For Pi questions and integration work, the agent can read the skill automatically. Run `/skill:pi-documentation` to load it explicitly. Only the skill's name, description, and location stay in the system prompt; its full guidance loads when needed.

Alternatively, install `npm:pisuite-setup`, restart Pi, run `/pisuite-setup`, then `/reload`.

The npm commands require the packages to be published. For local development, use `pi -e ./packages/pi-documentation` from the repository root.

## Configuration

The extension exposes its skill through `resources_discover`, using a temporary copy with documentation paths from the running Pi host. It removes that copy when the session shuts down. In `pi config`, toggle this package's single `index.ts` entry, then `/reload`. Disabling it removes the skill and restores Pi's built-in documentation guidance together.

Custom system prompts and explicit documentation section overrides are preserved. On older Pi releases, the extension removes only the recognized built-in documentation block. If that block changes, it leaves the prompt intact.

## Verification

Run `npm test --workspace pisuite-pi-documentation` from the repository root. Tests check prompt preservation and Pi's actual resource discovery with the package enabled and disabled.
