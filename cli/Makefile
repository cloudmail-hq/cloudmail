BINARY  := cloudmail
PREFIX  ?= /usr/local
# Releases are tagged cli-vX.Y.Z (in this repo, where other tags exist) or
# vX.Y.Z (the public repo). Only those tags are considered, and the cli- prefix
# is dropped, so either tag stamps the binary as vX.Y.Z. Without a matching tag
# this falls back to the commit hash.
VERSION ?= $(patsubst cli-%,%,$(shell git describe --tags --match 'cli-v[0-9]*' --match 'v[0-9]*' --always --dirty 2>/dev/null || echo dev))
# The version in archive names: VERSION without its leading "v".
ARCHIVE_VERSION = $(patsubst v%,%,$(VERSION))
# The licence lives at the repository root, one level up.
LICENSE_FILE ?= ../LICENSE
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# -s -w strip the symbol table and DWARF: nothing here is debugged from a shipped
# binary, and it takes roughly a third off the size of a tool people install.
LDFLAGS := -s -w \
	-X github.com/cloudmail-hq/cloudmail/cli/internal/cmd.Version=$(VERSION) \
	-X github.com/cloudmail-hq/cloudmail/cli/internal/cmd.Commit=$(COMMIT) \
	-X github.com/cloudmail-hq/cloudmail/cli/internal/cmd.Date=$(DATE)

# Platforms built by `make release`. Pure Go with no cgo, so cross-compiling needs
# no toolchain per target.
PLATFORMS := darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64

.PHONY: all build install uninstall test vet fmt fmt-check lint check clean release completions help

all: check build

## build: compile the binary into ./bin
build:
	@mkdir -p bin
	go build -trimpath -ldflags '$(LDFLAGS)' -o bin/$(BINARY) .
	@echo "built bin/$(BINARY) $(VERSION)"

## install: build and install into $(PREFIX)/bin
install: build
	install -d $(PREFIX)/bin
	install -m 0755 bin/$(BINARY) $(PREFIX)/bin/$(BINARY)
	@echo "installed $(PREFIX)/bin/$(BINARY)"

## uninstall: remove the installed binary
uninstall:
	rm -f $(PREFIX)/bin/$(BINARY)

## test: run the test suite
test:
	go test -race ./...

## vet: run go vet
vet:
	go vet ./...

## fmt: format the source
fmt:
	gofmt -w -s .

## fmt-check: fail if anything is unformatted
fmt-check:
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "not gofmt'd:"; echo "$$unformatted"; exit 1; \
	fi

## check: fmt-check, vet and test
check: fmt-check vet test

## release: build, archive and checksum every platform into ./dist
#
# One archive per platform, named cloudmail_<version>_<os>_<arch>.tar.gz
# (.zip for windows), each holding a cloudmail_<version>_<os>_<arch>/ directory
# with the binary, README.md and LICENSE. dist/SHA256SUMS covers the archives
# (check with `shasum -a 256 -c SHA256SUMS`). <version> is VERSION without its
# leading "v". dist/ is emptied first so stale archives never ship.
release:
	@case "$(ARCHIVE_VERSION)" in ""|*/*|*" "*) echo "bad VERSION '$(VERSION)'"; exit 1;; esac
	@[ -f "$(LICENSE_FILE)" ] || { echo "no LICENSE at $(LICENSE_FILE)"; exit 1; }
	@rm -rf dist && mkdir -p dist/stage
	@set -e; for platform in $(PLATFORMS); do \
		os=$${platform%/*}; arch=$${platform#*/}; \
		ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
		name="$(BINARY)_$(ARCHIVE_VERSION)_$${os}_$${arch}"; \
		dir="dist/stage/$$name"; mkdir -p "$$dir"; \
		echo "building $$name"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
			go build -trimpath -ldflags '$(LDFLAGS)' -o "$$dir/$(BINARY)$$ext" .; \
		cp README.md "$$dir/README.md"; cp "$(LICENSE_FILE)" "$$dir/LICENSE"; \
		if [ "$$os" = "windows" ]; then \
			(cd dist/stage && zip -qrX "../$$name.zip" "$$name"); \
		else \
			COPYFILE_DISABLE=1 tar -C dist/stage -czf "dist/$$name.tar.gz" "$$name"; \
		fi; \
	done
	@rm -rf dist/stage
	@cd dist && if command -v sha256sum >/dev/null 2>&1; then \
		sha256sum $(BINARY)_* > SHA256SUMS; else shasum -a 256 $(BINARY)_* > SHA256SUMS; fi
	@echo "done; archives and SHA256SUMS in dist/"; ls -1 dist

## completions: generate shell completion scripts into ./completions
completions: build
	@mkdir -p completions
	./bin/$(BINARY) completion bash > completions/$(BINARY).bash
	./bin/$(BINARY) completion zsh  > completions/_$(BINARY)
	./bin/$(BINARY) completion fish > completions/$(BINARY).fish
	@echo "wrote completions/"

## clean: remove build artefacts
clean:
	rm -rf bin dist completions

## help: list the targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /' | sort
