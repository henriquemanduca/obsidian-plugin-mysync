PLUGIN_ID := mysync

ifdef OBSIDIAN_VAULT
OBSIDIAN_PLUGIN_DIR ?= $(OBSIDIAN_VAULT)/.obsidian/plugins/$(PLUGIN_ID)
endif

.PHONY: build deploy check-deploy-dir deploy-test deploy-prod

build:
	npm run build

check-deploy-dir:
	@test -n "$(OBSIDIAN_PLUGIN_DIR)" || (echo "Set OBSIDIAN_VAULT or OBSIDIAN_PLUGIN_DIR"; exit 1)

deploy: build check-deploy-dir
	mkdir -p "$(OBSIDIAN_PLUGIN_DIR)"
	cp dist/main.js "$(OBSIDIAN_PLUGIN_DIR)/main.js"
	cp dist/manifest.json "$(OBSIDIAN_PLUGIN_DIR)/manifest.json"
	cp dist/styles.css "$(OBSIDIAN_PLUGIN_DIR)/styles.css"
