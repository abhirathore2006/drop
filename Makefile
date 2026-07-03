# Drop — local development (Floci in podman + api/edge as node processes).
# Runtime is Node (version pinned in .nvmrc). Bun is only used for `bun test`.
# For the fully-containerized path, see infra/ (`make -C infra up`).

API_PORT     ?= 8473
EDGE_PORT    ?= 8474
FLOCI_PORT   ?= 4566
FLOCI_VOLUME ?= drop-floci-data
PG_PORT      ?= 5432
PG_VOLUME    ?= drop-pg-data
PG_IMAGE     ?= docker.io/library/postgres:18-alpine
BASE_DOMAIN  ?= drop.localhost
BUCKET       ?= drop
RUN          := .run
CERT         := infra/nginx/certs/drop.localhost.pem
# Local HTTPS: an nginx container terminates TLS and reverse-proxies to the host api/edge
# (api.<domain> → api, *.<domain> → edge). Set HTTPS_PORT=8443 if the host can't bind 443.
HTTPS_PORT   ?= 443
NGINX_IMAGE  ?= docker.io/library/nginx:1.27-alpine
HOST_GW      ?= host.containers.internal
HTTPS_SFX    := $(if $(filter 443,$(HTTPS_PORT)),,:$(HTTPS_PORT))

# Container engine — works with podman (default if present), Docker Desktop,
# Rancher Desktop (dockerd/moby engine), or colima. Override with
# `DROP_CONTAINER_ENGINE=docker` (env) or `make CE=docker`.
CE ?= $(DROP_CONTAINER_ENGINE)
ifeq ($(strip $(CE)),)
CE := $(shell command -v podman >/dev/null 2>&1 && echo podman || (command -v docker >/dev/null 2>&1 && echo docker))
endif

# podman VM sizing. The compute plane (k3s + KEDA + scale-to-zero pods) needs headroom
# or pods stay Pending (Insufficient memory). Used when `make setup` inits a NEW VM.
VM_CPUS   ?= 6
VM_MEMORY ?= 8192
VM_DISK   ?= 100

