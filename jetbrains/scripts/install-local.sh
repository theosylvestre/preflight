#!/bin/sh
# Installs the plugin .zip in the JetBrains IDEs of this machine, as "Install Plugin from Disk"
# does: unpacked into the plugins folder of each IDE's configuration (taken into account at
# the next start of the IDE).
#
#   install-local.sh <plugin.zip> [config dir…]
#
# Without config dirs: the latest version of IntelliJ IDEA and of PyCharm found in the
# JetBrains configuration folder (macOS: ~/Library/Application Support/JetBrains, Linux:
# ~/.local/share/JetBrains, or $JETBRAINS_DIR).
set -eu

zip=$1
shift
name=$(unzip -Z1 "$zip" | head -1 | cut -d/ -f1)

if [ $# -eq 0 ]; then
	root=${JETBRAINS_DIR:-}
	if [ -z "$root" ]; then
		if [ -d "$HOME/Library/Application Support/JetBrains" ]; then root="$HOME/Library/Application Support/JetBrains"
		else root="$HOME/.local/share/JetBrains"; fi
	fi
	for product in IntelliJIdea IdeaIC PyCharm PyCharmCE; do
		# Latest version of each product (IntelliJIdea2026.2, PyCharm2025.3…).
		latest=$(ls -d "$root/$product"20* 2>/dev/null | sort -V | tail -1 || true)
		[ -n "$latest" ] && set -- "$@" "$latest"
	done
	if [ $# -eq 0 ]; then
		echo "No IntelliJ IDEA or PyCharm configuration found in $root." >&2
		echo "Give the configuration folder: make install-jetbrains JB_CONFIG=\"…/IntelliJIdea2026.2\"" >&2
		exit 1
	fi
fi

for config in "$@"; do
	mkdir -p "$config/plugins"
	rm -rf "${config:?}/plugins/$name"
	unzip -q "$zip" -d "$config/plugins"
	echo "Installed in $(basename "$config") ($config/plugins/$name): restart the IDE to load it."
done
