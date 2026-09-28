ICONS_DIR := core/media/aws-icons
VSC := $(CURDIR)/vsc

.PHONY: clean-icons build run debug icon package install test \
	jb-build jb-test jb-run jb-run-pycharm jb-verify

VSIX := $(shell node -p "p=require('./vsc/package.json');p.name+'-'+p.version").vsix

# Keeps only the 64 px SVG icons of the AWS pack (removes PNG, .DS_Store, other sizes…)
# then the empty folders.
clean-icons:
	find $(ICONS_DIR) -type f ! -name '*_64.svg' -delete
	find $(ICONS_DIR) -type d -empty -delete

# Builds the VS Code extension (vsc/dist, vsc/media) from vsc/ and core/.
build:
	pnpm --filter preflight-tf-aws run build

# Lint, core tests, VS Code extension tests.
test:
	pnpm test

# Opens a VS Code window with the extension loaded, without debugger, on the test project.
run: build
	code --new-window --disable-extensions --extensionDevelopmentPath="$(VSC)" "$(CURDIR)/tf-test" "$(CURDIR)/tf-test/plan.json"

# Same, with the extension host inspector listening on 127.0.0.1:$(DEBUG_PORT)
# (the debugger then attaches through the "Run Extension (attach 127.0.0.1)" config).
DEBUG_PORT := 9229
debug: build
	code --new-window --disable-extensions --inspect-extensions=$(DEBUG_PORT) --extensionDevelopmentPath="$(VSC)" "$(CURDIR)/tf-test" "$(CURDIR)/tf-test/plan.json"

# Builds the .vsix at the project root (no runtime dependencies: --no-dependencies avoids
# vsce walking the pnpm node_modules).
package:
	cd vsc && pnpm exec vsce package --no-dependencies -o ../$(VSIX)

# Builds the .vsix then installs it in the local VS Code.
install: package
	code --install-extension $(VSIX) --force

# Regenerates the extension icon (PNG required by vsce) from core/media/icon.svg.
icon:
	rsvg-convert -w 256 -h 256 core/media/icon.svg -o core/media/icon.png

# --- JetBrains plugin (jetbrains/) ------------------------------------------------------------
# Gradle needs a JDK 17+: JAVA_HOME when set, otherwise the runtime bundled with IntelliJ IDEA
# (macOS). The JDK 21 used to compile is downloaded by Gradle when missing.
IDEA_JBR := /Applications/IntelliJ IDEA.app/Contents/jbr/Contents/Home
GRADLE := cd jetbrains && JAVA_HOME="$${JAVA_HOME:-$(IDEA_JBR)}" ./gradlew

# Builds jetbrains/build/distributions/preflight-jetbrains-<version>.zip
# (Settings → Plugins → ⚙ → Install Plugin from Disk…).
jb-build:
	$(GRADLE) buildPlugin

# Unit and platform tests (headless IDE), and the page side of the bridge (Node.js).
jb-test:
	$(GRADLE) check

# Sandbox IntelliJ IDEA / PyCharm with the plugin, opened on tf-test/.
jb-run:
	$(GRADLE) runIde

jb-run-pycharm:
	$(GRADLE) runPyCharm

# IntelliJ Plugin Verifier against the recommended IDE versions (large downloads).
jb-verify:
	$(GRADLE) verifyPlugin