# Compute wiring — `start` auto-detects a running local k3s cluster and wires the API to it
# (so `make up` = cluster-up + start gives the full PaaS, not a static API beside an idle cluster).
# These are recursively expanded: the $(shell) re-runs when the `start` recipe executes, so it sees
# the cluster `cluster-up` just created. Empty (no cluster) → static-only.
KUBECONFIG_LOCAL := $(HOME)/.kube/drop-k3s.yaml
INTERCEPTOR_PORT ?= 18080
COMPUTE_ENV       = $(shell [ -f $(KUBECONFIG_LOCAL) ] && $(CE) ps --format '{{.Names}}' 2>/dev/null | grep -qx k3s && echo DROP_KUBECONFIG=$(KUBECONFIG_LOCAL) DROP_IMAGE_BACKEND=containerd DROP_IMAGE_RUNTIME=$(CE) DROP_K3S_CONTAINER=k3s)
EDGE_COMPUTE_ENV  = $(shell [ -f $(KUBECONFIG_LOCAL) ] && $(CE) ps --format '{{.Names}}' 2>/dev/null | grep -qx k3s && echo DROP_INTERCEPTOR_URL=http://localhost:$(INTERCEPTOR_PORT))

NODE_VERSION := $(shell cat .nvmrc 2>/dev/null)
NODE_BIN     := $(HOME)/.nvm/versions/node/v$(NODE_VERSION)/bin
NODE         := $(NODE_BIN)/node
NPM          := $(NODE_BIN)/npm

# Local S3 (Floci) defaults. Auth config (dev vs Google) comes from .env — see
# .env.example. With no .env, DROP_DEV_AUTH defaults to 1 (dev-auth).
ENV    := DROP_S3_BUCKET=$(BUCKET) DROP_S3_ENDPOINT=http://localhost:$(FLOCI_PORT) DROP_S3_KEY_ID=test DROP_S3_SECRET=test DROP_BASE_DOMAIN=$(BASE_DOMAIN) DROP_DATABASE_URL=postgres://drop:drop@localhost:$(PG_PORT)/drop
LOADENV := set -a; [ -f .env ] && . ./.env; : "$${DROP_DEV_AUTH:=1}"; set +a;

.DEFAULT_GOAL := help
.PHONY: help setup start stop restart status logs floci postgres publish login stop-all build reset trust-cert untrust-cert compute-up compute-down cluster-up cluster-down engine doctor up down nuke dev-console

help:
	@echo "Drop — local dev (node $(NODE_VERSION)):"
	@echo "  make doctor                     validate all tools + deps + VM/cluster needed to run"
	@echo "  make setup                      one-time: node $(NODE_VERSION) + deps + podman VM + floci image"
	@echo "  make start                      start Floci + api(:$(API_PORT)) + edge(:$(EDGE_PORT)) + https(nginx :$(HTTPS_PORT))"
	@echo "  make stop                       stop api + edge + nginx + Floci"
	@echo "  make tls                        (re)start just the nginx HTTPS proxy (HTTPS_PORT=8443 to avoid 443)"
	@echo "  make restart                    stop, then start"
	@echo "  make status                     show what's running"
	@echo "  make logs                       tail api + edge logs"
	@echo "  make publish DIR=./dist NAME=x  publish a folder and print its URL"
	@echo "  make dev-console                console dev loop: Vite + HMR on :5173, proxying to the api (:$(API_PORT))"
	@echo "  make login                      sign in with Google (server-mediated, real auth)"
	@echo "  make stop-all                   also stop the podman machine"
	@echo "  make reset                      wipe the Floci + Postgres volumes (all sites + metadata)"
	@echo "  make trust-cert                 trust the local HTTPS cert in the OS store (sudo)"
	@echo "  make untrust-cert               remove it again"
	@echo ""
	@echo "Compute plane (container apps + DBs).  Engine: $(CE)  (override: make CE=docker)"
	@echo "  make up                         FULL platform: cluster + Floci/PG + api/edge wired to k3s"
	@echo "  make down                       stop everything (k3s cluster PRESERVED → up resumes fast)"
	@echo "  make nuke                       like down but WIPE the cluster (rebuilt fresh next up)"
	@echo "  make cluster-up                 k3s-in-a-container + KEDA  — ANY engine (podman/docker/rancher)"
	@echo "  make cluster-down               tear it down"
	@echo "  make compute-up                 Floci EKS (AWS-faithful: ECR/RDS/IAM) — Docker only"
	@echo "  make compute-down               tear it down"
	@echo ""
	@echo "  corporate CA for image pulls:   make setup CORP_CA=~/certs/your-root-ca.cer"

# Compute plane — ENGINE-AGNOSTIC. Runs k3s directly as a container (podman / Docker
# Desktop / Rancher Desktop dockerd / colima), installs the Drop operators, and brings
# up Floci + Postgres. This is the reproducible local env; see infra/local/cluster-up.sh.
# Add managed databases + the aws secret backend with: DROP_COMPUTE_FULL=1 make cluster-up
cluster-up:
	@DROP_CONTAINER_ENGINE=$(CE) ./infra/local/cluster-up.sh

cluster-down:
	@DROP_CONTAINER_ENGINE=$(CE) ./infra/local/cluster-down.sh

# Compute plane — AWS-FAITHFUL via Floci EKS (real `aws eks` + ECR + RDS + IAM +
# Secrets emulation). Needs a real Docker daemon (Floci nests k3s via the Docker
# socket and refuses podman); see infra/local/compute-up.sh.
compute-up:
	@./infra/local/compute-up.sh

compute-down:
	@./infra/local/compute-down.sh

# Validate the full local toolchain + environment (non-destructive). Exits non-zero on failures.
doctor:
	@DROP_CONTAINER_ENGINE=$(CE) ./infra/local/doctor.sh

# Ensure the container engine is reachable: podman → start its VM; docker → verify the daemon.
engine:
	@if [ "$(CE)" = "podman" ]; then podman machine start >/dev/null 2>&1 || true; \
	elif [ -z "$(CE)" ]; then echo "✗ no container engine found — install podman or Docker"; exit 1; \
	else $(CE) info >/dev/null 2>&1 || { echo "✗ '$(CE)' daemon not reachable — start Docker Desktop / Rancher Desktop (dockerd) / colima"; exit 1; }; fi

# One-time local setup: Node (via nvm + .nvmrc), deps, container engine, Floci image.
# Engine is auto-detected (podman/docker); override with `make setup CE=docker`. Behind a
# TLS-inspecting proxy, pass CORP_CA=<root.cer> so the podman VM can pull images (podman only;
# for Docker/Rancher Desktop add the CA in the app's settings).
setup:
	@[ -n "$(CE)" ] || { echo "✗ no container engine found — install podman, Docker Desktop, Rancher Desktop, or colima, then re-run"; exit 1; }
	@echo "▸ container engine: $(CE)"
	@echo "▸ ensuring node $(NODE_VERSION) (via nvm)…"
	@export NVM_DIR="$(HOME)/.nvm"; [ -s "$$NVM_DIR/nvm.sh" ] && . "$$NVM_DIR/nvm.sh" && nvm install >/dev/null 2>&1 || true
	@test -x $(NODE) || { echo "✗ node $(NODE_VERSION) not at $(NODE_BIN) — install nvm, then 'nvm install'"; exit 1; }
	@echo "✓ node $$($(NODE) -v)"
	@echo "▸ installing dependencies…"; $(NPM) install >/dev/null 2>&1 && echo "✓ deps installed"
	@if [ "$(CE)" = "podman" ]; then \
	  podman machine inspect >/dev/null 2>&1 || { echo "▸ initializing rootful podman VM ($(VM_CPUS) CPU / $(VM_MEMORY) MiB / $(VM_DISK) GiB; downloads an image, ~1-3 min)…"; podman machine init --rootful --cpus $(VM_CPUS) --memory $(VM_MEMORY) --disk-size $(VM_DISK); }; \
	  if [ "$$(podman machine inspect --format '{{.Rootful}}' 2>/dev/null)" != "true" ]; then echo "▸ switching podman VM to rootful (required for the k3s compute plane)…"; podman machine stop >/dev/null 2>&1 || true; podman machine set --rootful >/dev/null 2>&1 || true; fi; \
	  podman machine start >/dev/null 2>&1 || true; \
	  if [ -n "$(CORP_CA)" ]; then \
	    ca=$$(eval echo $(CORP_CA)); \
	    if [ ! -f "$$ca" ]; then echo "✗ CORP_CA file not found: $$ca  (check the path/filename)"; exit 1; fi; \
	    echo "▸ injecting corp CA $$ca into the podman VM…"; \
	    cat "$$ca" | podman machine ssh "sudo tee /etc/pki/ca-trust/source/anchors/corp-ca.crt >/dev/null && sudo update-ca-trust" && \
	    podman machine stop >/dev/null 2>&1 && podman machine start >/dev/null 2>&1 && echo "✓ corp CA trusted"; \
	    mkdir -p $(RUN); printf '%s\n' "$$ca" > $(RUN)/corp-ca && echo "✓ corp CA recorded — 'make up' will auto-mount it into k3s ($$ca)"; \
	  fi; \
	else \
	  $(CE) info >/dev/null 2>&1 || { echo "✗ '$(CE)' daemon not reachable — start Docker Desktop / Rancher Desktop (dockerd) / colima, then re-run"; exit 1; }; \
	  [ -n "$(CORP_CA)" ] && echo "! CORP_CA with $(CE): add the CA in the engine's app settings (Docker/Rancher Desktop), not via podman machine"; \
	fi
	@echo "▸ pulling Floci image…"; $(CE) pull docker.io/floci/floci:latest >/dev/null 2>&1 \
	  && echo "✓ floci image ready" \
	  || echo "! could not pull floci — if behind a TLS-inspecting proxy, trust your corp CA in the engine"
	@echo "▸ pulling Postgres image…"; $(CE) pull $(PG_IMAGE) >/dev/null 2>&1 \
	  && echo "✓ postgres image ready" \
	  || echo "! could not pull postgres — if behind a TLS-inspecting proxy, trust your corp CA in the engine"
	@echo "✓ setup complete — run 'make start'"

build:
	@$(NODE) build.mjs

# Console dev loop: Vite dev server with HMR on :5173, proxying /v1 + auth routes to the
# local API (run `make start` first). Override the API origin with DROP_API_ORIGIN.
dev-console:
	@DROP_API_ORIGIN=$${DROP_API_ORIGIN:-http://localhost:$(API_PORT)} $(NODE_BIN)/npx vite dev --config console/vite.config.ts

# Trust the local HTTPS cert (infra/nginx/certs) in the OS root store so browsers
# stop warning — OS-detected (macOS / Linux / Windows). Generates the cert first if
# missing. Needs sudo. Tip: if mkcert is installed, gen-certs.sh already issues a
# browser-trusted cert and this is unnecessary.
trust-cert:
	@test -f $(CERT) || ./infra/nginx/gen-certs.sh
	@echo "▸ trusting $(CERT) on $$(uname -s) (sudo)…"
	@case "$$(uname -s)" in \
	  Darwin) sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$(CERT)" \
	    && echo "✓ added to the macOS System keychain — restart your browser" ;; \
	  Linux) \
	    if [ -d /usr/local/share/ca-certificates ]; then \
	      sudo cp "$(CERT)" /usr/local/share/ca-certificates/drop-localhost.crt && sudo update-ca-certificates >/dev/null && echo "✓ added to system trust (Debian/Ubuntu)"; \
	    elif [ -d /etc/pki/ca-trust/source/anchors ]; then \
	      sudo cp "$(CERT)" /etc/pki/ca-trust/source/anchors/drop-localhost.crt && sudo update-ca-trust && echo "✓ added to system trust (RHEL/Fedora)"; \
	    else echo "! unknown Linux trust store — add $(CERT) to your CA anchors manually"; fi; \
	    if command -v certutil >/dev/null 2>&1 && [ -d "$$HOME/.pki/nssdb" ]; then \
	      certutil -d "sql:$$HOME/.pki/nssdb" -A -t "C,," -n drop-localhost -i "$(CERT)" && echo "  + added to the NSS store (Chrome/Firefox)"; fi ;; \
	  *) echo "Windows — run in an elevated PowerShell:"; \
	     echo "  Import-Certificate -FilePath $(CERT) -CertStoreLocation Cert:\\LocalMachine\\Root" ;; \
	esac

untrust-cert:
	@case "$$(uname -s)" in \
	  Darwin) sudo security delete-certificate -c "*.drop.localhost" /Library/Keychains/System.keychain 2>/dev/null && echo "✓ removed from the macOS keychain" || echo "(not found)" ;; \
	  Linux) \
	    sudo rm -f /usr/local/share/ca-certificates/drop-localhost.crt /etc/pki/ca-trust/source/anchors/drop-localhost.crt; \
	    (command -v update-ca-certificates >/dev/null 2>&1 && sudo update-ca-certificates --fresh >/dev/null 2>&1) || (command -v update-ca-trust >/dev/null 2>&1 && sudo update-ca-trust); \
	    if command -v certutil >/dev/null 2>&1 && [ -d "$$HOME/.pki/nssdb" ]; then certutil -d "sql:$$HOME/.pki/nssdb" -D -n drop-localhost 2>/dev/null || true; fi; \
	    echo "✓ removed (Linux)" ;; \
	  *) echo "Windows — elevated PowerShell:"; \
	     echo "  Get-ChildItem Cert:\\LocalMachine\\Root | ? { \$$_.Subject -match 'drop.localhost' } | Remove-Item" ;; \
	esac

