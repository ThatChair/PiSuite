# PiSuite

PiSuite is a curated collection of complementary Pi extensions and skills. Each package works on its own. Requires Pi 0.84.4 or newer.

## Install

```sh
pi install npm:pisuite-setup
```

Restart Pi, run `/pisuite-setup`, then `/reload`. Setup installs missing published packages and preserves existing entries, version pins, and `pi config` choices, including disabled packages. Reruns do nothing. After updating PiSuite, rerun setup to pick up newly added packages. Nothing is installed by PiSuite at startup.

The npm install commands become available after the packages are published.

## Packages

- [pisuite-setup](packages/pisuite/README.md): the `/pisuite-setup` command and suite package list.
- [pisuite-pi-documentation](packages/pi-documentation/README.md): moves Pi's built-in documentation instructions into the `pi-documentation` skill.

## Development

The repo root is a private npm workspace. Run `npm install --ignore-scripts` and `npm test`. Try a package with `pi -e ./packages/pi-documentation` or `pi -e ./packages/pisuite`. Setup uses published npm packages even when its own extension is loaded locally.

Release changed packages independently from `main`, using `npm publish --workspace <package-name>`. Update `packages/pisuite/index.ts` and release `pisuite-setup` when the suite package list or setup changes. Publish new standalone packages before the setup package that lists them.
