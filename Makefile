# Drop — local development (Floci in podman + api/edge as node processes).
# Runtime is Node (version pinned in .nvmrc). Bun is only used for `bun test`.
# For the fully-containerized path, see infra/ (`make -C infra up`).

API_PORT     ?= 8473
EDGE_PORT    ?= 8474
FLOCI_PORT   ?= 4566
FLOCI_VOLUME ?= drop-floci-data
PG_PORT      ?= 5432
PG_VOLUME    ?= drop-pg-data
PG_IMAGE     ?= docker.io/library/postgres:16-alpine
BASE_DOMAIN  ?= drop.localhost
BUCKET       ?= drop
RUN          := .run

NODE_VERSION := $(shell cat .nvmrc 2>/dev/null)
NODE_BIN     := $(HOME)/.nvm/versions/node/v$(NODE_VERSION)/bin
NODE         := $(NODE_BIN)/node
NPM          := $(NODE_BIN)/npm

# Local S3 (Floci) defaults. Auth config (dev vs Google) comes from .env — see
# .env.example. With no .env, DROP_DEV_AUTH defaults to 1 (dev-auth).
ENV    := DROP_S3_BUCKET=$(BUCKET) DROP_S3_ENDPOINT=http://localhost:$(FLOCI_PORT) DROP_S3_KEY_ID=test DROP_S3_SECRET=test DROP_BASE_DOMAIN=$(BASE_DOMAIN) DROP_DATABASE_URL=postgres://drop:drop@localhost:$(PG_PORT)/drop
LOADENV := set -a; [ -f .env ] && . ./.env; : "$${DROP_DEV_AUTH:=1}"; set +a;

.DEFAULT_GOAL := help
.PHONY: help setup start stop restart status logs floci postgres publish login stop-all build reset portless portless-stop

help:
	@echo "Drop — local dev (node $(NODE_VERSION)):"
	@echo "  make setup                      one-time: node $(NODE_VERSION) + deps + podman VM + floci image"
	@echo "  make start                      start Floci + api(:$(API_PORT)) + edge(:$(EDGE_PORT))"
	@echo "  make stop                       stop api + edge + Floci"
	@echo "  make restart                    stop, then start"
	@echo "  make status                     show what's running"
	@echo "  make logs                       tail api + edge logs"
	@echo "  make publish DIR=./dist NAME=x  publish a folder and print its URL"
	@echo "  make login                      sign in with Google (server-mediated, real auth)"
	@echo "  make portless                   front the stack with trusted HTTPS, no ports (needs portless)"
	@echo "  make stop-all                   also stop the podman machine"
	@echo "  make reset                      wipe the Floci + Postgres volumes (all sites + metadata)"
	@echo ""
	@echo "  corporate CA for podman pulls:  make setup CORP_CA=~/certs/your-root-ca.cer"

# One-time local setup: Node (via nvm + .nvmrc), deps, podman VM, Floci image.
# Behind a TLS-inspecting proxy, pass CORP_CA=<root.cer> so the podman VM can pull images.
setup:
	@command -v podman >/dev/null 2>&1 || { echo "✗ podman not found — install Podman Desktop, then re-run"; exit 1; }
	@echo "▸ ensuring node $(NODE_VERSION) (via nvm)…"
	@export NVM_DIR="$(HOME)/.nvm"; [ -s "$$NVM_DIR/nvm.sh" ] && . "$$NVM_DIR/nvm.sh" && nvm install >/dev/null 2>&1 || true
	@test -x $(NODE) || { echo "✗ node $(NODE_VERSION) not at $(NODE_BIN) — install nvm, then 'nvm install'"; exit 1; }
	@echo "✓ node $$($(NODE) -v)"
	@echo "▸ installing dependencies…"; $(NPM) install >/dev/null 2>&1 && echo "✓ deps installed"
	@podman machine inspect >/dev/null 2>&1 || { echo "▸ initializing podman VM (downloads an image, ~1-3 min)…"; podman machine init; }
	@podman machine start >/dev/null 2>&1 || true
	@if [ -n "$(CORP_CA)" ]; then \
	  echo "▸ injecting corp CA $(CORP_CA) into the podman VM…"; \
	  cat $(CORP_CA) | podman machine ssh "sudo tee /etc/pki/ca-trust/source/anchors/corp-ca.crt >/dev/null && sudo update-ca-trust" && \
	  podman machine stop >/dev/null 2>&1 && podman machine start >/dev/null 2>&1 && echo "✓ corp CA trusted"; \
	fi
	@echo "▸ pulling Floci image…"; podman pull docker.io/floci/floci:latest >/dev/null 2>&1 \
	  && echo "✓ floci image ready" \
	  || echo "! could not pull floci — if behind a TLS-inspecting proxy:  make setup CORP_CA=~/certs/your-root-ca.cer"
	@echo "▸ pulling Postgres image…"; podman pull $(PG_IMAGE) >/dev/null 2>&1 \
	  && echo "✓ postgres image ready" \
	  || echo "! could not pull postgres — if behind a TLS-inspecting proxy:  make setup CORP_CA=~/certs/your-root-ca.cer"
	@echo "✓ setup complete — run 'make start'"