floci: engine
	@$(CE) ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-floci$$' || $(CE) run -d --rm --name drop-floci -p $(FLOCI_PORT):4566 -e FLOCI_STORAGE_MODE=hybrid -v $(FLOCI_VOLUME):/app/data docker.io/floci/floci:latest >/dev/null
	@for i in $$(seq 1 40); do curl -s -o /dev/null http://localhost:$(FLOCI_PORT)/ 2>/dev/null && break; sleep 1; done
	@echo "✓ floci  :$(FLOCI_PORT)  (persistent volume: $(FLOCI_VOLUME), engine: $(CE))"

postgres: engine
	@$(CE) ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-postgres$$' || $(CE) run -d --rm --name drop-postgres -p $(PG_PORT):5432 -e POSTGRES_USER=drop -e POSTGRES_PASSWORD=drop -e POSTGRES_DB=drop -v $(PG_VOLUME):/var/lib/postgresql $(PG_IMAGE) >/dev/null
	@for i in $$(seq 1 40); do $(CE) exec drop-postgres pg_isready -U drop -d drop >/dev/null 2>&1 && break; sleep 1; done
	@echo "✓ postgres  :$(PG_PORT)  (persistent volume: $(PG_VOLUME), engine: $(CE))"

# Local trusted HTTPS: nginx (in a container) terminates TLS on :$(HTTPS_PORT) and reverse-proxies
# to the HOST api/edge node processes via $(HOST_GW) — api.<domain> → api, *.<domain> → edge. The
# config is derived from infra/nginx/drop.conf (single source of truth) with the upstreams rewritten
# to the host ports. Idempotent: regenerates the cert if missing, recreates the container each call.
tls: engine
	@test -f $(CERT) || ./infra/nginx/gen-certs.sh
	@mkdir -p $(RUN)
	@sed -e 's#proxy_pass http://api:8080;#proxy_pass http://$(HOST_GW):$(API_PORT);#' \
	     -e 's#proxy_pass http://edge:8080;#proxy_pass http://$(HOST_GW):$(EDGE_PORT);#' \
	     infra/nginx/drop.conf > $(RUN)/nginx.conf
	@$(CE) rm -f drop-nginx >/dev/null 2>&1 || true
	@$(CE) run -d --rm --name drop-nginx --add-host $(HOST_GW):host-gateway -p $(HTTPS_PORT):443 \
	  -v $(CURDIR)/$(RUN)/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
	  -v $(CURDIR)/infra/nginx/certs:/etc/nginx/certs:ro \
	  $(NGINX_IMAGE) >/dev/null 2>&1 || true
	@sleep 1
	@if $(CE) ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-nginx$$'; then \
	  echo "✓ https  https://api.$(BASE_DOMAIN)$(HTTPS_SFX)/  ·  https://<name>.$(BASE_DOMAIN)$(HTTPS_SFX)/   (make trust-cert to silence warnings)"; \
	else \
	  echo "✗ nginx didn't start — port $(HTTPS_PORT) busy? try 'make tls HTTPS_PORT=8443'.  logs:"; $(CE) logs drop-nginx 2>&1 | tail -5; \
	fi

