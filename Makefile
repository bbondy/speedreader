# Speedreader extension — reproducible build.
#
#   make            Build dist/ (load ~/brave/speedreader/dist as an unpacked extension)
#   make icons      Resize the action/toolbar PNGs from the icon-source.png master
#   make wasm       Build the Rust distiller to WASM (needs wasm-pack)
#   make vendor-rust BRAVE_SRC=/path/to/brave-core   Copy Brave's readability crate in
#   make clean      Remove dist/
#
# WASM is the only distiller — it gives byte-identical extraction to Brave. The
# build fails if wasm-pack / the vendored crate are missing (run `make vendor-rust`
# then ensure wasm-pack is installed); there is no second engine to fall back to.

SRC   := src
DIST  := dist
SIZES := 16 32 48 128

# Find rustup/wasm-pack installed under ~/.cargo even when not on the login PATH.
export PATH := $(HOME)/.cargo/bin:$(PATH)

.PHONY: all build icons wasm vendor-rust clean

all: build

build: clean
	mkdir -p $(DIST)
	cp -R $(SRC)/. $(DIST)/
	rm -f $(DIST)/icons/icon-source.png
	$(MAKE) icons
	$(MAKE) wasm
	@echo "✓ dist/ ready — load $(CURDIR)/$(DIST) as an unpacked extension"

# Reproducibly resize every icon size from the single icon-source.png master.
icons:
	@command -v sips >/dev/null || { echo "need sips (ships with macOS)"; exit 1; }
	@mkdir -p $(DIST)/icons
	@for s in $(SIZES); do \
	  cp $(SRC)/icons/icon-source.png $(DIST)/icons/icon$$s.png; \
	  sips -z $$s $$s $(DIST)/icons/icon$$s.png >/dev/null; \
	done
	@echo "✓ icons resized ($(SIZES))"

# Compile Brave's Rust distiller to WASM and drop the glue into dist/vendor/wasm.
# WASM is the ONLY distiller (no fallback) — byte-identical extraction to Brave is
# the whole point, so a missing toolchain fails the build loudly rather than
# silently shipping a different engine.
wasm:
	@command -v wasm-pack >/dev/null || { echo "✗ need wasm-pack (cargo install wasm-pack)"; exit 1; }
	@test -d wasm/vendor-readability || { echo "✗ need the readability crate: make vendor-rust BRAVE_SRC=/path/to/brave-core"; exit 1; }
	cd wasm && wasm-pack build --release --target web --out-dir ../$(DIST)/vendor/wasm
	@echo "✓ wasm built"

# Vendor Brave's readability crate so the WASM build is self-contained/reproducible.
vendor-rust:
	@test -n "$(BRAVE_SRC)" || { echo "usage: make vendor-rust BRAVE_SRC=/path/to/brave-core"; exit 1; }
	rm -rf wasm/vendor-readability
	cp -R "$(BRAVE_SRC)/components/speedreader/rust/lib/src/readability" wasm/vendor-readability
	@echo "✓ vendored readability crate into wasm/vendor-readability"

clean:
	rm -rf $(DIST)
