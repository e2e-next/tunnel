.PHONY: help setup test check format check-install run clean panel panel-check panel-smoke

# tunnel is a Node package: Node 22.18 or newer (engines in package.json), and
# nothing else to install. These targets are thin wrappers over its npm
# scripts, plus the three panel targets, which have none of their own.
NPM := $(shell command -v npm 2> /dev/null)
NEED_NODE := if [ -z "$(NPM)" ]; then echo "❌ tunnel needs Node 22.18 or newer: https://nodejs.org"; exit 1; fi
REQUIRE_NODE := $(NEED_NODE); [ -d node_modules ] || npm ci
# Straight from the sources, so nothing needs building first
TUNNEL := node --disable-warning=ExperimentalWarning src/cli.ts
PANEL_DIR := panel

# The panel is a React app built with Vite, and its build is committed: these
# three files are what ships, so neither a checkout nor an install builds it.
# panel/ has its own node_modules, which only the panel targets install.
PANEL_OUT := assets/panel
PANEL_FILES := panel.js panel.css panel-InterVariable-latin.woff2

# The smoke test's own server. Not 8000, not 8888 and not anybody's config
# directory: it makes a rule and a call, so it must not be pointed at a tunnel
# somebody is using.
SMOKE_ADMIN := 8030
SMOKE_PROXY := 8031

help: ## Show this help message
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: ## Install the dependencies (npm ci)
	@$(NEED_NODE)
	npm ci

test: ## Run the test suite, straight from the sources
	@$(REQUIRE_NODE)
	npm test

check: ## Type-check, and fail on unformatted files
	@$(REQUIRE_NODE)
	npm run typecheck
	npm run format:check

format: ## Format the TypeScript
	@$(REQUIRE_NODE)
	npm run format

check-install: ## Pack, install into a throwaway directory, check the file list, the size budget, the command and the library entry with its types
	@$(REQUIRE_NODE)
	npm run check-install

run: ## Run tunnel serve from the sources
	@$(REQUIRE_NODE)
	$(TUNNEL) serve

clean: ## Remove the build output
	rm -rf dist

panel: ## Build the panel into assets/panel/ (only when you change panel/)
	@$(NEED_NODE)
	cd $(PANEL_DIR) && npm ci && npm run build
	@echo "✅ wrote $(PANEL_OUT)/: $(PANEL_FILES) — commit them: the package ships them as they are"

# The build is byte-reproducible, so comparing it against what is committed is
# a real staleness gate rather than a coin toss. It builds into a temporary
# directory so that a stale tree is reported, not quietly fixed underneath the
# person asking.
panel-check: ## Type-check the panel and fail when the committed build is stale
	@$(NEED_NODE)
	@if [ ! -d "$(PANEL_DIR)/node_modules" ]; then \
		echo "📥 Installing the panel's dependencies ..."; \
		cd $(PANEL_DIR) && npm ci; \
	fi
	cd $(PANEL_DIR) && npm run typecheck
	@set -e; \
	tmp=$$(mktemp -d); \
	trap 'rm -rf $$tmp' EXIT; \
	(cd $(PANEL_DIR) && npm run build -- --outDir "$$tmp" --emptyOutDir > /dev/null); \
	for f in $(PANEL_FILES); do \
		cmp -s "$$tmp/$$f" "$(PANEL_OUT)/$$f" || { \
			echo "❌ $(PANEL_OUT)/$$f is stale: run make panel and commit it"; \
			exit 1; \
		}; \
	done; \
	echo "✅ the panel type-checks and its committed build is up to date"

# The browser pass: it opens every page of the built panel in this machine's
# Chrome and fails on anything the browser logged. It needs Playwright, which
# nothing here depends on, so it is deliberately not part of `make test`. Run
# this before a release, and after changing panel/.
panel-smoke: ## Open every panel page in Chrome, fail on any console error (needs Playwright; not in make test)
	@$(REQUIRE_NODE)
	@cd $(PANEL_DIR)/tools && node -e "require.resolve('playwright')" 2>/dev/null || { \
		echo "❌ this needs Playwright, which nothing here depends on: cd $(PANEL_DIR) && npm i --no-save playwright"; \
		exit 1; \
	}
	@set -e; \
	dir=$$(mktemp -d); \
	trap 'TUNNEL_CONFIG_DIR=$$dir $(TUNNEL) stop >/dev/null 2>&1; rm -rf $$dir' EXIT; \
	echo "🚀 a throwaway tunnel on $(SMOKE_ADMIN)/$(SMOKE_PROXY), everything it writes in $$dir"; \
	TUNNEL_CONFIG_DIR=$$dir $(TUNNEL) serve --background --admin-port $(SMOKE_ADMIN) --proxy-port $(SMOKE_PROXY) \
		--proxy-host 127.0.0.1 --config-dir $$dir > /dev/null; \
	node $(PANEL_DIR)/tools/smoke.mjs http://127.0.0.1:$(SMOKE_ADMIN)