# Wipe the persistent volumes (all published sites + all metadata). Stops both first.
reset:
	@-$(CE) stop drop-floci drop-postgres >/dev/null 2>&1 || true
	@-$(CE) volume rm $(FLOCI_VOLUME) >/dev/null 2>&1 && echo "✓ wiped $(FLOCI_VOLUME)" || echo "(no floci volume to wipe)"
	@-$(CE) volume rm $(PG_VOLUME) >/dev/null 2>&1 && echo "✓ wiped $(PG_VOLUME)" || echo "(no postgres volume to wipe)"

start: floci postgres
	@mkdir -p $(RUN)
	@$(NODE) build.mjs >/dev/null && echo "✓ built bundles"
	@$(LOADENV) $(ENV) $(COMPUTE_ENV) DROP_HTTP_PORT=$(API_PORT)  nohup $(NODE) dist/api.js  > $(RUN)/api.log  2>&1 & echo $$! > $(RUN)/api.pid
	@$(LOADENV) $(ENV) $(EDGE_COMPUTE_ENV) DROP_HTTP_PORT=$(EDGE_PORT) DROP_EDGE_DISK_CACHE=$(RUN)/edge-cache nohup $(NODE) dist/edge.js > $(RUN)/edge.log 2>&1 & echo $$! > $(RUN)/edge.pid
	@if [ -n "$(COMPUTE_ENV)" ]; then \
	  pkill -f 'port-forward.*interceptor' 2>/dev/null || true; \
	  KUBECONFIG=$(KUBECONFIG_LOCAL) nohup kubectl -n keda port-forward svc/keda-add-ons-http-interceptor-proxy $(INTERCEPTOR_PORT):8080 > $(RUN)/pf-interceptor.log 2>&1 & echo $$! > $(RUN)/pf.pid; \
	fi
	@for i in $$(seq 1 30); do curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && break; sleep 1; done
	@curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && echo "✓ api    http://localhost:$(API_PORT)" || { echo "✗ api failed — see $(RUN)/api.log"; tail -5 $(RUN)/api.log; exit 1; }
	@echo "✓ edge   http://localhost:$(EDGE_PORT)  (routes by  Host: <name>.$(BASE_DOMAIN))"
	@if [ -n "$(COMPUTE_ENV)" ]; then echo "✓ compute mode — API wired to k3s; interceptor → :$(INTERCEPTOR_PORT)  (drop deploy works)"; \
	 else echo "· static-only — run 'make up' (or 'make cluster-up') for container apps / databases"; fi
	@$(MAKE) --no-print-directory CE=$(CE) tls
	@echo "next:  make publish DIR=./yourdist NAME=myapp"