build:
	@$(NODE) build.mjs

floci:
	@podman machine start >/dev/null 2>&1 || true
	@podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-floci$$' || podman run -d --rm --name drop-floci -p $(FLOCI_PORT):4566 -e FLOCI_STORAGE_MODE=hybrid -v $(FLOCI_VOLUME):/app/data docker.io/floci/floci:latest >/dev/null
	@for i in $$(seq 1 40); do curl -s -o /dev/null http://localhost:$(FLOCI_PORT)/ 2>/dev/null && break; sleep 1; done
	@echo "✓ floci  :$(FLOCI_PORT)  (persistent volume: $(FLOCI_VOLUME))"

postgres:
	@podman machine start >/dev/null 2>&1 || true
	@podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-postgres$$' || podman run -d --rm --name drop-postgres -p $(PG_PORT):5432 -e POSTGRES_USER=drop -e POSTGRES_PASSWORD=drop -e POSTGRES_DB=drop -v $(PG_VOLUME):/var/lib/postgresql/data $(PG_IMAGE) >/dev/null
	@for i in $$(seq 1 40); do podman exec drop-postgres pg_isready -U drop -d drop >/dev/null 2>&1 && break; sleep 1; done
	@echo "✓ postgres  :$(PG_PORT)  (persistent volume: $(PG_VOLUME))"

# Seamless local URLs: trusted HTTPS, no port numbers — mirrors prod routing.
# Fronts the ALREADY-RUNNING api/edge via portless (https://portless.sh):
#   https://api.drop.localhost      → api  (:$(API_PORT))   control plane + dashboard
#   https://<name>.drop.localhost   → edge (:$(EDGE_PORT))  published sites (wildcard)
# portless runs a local CA + reverse proxy on :443 (auto-elevates with sudo).
# Install once:  npm i -g portless   (Node 24+).  Run `make start` first.
# NOTE: portless's :443 proxy is a single shared daemon, and `--wildcard` is only
# applied at start — so we stop any running proxy first to guarantee the wildcard
# route (else *.drop.localhost would silently 'no-route'). This restarts the shared
# portless proxy; persisted aliases survive the restart.
portless:
	@command -v portless >/dev/null 2>&1 || { echo "✗ portless not found — install:  npm i -g portless  (Node 24+)"; exit 1; }
	@curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 || { echo "✗ api not up — run 'make start' first"; exit 1; }
	@curl -sf http://localhost:$(EDGE_PORT)/_drop_health >/dev/null 2>&1 || { echo "✗ edge not up — run 'make start' first"; exit 1; }
	@portless proxy stop >/dev/null 2>&1 || true
	@portless proxy start --wildcard >/dev/null 2>&1 || true
	@portless alias api.drop $(API_PORT) --force >/dev/null 2>&1 || true
	@portless alias drop $(EDGE_PORT) --force >/dev/null 2>&1 || true
	@echo "✓ portless up — trusted HTTPS, no ports:"
	@echo "    control plane:  https://api.drop.localhost"
	@echo "    your sites:     https://<name>.drop.localhost   (e.g. https://multipage.drop.localhost)"
	@echo "  (the URL Drop prints on publish now resolves directly)"

portless-stop:
	@portless proxy stop >/dev/null 2>&1 && echo "✓ portless proxy stopped" || echo "(portless not running)"

