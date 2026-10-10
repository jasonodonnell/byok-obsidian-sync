import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, moment, normalizePath } from "obsidian";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

interface ByokSettings {
	/** Vault folder that device projects are synced into. */
	targetFolder: string;
	/** Extension used for synced notes in the vault (device files are .txt). */
	extension: "md" | "txt";
	/** Explicit mount path; empty means auto-detect. */
	mountPath: string;
	/** Sync every project on the device; when false only `projects` are synced. */
	syncAllProjects: boolean;
	/** Project names to sync when `syncAllProjects` is false. */
	projects: string[];
	/** Rewrite the device's space indentation using Obsidian's indent setting. */
	convertIndent: boolean;
	/** Number of spaces the device writes for one Tab press. */
	deviceTabSize: number;
}

interface ByokData {
	settings: ByokSettings;
	/** Vault path -> hash of the device content last written there. */
	synced: Record<string, string>;
}

const DEFAULT_SETTINGS: ByokSettings = {
	targetFolder: "BYOK",
	extension: "md",
	mountPath: "",
	syncAllProjects: true,
	projects: [],
	convertIndent: true,
	deviceTabSize: 5,
};

interface SyncResult {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
	conflicts: number;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

async function isDir(p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isFile();
	} catch {
		return false;
	}
}

/** A BYOK volume has a Projects folder and a Sync/library.json index. */
async function isByokRoot(root: string): Promise<boolean> {
	return (await isDir(path.join(root, "Projects"))) && (await isFile(path.join(root, "Sync", "library.json")));
}

/** Project folder names on the device, sorted. */
async function listProjects(root: string): Promise<string[]> {
	const projectsDir = path.join(root, "Projects");
	const names: string[] = [];
	for (const name of await fs.readdir(projectsDir)) {
		if (!name.startsWith(".") && (await isDir(path.join(projectsDir, name)))) names.push(name);
	}
	return names.sort((a, b) => a.localeCompare(b));
}

async function candidateMounts(): Promise<string[]> {
	const listDir = async (dir: string) => {
		try {
			return (await fs.readdir(dir)).map((name) => path.join(dir, name));
		} catch {
			return [];
		}
	};
	switch (process.platform) {
		case "darwin":
			return listDir("/Volumes");
		case "win32":
			return "DEFGHIJKLMNOPQRSTUVWXYZ".split("").map((d) => `${d}:\\`);
		default: {
			const user = os.userInfo().username;
			return [...(await listDir(`/media/${user}`)), ...(await listDir(`/run/media/${user}`)), ...(await listDir("/mnt"))];
		}
	}
}

export default class ByokSyncPlugin extends Plugin {
	settings: ByokSettings = { ...DEFAULT_SETTINGS };
	synced: Record<string, string> = {};
	private syncing = false;

	async onload() {
		const data = (await this.loadData()) as Partial<ByokData> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
		this.synced = data?.synced ?? {};

		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
		this.addSettingTab(new ByokSettingTab(this.app, this));
	}

	async save() {
		const data: ByokData = { settings: this.settings, synced: this.synced };
		await this.saveData(data);
	}

	async findDevice(): Promise<string | null> {
		const override = this.settings.mountPath.trim();
		const candidates = override ? [override] : await candidateMounts();
		for (const root of candidates) {
			if (await isByokRoot(root)) return root;
		}
		return null;
	}