stop:
	@-if [ -f $(RUN)/api.pid ];  then kill `cat $(RUN)/api.pid`  2>/dev/null; rm -f $(RUN)/api.pid;  fi
	@-if [ -f $(RUN)/edge.pid ]; then kill `cat $(RUN)/edge.pid` 2>/dev/null; rm -f $(RUN)/edge.pid; fi
	@-if [ -f $(RUN)/pf.pid ];   then kill `cat $(RUN)/pf.pid`   2>/dev/null; rm -f $(RUN)/pf.pid;   fi
	@-pkill -f 'dist/api.js'  2>/dev/null || true
	@-pkill -f 'dist/edge.js' 2>/dev/null || true
	@-pkill -f 'port-forward.*interceptor' 2>/dev/null || true
	@-$(CE) stop drop-nginx drop-floci drop-postgres >/dev/null 2>&1 || true
	@echo "✓ stopped api + edge + nginx + floci + postgres  ('make stop-all' also stops the podman VM)"

# Full platform UP: compute cluster (k3s + KEDA) + Floci/Postgres + api/edge wired to the cluster.
# Behind a TLS-inspecting proxy:  DROP_CORP_CA=~/certs/ca-bundle.pem make up
# Add managed databases + the aws secret backend:  DROP_COMPUTE_FULL=1 make up
# Just static sites (no cluster)?  use 'make start'.
up: cluster-up start

