import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/", "esbuild.config.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
			},
		},
		rules: {
			// BYOK (Bring Your Own Keyboard) is the device's name, an acronym.
			"obsidianmd/ui/sentence-case": ["warn", { acronyms: [...DEFAULT_ACRONYMS, "BYOK"] }],
		},
	},
]);
