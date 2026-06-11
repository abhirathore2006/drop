# `podman compose` (Docker-compatible provider) is preferred. The API's
# ensureBucket() retries against Floci, so a brief startup race is self-healing.
COMPOSE ?= podman compose -f docker-compose.yml

.PHONY: up down logs ps test-integration

up:
	$(COMPOSE) up --build -d
	@echo "api: http://localhost:8080  edge: http://localhost:8090  floci (S3): http://localhost:4566"

down:
	$(COMPOSE) down -v

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

# Bring up Floci only, run integration tests against it, tear down.
test-integration:
	$(COMPOSE) up -d floci
	@echo "waiting for floci..."
	@sleep 4
	cd .. && DROP_TEST_S3_ENDPOINT='http://localhost:4566' DROP_TEST_S3_BUCKET='drop-itest' \
	  DROP_TEST_S3_KEY_ID='test' DROP_TEST_S3_SECRET='test' \
	  bun test
	$(COMPOSE) down -v