# Full platform DOWN: STOPS the k3s cluster (state preserved → next 'make up' resumes in seconds),
# then stops api/edge (+ port-forward) + Floci/Postgres. Data volumes persist.
down: cluster-down stop

# Like down, but WIPES the k3s cluster (KEDA, apps, DBs, imported images) — next 'make up' rebuilds
# it from scratch. Data volumes still persist (use 'make reset' to wipe Floci/Postgres data).
nuke:
	@DROP_CONTAINER_ENGINE=$(CE) DROP_WIPE=1 ./infra/local/cluster-down.sh
	@$(MAKE) --no-print-directory CE=$(CE) stop

stop-all: stop
	@if [ "$(CE)" = "podman" ]; then podman machine stop >/dev/null 2>&1 && echo "✓ podman machine stopped" || true; \
	else echo "(engine '$(CE)' is daemon-managed — stop Docker/Rancher Desktop yourself)"; fi

restart: stop start

status:
	@if [ "$(CE)" = "podman" ]; then echo "engine: podman (rootful=$$(podman machine inspect --format '{{.Rootful}}' 2>/dev/null || echo '?'), $$(podman machine inspect --format '{{.State}}' 2>/dev/null || echo 'no machine'))"; else echo "engine: $(CE)"; fi
	@curl -sf http://localhost:$(API_PORT)/healthz >/dev/null 2>&1 && echo "api:   up    (:$(API_PORT))" || echo "api:   down"
	@curl -s -o /dev/null http://localhost:$(EDGE_PORT)/ 2>/dev/null && echo "edge:  up    (:$(EDGE_PORT))" || echo "edge:  down"
	@($(CE) ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-nginx$$' && echo "https: up    (:$(HTTPS_PORT), nginx → api/edge)") || echo "https: down"
	@($(CE) ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-floci$$' && echo "floci: up    (:$(FLOCI_PORT))") || echo "floci: down"
	@($(CE) ps --format '{{.Names}}' 2>/dev/null | grep -q '^drop-postgres$$' && echo "pg:    up    (:$(PG_PORT))") || echo "pg:    down"
	@($(CE) ps --format '{{.Names}}' 2>/dev/null | grep -q '^k3s$$' && echo "k3s:   up    (:6443, engine: $(CE))") || echo "k3s:   down"

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
