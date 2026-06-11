# Drop — local development (Floci in podman + api/edge as bun processes).
# For the fully-containerized path instead, see deploy/Makefile (`make -C deploy up`).

API_PORT    ?= 8080
EDGE_PORT   ?= 8090
FLOCI_PORT  ?= 4566
BASE_DOMAIN ?= drop.localhost
BUCKET      ?= drop
RUN         := .run
ENV         := DROP_S3_BUCKET=$(BUCKET) DROP_S3_ENDPOINT=http://localhost:$(FLOCI_PORT) DROP_S3_KEY_ID=test DROP_S3_SECRET=test DROP_BASE_DOMAIN=$(BASE_DOMAIN) DROP_DEV_AUTH=1

.DEFAULT_GOAL := help
.PHONY: help setup start stop restart status logs floci publish stop-all

help:
	@echo "Drop — local dev:"
	@echo "  make setup                      one-time: bun + deps + podman VM + floci image"
	@echo "  make start                      start Floci + api(:$(API_PORT)) + edge(:$(EDGE_PORT))"
	@echo "  make stop                       stop api + edge + Floci"
	@echo "  make restart                    stop, then start"
	@echo "  make status                     show what's running"
	@echo "  make logs                       tail api + edge logs"
	@echo "  make publish DIR=./dist NAME=x  publish a folder and print its URL"
	@echo "  make stop-all                   also stop the podman machine"
	@echo ""
	@echo "  corp/Zscaler CA for podman pulls:  make setup CORP_CA=~/certs/Zscalerroot.cer"

# One-time local setup: Bun, dependencies, podman VM, and the Floci image.
# On a corp network behind Zscaler, pass CORP_CA=<root.cer> to make image pulls work.
setup:
	@command -v bun >/dev/null 2>&1 || { echo "▸ installing Bun…"; curl -fsSL https://bun.sh/install | bash; }
	@echo "✓ bun $$($(HOME)/.bun/bin/bun --version 2>/dev/null || bun --version)"
	@echo "▸ installing dependencies…"; bun install >/dev/null 2>&1 && echo "✓ deps installed"
	@command -v podman >/dev/null 2>&1 || { echo "✗ podman not found — install Podman Desktop, then re-run"; exit 1; }
	@podman machine inspect >/dev/null 2>&1 || { echo "▸ initializing podman VM (downloads an image, ~1-3 min)…"; podman machine init; }
	@podman machine start >/dev/null 2>&1 || true
	@if [ -n "$(CORP_CA)" ]; then \
	  echo "▸ injecting corp CA $(CORP_CA) into the podman VM…"; \
	  cat $(CORP_CA) | podman machine ssh "sudo tee /etc/pki/ca-trust/source/anchors/corp-ca.crt >/dev/null && sudo update-ca-trust" && \
	  podman machine stop >/dev/null 2>&1 && podman machine start >/dev/null 2>&1 && echo "✓ corp CA trusted"; \
	fi
	@echo "▸ pulling Floci image…"; podman pull docker.io/floci/floci:latest >/dev/null 2>&1 \
	  && echo "✓ floci image ready" \
	  || echo "! could not pull floci — if behind Zscaler:  make setup CORP_CA=~/certs/Zscalerroot.cer"
	@echo "✓ setup complete — run 'make start'"

floci:
	@podman machine start >/dev/null 2>&1 || true
	@podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-floci$$' || podman run -d --rm --name drop-floci -p $(FLOCI_PORT):4566 docker.io/floci/floci:latest >/dev/null
	@for i in $$(seq 1 40); do curl -s -o /dev/null http://localhost:$(FLOCI_PORT)/ 2>/dev/null && break; sleep 1; done
	@echo "✓ floci  :$(FLOCI_PORT)"

start: floci
	@mkdir -p $(RUN)
	@$(ENV) DROP_HTTP_PORT=$(API_PORT)  nohup bun run bin/api.ts  > $(RUN)/api.log  2>&1 & echo $$! > $(RUN)/api.pid
	@$(ENV) DROP_HTTP_PORT=$(EDGE_PORT) nohup bun run bin/edge.ts > $(RUN)/edge.log 2>&1 & echo $$! > $(RUN)/edge.pid
	@for i in $$(seq 1 30); do curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && break; sleep 1; done
	@curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && echo "✓ api    http://localhost:$(API_PORT)" || { echo "✗ api failed — see $(RUN)/api.log"; tail -5 $(RUN)/api.log; exit 1; }
	@echo "✓ edge   http://localhost:$(EDGE_PORT)  (routes by  Host: <name>.$(BASE_DOMAIN))"
	@echo "next:  make publish DIR=./yourdist NAME=myapp"

stop:
	@-if [ -f $(RUN)/api.pid ];  then kill `cat $(RUN)/api.pid`  2>/dev/null; rm -f $(RUN)/api.pid;  fi
	@-if [ -f $(RUN)/edge.pid ]; then kill `cat $(RUN)/edge.pid` 2>/dev/null; rm -f $(RUN)/edge.pid; fi
	@-pkill -f 'bin/api.ts'  2>/dev/null || true
	@-pkill -f 'bin/edge.ts' 2>/dev/null || true
	@-podman stop drop-floci >/dev/null 2>&1 || true
	@echo "✓ stopped api + edge + floci  (podman machine still up; 'make stop-all' to stop it)"

stop-all: stop
	@-podman machine stop >/dev/null 2>&1 || true
	@echo "✓ podman machine stopped"

restart: stop start

status:
	@curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && echo "api:   up    (:$(API_PORT))" || echo "api:   down"
	@curl -s -o /dev/null http://localhost:$(EDGE_PORT)/ 2>/dev/null && echo "edge:  up    (:$(EDGE_PORT))" || echo "edge:  down"
	@(podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-floci$$' && echo "floci: up    (:$(FLOCI_PORT))") || echo "floci: down"

logs:
	@mkdir -p $(RUN); touch $(RUN)/api.log $(RUN)/edge.log; tail -f $(RUN)/api.log $(RUN)/edge.log

DIR  ?= ./dist
NAME ?= myapp
publish:
	@bun run bin/drop.ts dev-login alice alice@paytm.com --api http://localhost:$(API_PORT) >/dev/null
	@bun run bin/drop.ts publish $(DIR) $(NAME) --api http://localhost:$(API_PORT)
	@echo "view:  curl -H 'Host: $(NAME).$(BASE_DOMAIN)' http://localhost:$(EDGE_PORT)/"
