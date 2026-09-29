import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type PackageManager,
} from "@earendil-works/pi-coding-agent";

export const suitePackages = ["pisuite-pi-documentation"];

function missingPackages(manager: PackageManager, settings: SettingsManager): string[] {
	const configured = new Set<string>();
	for (const scope of ["user", "project"] as const) {
		const entries = scope === "user" ? settings.getGlobalSettings() : settings.getProjectSettings();
		for (const entry of entries.packages ?? []) {
			const source = typeof entry === "string" ? entry : entry.source;
			const npmName = source.startsWith("npm:")
				? /^((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(source.slice(4).trim())?.[1]
				: undefined;
			if (npmName) {
				configured.add(npmName);
				continue;
			}
			const installedPath = manager.getInstalledPath(source, scope);
			if (installedPath) {
				// Local and git installs also count, even if disabled.
				try {
					configured.add(JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8")).name);
				} catch (error) {
					if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				}
			}
		}
	}
	return suitePackages.filter((name) => !configured.has(name));
}

function setupState(cwd: string) {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(cwd, agentDir);
	const errors = settings.drainErrors();
	if (errors.length) throw errors[0].error;
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	return { settings, manager };
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const { manager, settings } = setupState(ctx.cwd);
		if (missingPackages(manager, settings).length) {
			ctx.ui.notify("PiSuite has packages not yet configured. Run /pisuite-setup to install them.", "info");
		}
	});

	pi.registerCommand("pisuite-setup", {
		description: "Install missing PiSuite packages, preserving existing package choices",
		handler: async (_args, ctx) => {
			const { settings, manager } = setupState(ctx.cwd);
			const missing = missingPackages(manager, settings);
			// Installation is global. Project entries count above, but project commands
			// must not override the npm command used for a global install.
			settings.setProjectTrusted(false);
			for (const name of missing) {
				ctx.ui.notify(`Installing npm:${name}...`, "info");
				await manager.installAndPersist(`npm:${name}`);
				await settings.flush();
				const errors = settings.drainErrors();
				if (errors.length) throw errors[0].error;
			}
			ctx.ui.notify(
				missing.length ? "PiSuite packages installed. Run /reload to load them." : "PiSuite is already configured.",
				"info",
			);
		},
	});
}
