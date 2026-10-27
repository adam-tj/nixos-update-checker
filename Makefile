UUID    = nixos-update-checker@adam-tj.github.com
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES   = extension.js prefs.js lock.js metadata.json README.md LICENSE.md icons schemas

.PHONY: all schemas install uninstall zip clean

all: schemas

# The compiled schema is not committed; build it before installing.
schemas:
	glib-compile-schemas --strict schemas/

install: schemas
	rm -rf "$(EXT_DIR)"
	mkdir -p "$(EXT_DIR)"
	cp -r $(FILES) "$(EXT_DIR)/"
	@echo
	@echo "Installed to $(EXT_DIR)"
	@echo "Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf "$(EXT_DIR)"

zip: schemas
	rm -f "$(UUID).zip"
	cd . && zip -qr "$(UUID).zip" $(FILES)
	@echo "Wrote $(UUID).zip"

clean:
	rm -f schemas/gschemas.compiled "$(UUID).zip"
