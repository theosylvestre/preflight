ICONS_DIR := media/aws-icons

.PHONY: clean-icons run debug icon package install

VSIX := $(shell node -p "p=require('./package.json');p.name+'-'+p.version").vsix

# Keeps only the 64 px SVG icons of the AWS pack (removes PNG, .DS_Store, other sizes…)
# then the empty folders.
clean-icons:
	find $(ICONS_DIR) -type f ! -name '*_64.svg' -delete
	find $(ICONS_DIR) -type d -empty -delete

# Opens a VS Code window with the extension loaded, without debugger, on the test project.
run:
	code --new-window --disable-extensions --extensionDevelopmentPath="$(CURDIR)" "$(CURDIR)/tf-test" "$(CURDIR)/tf-test/plan.json"

# Same, with the extension host inspector listening on 127.0.0.1:$(DEBUG_PORT)
# (the debugger then attaches through the "Run Extension (attach 127.0.0.1)" config).
DEBUG_PORT := 9229
debug:
	code --new-window --disable-extensions --inspect-extensions=$(DEBUG_PORT) --extensionDevelopmentPath="$(CURDIR)" "$(CURDIR)/tf-test" "$(CURDIR)/tf-test/plan.json"

# Builds the .vsix at the project root (no runtime dependencies: --no-dependencies avoids
# vsce walking the pnpm node_modules).
package:
	npx --yes @vscode/vsce package --no-dependencies -o $(VSIX)

# Builds the .vsix then installs it in the local VS Code.
install: package
	code --install-extension $(VSIX) --force

# Regenerates the extension icon (PNG required by vsce) from media/icon.svg.
icon:
	rsvg-convert -w 256 -h 256 media/icon.svg -o media/icon.png
