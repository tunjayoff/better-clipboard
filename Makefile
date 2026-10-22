UUID = better-clipboard@tunjayoff
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES = extension.js prefs.js stylesheet.css metadata.json lib icons schemas

.PHONY: all schemas zip install uninstall lint clean

all: zip

schemas:
	glib-compile-schemas --strict schemas/

# The zip is what gets uploaded to extensions.gnome.org or installed with
# `gnome-extensions install`.
zip:
	@mkdir -p dist
	gnome-extensions pack --force \
		--extra-source=lib --extra-source=icons \
		--out-dir=dist .

# `gnome-extensions install` fails on zips with subfolders ("Can't recursively
# copy directory"), so unpack it ourselves and compile the schema like the
# shell does for extensions.gnome.org installs.
install: zip
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	unzip -q dist/$(UUID).shell-extension.zip -d $(INSTALL_DIR)
	glib-compile-schemas --strict $(INSTALL_DIR)/schemas
	@echo "Installed. Log out and back in once, then: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

lint:
	@for f in extension.js prefs.js lib/*.js; do node --check --input-type=module < $$f || exit 1; done
	glib-compile-schemas --strict --dry-run schemas/
	gjs -m tests/classify.test.js

clean:
	rm -rf dist schemas/gschemas.compiled