# Wipe the persistent volumes (all published sites + all metadata). Stops both first.
reset:
	@-podman stop drop-floci drop-postgres >/dev/null 2>&1 || true
	@-podman volume rm $(FLOCI_VOLUME) >/dev/null 2>&1 && echo "✓ wiped $(FLOCI_VOLUME)" || echo "(no floci volume to wipe)"
	@-podman volume rm $(PG_VOLUME) >/dev/null 2>&1 && echo "✓ wiped $(PG_VOLUME)" || echo "(no postgres volume to wipe)"

start: floci postgres
	@mkdir -p $(RUN)
	@$(NODE) build.mjs >/dev/null && echo "✓ built bundles"
	@$(LOADENV) $(ENV) DROP_HTTP_PORT=$(API_PORT)  nohup $(NODE) dist/api.js  > $(RUN)/api.log  2>&1 & echo $$! > $(RUN)/api.pid
	@$(LOADENV) $(ENV) DROP_HTTP_PORT=$(EDGE_PORT) DROP_EDGE_DISK_CACHE=$(RUN)/edge-cache nohup $(NODE) dist/edge.js > $(RUN)/edge.log 2>&1 & echo $$! > $(RUN)/edge.pid
	@for i in $$(seq 1 30); do curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && break; sleep 1; done
	@curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && echo "✓ api    http://localhost:$(API_PORT)" || { echo "✗ api failed — see $(RUN)/api.log"; tail -5 $(RUN)/api.log; exit 1; }
	@echo "✓ edge   http://localhost:$(EDGE_PORT)  (routes by  Host: <name>.$(BASE_DOMAIN))"
	@echo "next:  make publish DIR=./yourdist NAME=myapp"

stop:
	@-if [ -f $(RUN)/api.pid ];  then kill `cat $(RUN)/api.pid`  2>/dev/null; rm -f $(RUN)/api.pid;  fi
	@-if [ -f $(RUN)/edge.pid ]; then kill `cat $(RUN)/edge.pid` 2>/dev/null; rm -f $(RUN)/edge.pid; fi
	@-pkill -f 'dist/api.js'  2>/dev/null || true
	@-pkill -f 'dist/edge.js' 2>/dev/null || true
	@-podman stop drop-floci drop-postgres >/dev/null 2>&1 || true
	@echo "✓ stopped api + edge + floci + postgres  (podman machine still up; 'make stop-all' to stop it)"

stop-all: stop
	@-podman machine stop >/dev/null 2>&1 || true
	@echo "✓ podman machine stopped"

restart: stop start

status:
	@curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && echo "api:   up    (:$(API_PORT))" || echo "api:   down"
	@curl -s -o /dev/null http://localhost:$(EDGE_PORT)/ 2>/dev/null && echo "edge:  up    (:$(EDGE_PORT))" || echo "edge:  down"
	@(podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-floci$$' && echo "floci: up    (:$(FLOCI_PORT))") || echo "floci: down"
	@(podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-postgres$$' && echo "pg:    up    (:$(PG_PORT))") || echo "pg:    down"

logs:
	@mkdir -p $(RUN); touch $(RUN)/api.log $(RUN)/edge.log; tail -f $(RUN)/api.log $(RUN)/edge.log

# Real Google sign-in (server-mediated). Requires .env with the Google web-client
# config (see .env.example) and DROP_DEV_AUTH=0.
login:
	@test -f dist/drop.js || $(NODE) build.mjs cli >/dev/null
	@$(NODE) dist/drop.js login --api http://localhost:$(API_PORT)

DIR  ?= ./dist
NAME ?=
publish:
	@test -f dist/drop.js || $(NODE) build.mjs cli >/dev/null
	@$(LOADENV) if [ "$$DROP_DEV_AUTH" = "1" ]; then $(NODE) dist/drop.js dev-login alice alice@example.com --api http://localhost:$(API_PORT) >/dev/null; fi
	@$(NODE) dist/drop.js publish $(DIR) $(NAME) --api http://localhost:$(API_PORT)
	@[ -n "$(NAME)" ] && echo "view:  http://$(NAME).$(BASE_DOMAIN):$(EDGE_PORT)/" || echo "(local URL is http://<name>.$(BASE_DOMAIN):$(EDGE_PORT)/ )"
