#!/usr/bin/env bash
set -euo pipefail

UUID="imgur-screenshot-uploader49@local"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "${TARGET_DIR}"
cp metadata.json extension.js prefs.js README.md "${TARGET_DIR}/"
mkdir -p "${TARGET_DIR}/schemas"
cp schemas/org.gnome.shell.extensions.imgur-screenshot-uploader.gschema.xml "${TARGET_DIR}/schemas/"
glib-compile-schemas "${TARGET_DIR}/schemas"

printf 'Installed to %s\n' "${TARGET_DIR}"
printf 'Enable with: gnome-extensions enable %s\n' "${UUID}"