	async syncNow() {
		if (this.syncing) return;
		this.syncing = true;
		try {
			const root = await this.findDevice();
			if (!root) {
				new Notice("BYOK device not found. Is it plugged in and in disk mode?");
				return;
			}
			const r = await this.syncProjects(root);
			await this.save();
			const parts = [`${r.created} new`, `${r.updated} updated`];
			if (r.conflicts) parts.push(`${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"}`);
			new Notice(`BYOK synced: ${parts.join(", ")}`);
		} catch (e) {
			console.error("BYOK sync failed", e);
			new Notice(`BYOK sync failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.syncing = false;
		}
	}

	private async syncProjects(root: string): Promise<SyncResult> {
		const result: SyncResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: 0 };
		const projectsDir = path.join(root, "Projects");
		const target = normalizePath(this.settings.targetFolder || "BYOK");
		const ext = this.settings.extension;

		const { syncAllProjects, projects } = this.settings;
		for (const project of await listProjects(root)) {
			if (!syncAllProjects && !projects.includes(project)) continue;
			const projectFolder = normalizePath(`${target}/${project}`);
			await this.ensureFolder(projectFolder);

			for (const name of await fs.readdir(path.join(projectsDir, project))) {
				// Skip macOS AppleDouble files (._foo) and other hidden files.
				if (name.startsWith(".") || path.extname(name).toLowerCase() !== ".txt") continue;
				const src = path.join(projectsDir, project, name);
				if (!(await isFile(src))) continue;

				const base = path.basename(name, path.extname(name));
				const content = this.convertIndent(await fs.readFile(src, "utf8"));
				const deviceHash = hash(content);
				const vaultPath = normalizePath(`${projectFolder}/${base}.${ext}`);
				const existing = this.app.vault.getAbstractFileByPath(vaultPath);

				if (!existing) {
					await this.app.vault.create(vaultPath, content);
					this.synced[vaultPath] = deviceHash;
					result.created++;
					continue;
				}
				if (!(existing instanceof TFile)) {
					result.skipped++;
					continue;
				}

				const current = await this.app.vault.read(existing);
				const last = this.synced[vaultPath];
				if (current === content) {
					this.synced[vaultPath] = deviceHash;
					result.unchanged++;
				} else if (deviceHash === last) {
					// Device hasn't changed since last sync; keep the vault's edits.
					result.unchanged++;
				} else if (hash(current) === last) {
					// Only the device changed; safe to overwrite.
					await this.app.vault.process(existing, () => content);
					this.synced[vaultPath] = deviceHash;
					result.updated++;
				} else {
					// Both sides changed (or the note predates the plugin): keep both.
					const stamp = moment().format("YYYY-MM-DD HHmmss");
					const conflictPath = normalizePath(`${projectFolder}/${base} (BYOK ${stamp}).${ext}`);
					await this.app.vault.create(conflictPath, content);
					this.synced[vaultPath] = deviceHash;
					result.conflicts++;
				}
			}
		}
		return result;
	}

	/**
	 * The device saves each Tab as `deviceTabSize` spaces. Replace each full group of
	 * leading spaces with one indent matching Obsidian's editor setting ("Indent using
	 * tabs" / "Tab indent size"); leftover spaces that don't fill a group are kept.
	 */
	private convertIndent(text: string): string {
		const size = this.settings.deviceTabSize;
		if (!this.settings.convertIndent || size < 1) return text;
		// getConfig is not in Obsidian's public typings but reads the editor settings.
		const vault = this.app.vault as unknown as { getConfig?(key: string): unknown };
		const useTab = vault.getConfig?.("useTab") !== false;
		const indent = useTab ? "\t" : " ".repeat(Number(vault.getConfig?.("tabSize")) || 4);
		return text.replace(/^ +/gm, (spaces) => indent.repeat(Math.floor(spaces.length / size)) + " ".repeat(spaces.length % size));
	}

	private async ensureFolder(folderPath: string) {
		let current = "";
		for (const part of folderPath.split("/")) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) await this.app.vault.createFolder(current);
			else if (!(existing instanceof TFolder)) throw new Error(`${current} exists and is not a folder`);
		}
	}
}

class ByokSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ByokSyncPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		const status = new Setting(containerEl)
			.setName("Device status")
			.setDesc("Looking for device…")
			.addButton((b) => b.setButtonText("Sync now").setCta().onClick(() => this.plugin.syncNow()));
		// Block body on purpose: Setting has a then() method, so returning it from a
		// promise callback makes the promise try to resolve it forever and freezes the app.
		void this.plugin.findDevice().then((root) => {
			status.setDesc(root ? `Connected at ${root}` : "Not connected");
		});

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc("Vault folder that BYOK projects are synced into. Each project becomes a subfolder.")
			.addText((t) =>
				t.setPlaceholder("BYOK").setValue(s.targetFolder).onChange(async (v) => {
					s.targetFolder = v.trim();
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Sync all projects")
			.setDesc("Turn off to choose which BYOK projects are synced.")
			.addToggle((t) =>
				t.setValue(s.syncAllProjects).onChange(async (v) => {
					s.syncAllProjects = v;
					await this.plugin.save();
					this.display();
				}),
			);

		if (!s.syncAllProjects) {
			const projectsEl = containerEl.createDiv();
			void this.renderProjects(projectsEl);
		}

		new Setting(containerEl)
			.setName("Convert indentation")
			.setDesc("The BYOK saves each tab as spaces. Convert them to match your editor's indentation settings.")
			.addToggle((t) =>
				t.setValue(s.convertIndent).onChange(async (v) => {
					s.convertIndent = v;
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("BYOK tab size")
			.setDesc("Spaces the BYOK writes for one tab press.")
			.addText((t) =>
				t.setValue(String(s.deviceTabSize)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isInteger(n) || n < 1) return;
					s.deviceTabSize = n;
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Note extension")
			.setDesc("Save device .txt files as Markdown notes (.md) or keep them as .txt.")
			.addDropdown((d) =>
				d.addOption("md", ".md").addOption("txt", ".txt").setValue(s.extension).onChange(async (v) => {
					s.extension = v as ByokSettings["extension"];
					await this.plugin.save();
				}),
			);

		new Setting(containerEl)
			.setName("Mount path override")
			.setDesc("Full path to the mounted BYOK. Leave empty to detect it automatically.")
			.addText((t) =>
				t.setValue(s.mountPath).onChange(async (v) => {
					s.mountPath = v;
					await this.plugin.save();
				}),
			);
	}

	private async renderProjects(el: HTMLElement) {
		const s = this.plugin.settings;
		const root = await this.plugin.findDevice();
		let onDevice: string[] = [];
		try {
			if (root) onDevice = await listProjects(root);
		} catch {
			// Device was unplugged mid-read; fall back to the saved selection.
		}
		const names = [...new Set([...onDevice, ...s.projects])].sort((a, b) => a.localeCompare(b));

		el.empty();
		if (!root) el.createEl("p", { cls: "setting-item-description", text: "Plug in your BYOK to see all of its projects." });
		if (names.length === 0) return;

		for (const name of names) {
			new Setting(el)
				.setName(name)
				.setDesc(root && !onDevice.includes(name) ? "Not found on device" : "")
				.addToggle((t) =>
					t.setValue(s.projects.includes(name)).onChange(async (v) => {
						s.projects = v ? [...s.projects, name] : s.projects.filter((p) => p !== name);
						await this.plugin.save();
					}),
				);
		}
	}
}
