import { App, Notice, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TFile, TFolder, normalizePath } from "obsidian";
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
};

/** Number of spaces the BYOK writes for one Tab press. */
const BYOK_TAB_SIZE = 5;

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
					const d = new Date();
					const pad = (n: number) => String(n).padStart(2, "0");
					const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
	 * The device saves each Tab as `BYOK_TAB_SIZE` spaces. Replace each full group of
	 * leading spaces with one indent matching Obsidian's editor setting ("Indent using
	 * tabs" / "Tab indent size"); leftover spaces that don't fill a group are kept.
	 */
	private convertIndent(text: string): string {
		if (!this.settings.convertIndent) return text;
		// getConfig is not in Obsidian's public typings but reads the editor settings.
		const vault = this.app.vault as unknown as { getConfig?(key: string): unknown };
		const useTab = vault.getConfig?.("useTab") !== false;
		const indent = useTab ? "\t" : " ".repeat(Number(vault.getConfig?.("tabSize")) || 4);
		return text.replace(/^ +/gm, (spaces) => indent.repeat(Math.floor(spaces.length / BYOK_TAB_SIZE)) + " ".repeat(spaces.length % BYOK_TAB_SIZE));
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
	/** Result of the last device lookup; undefined until a lookup finishes. */
	private device: { root: string | null; projects: string[] } | undefined;
	private looking = false;

	constructor(app: App, private plugin: ByokSyncPlugin) {
		super(app, plugin);
	}

	/** Look for the device in the background, then re-render with the result. */
	private async lookForDevice() {
		this.looking = true;
		const root = await this.plugin.findDevice();
		let projects: string[] = [];
		try {
			if (root) projects = await listProjects(root);
		} catch {
			// Device was unplugged mid-read.
		}
		this.device = { root, projects };
		this.looking = false;
		this.update();
	}

	hide() {
		// Look for the device again the next time the tab is opened.
		this.device = undefined;
		this.update();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const root = this.device?.root ?? null;
		const onDevice = this.device?.projects ?? [];
		const projects = [...new Set([...onDevice, ...s.projects])].sort((a, b) => a.localeCompare(b));

		return [
			{
				name: "Device status",
				desc: !this.device ? "Looking for device…" : root ? `Connected at ${root}` : "Not connected",
				render: (setting) => {
					setting.addButton((b) =>
						b
							.setButtonText("Sync now")
							.setCta()
							.onClick(async () => {
								await this.plugin.syncNow();
								// The device may have been plugged in after the tab opened.
								if (!this.looking) void this.lookForDevice();
							}),
					);
					// Runs whenever the tab is shown, so the lookup only happens while settings are open.
					if (!this.device && !this.looking) void this.lookForDevice();
				},
			},
			{
				name: "Target folder",
				desc: "Vault folder that BYOK projects are synced into. Each project becomes a subfolder.",
				control: { type: "folder", key: "targetFolder", placeholder: "BYOK" },
			},
			{
				name: "Sync all projects",
				desc: "Turn off to choose which BYOK projects are synced.",
				control: { type: "toggle", key: "syncAllProjects" },
			},
			{
				type: "group",
				heading: "Projects",
				visible: () => !this.plugin.settings.syncAllProjects,
				items: [
					...(this.device && !root ? [{ name: "Plug in your BYOK to see all of its projects.", searchable: false }] : []),
					...projects.map((name) => ({
						name,
						desc: root && !onDevice.includes(name) ? "Not found on device" : "",
						searchable: false,
						render: (setting: Setting) => {
							setting.addToggle((t) =>
								t.setValue(s.projects.includes(name)).onChange(async (v) => {
									s.projects = v ? [...s.projects, name] : s.projects.filter((p) => p !== name);
									await this.plugin.save();
								}),
							);
						},
					})),
				],
			},
			{
				name: "Convert indentation",
				desc: "The BYOK saves each tab as 5 spaces. Convert them to match your editor's indentation settings.",
				control: { type: "toggle", key: "convertIndent" },
			},
			{
				name: "Note extension",
				desc: "Save device .txt files as Markdown notes (.md) or keep them as .txt.",
				control: { type: "dropdown", key: "extension", options: { md: ".md", txt: ".txt" } },
			},
			{
				name: "Mount path override",
				desc: "Full path to the mounted BYOK. Leave empty to detect it automatically.",
				control: { type: "text", key: "mountPath" },
			},
		];
	}

	/** The default saves only `settings`, which would drop the sync state stored next to it. */
	async setControlValue(key: string, value: unknown) {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.save();
		if (key === "syncAllProjects") this.refreshDomState();
	}
}
