.PHONY: install build lint deploy release

# Release notes for `make release`, as a Markdown file. They become the tag
# annotation, and the release workflow uses them as the GitHub release notes.
NOTES ?=

install:
	npm ci

build:
	npm run build

lint:
	npm run lint

# Build and copy the plugin into a vault: make deploy VAULT="/path/to/vault"
deploy:
	@test -n "$(VAULT)" || { echo 'Usage: make deploy VAULT="/path/to/vault"'; exit 1; }
	npm run deploy

# Cut a release: make release VERSION=1.0.1 NOTES=notes.md
# Bumps the version, commits, tags, and pushes. Pushing the tag runs
# .github/workflows/release.yml, which builds main.js and publishes the
# GitHub release with main.js and manifest.json attached.
release:
	@echo "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo 'Usage: make release VERSION=x.y.z [NOTES=notes.md]'; exit 1; }
	@test -z "$(NOTES)" || test -f "$(NOTES)" || { echo "Notes file not found: $(NOTES)"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = main || { echo "Releases must be cut from main."; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "Working tree is not clean. Commit or stash your changes first."; exit 1; }
	@git fetch --quiet --tags origin
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "main is not in sync with origin/main. Pull or push first."; exit 1; }
	@! git rev-parse -q --verify "refs/tags/$(VERSION)" >/dev/null || { echo "Tag $(VERSION) already exists."; exit 1; }
	npm version --no-git-tag-version --allow-same-version "$(VERSION)"
	node -e 'const fs = require("fs"); \
		const m = JSON.parse(fs.readFileSync("manifest.json")); m.version = "$(VERSION)"; \
		fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n"); \
		const v = JSON.parse(fs.readFileSync("versions.json")); v["$(VERSION)"] = m.minAppVersion; \
		fs.writeFileSync("versions.json", JSON.stringify(v, null, 2) + "\n");'
	npm run lint
	npm run build
	git add manifest.json versions.json package.json package-lock.json
	@# Skip the commit when the version files already match (e.g. the first release).
	git diff --cached --quiet || git commit -m "Release $(VERSION)"
	@if [ -n "$(NOTES)" ]; then \
		git tag -a "$(VERSION)" --cleanup=verbatim -F "$(NOTES)"; \
	else \
		git tag -a "$(VERSION)" -m "Release $(VERSION)"; \
	fi
	git push origin main "refs/tags/$(VERSION)"
	@echo "Pushed $(VERSION). Follow the release build at https://github.com/jasonodonnell/byok-obsidian-sync/actions"
