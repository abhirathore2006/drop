# Drop Terraform

Infrastructure-as-code for deploying Drop to AWS. The configuration is split into
independent **configs**, each with its own state:

| Config        | What it manages                                                        |
| ------------- | --------------------------------------------------------------------- |
| `foundation/` | Shared, long-lived resources: ECR repo, IAM, security groups, ACM cert, Route53 records, anything both runtimes need. |
| `eks/`        | Runs Drop on Amazon EKS (Kubernetes). Reads `foundation` via remote state. |
| `ecs/`        | Runs Drop on Amazon ECS/Fargate. Reads `foundation` via remote state. |

You deploy `foundation` once, then **either** `eks` **or** `ecs` (or both, if you
want them side by side). Each config keeps its own state file, so they never
collide — see [One AWS account, many states](#one-aws-account-many-states).

---

## Which config: static sites vs the full PaaS

Drop runs in two modes, and the runtime choice maps directly onto them:

| You want…                                                  | Use            | Mode |
| ---------------------------------------------------------- | -------------- | ---- |
| **Just the static-site host** — publish/serve sites, orgs, custom domains | `ecs/` **or** `eks/` (default) | **static-only** |
| **The full PaaS** — static sites **plus** container apps, managed Postgres, write-only app secrets | `eks/` with `compute_enabled = true` | **compute** |

- **`ecs/` (Fargate) is always static-only.** It runs the `api` + `edge` tasks
  behind an ALB. There is no Kubernetes, so `/v1/apps`, `/v1/databases` and the
  app-secret routes return `501`. This is the simplest, cheapest "just a web app"
  deploy — pick it if you only need to publish sites.

- **`eks/` defaults to static-only too** (`compute_enabled = false`): same feature
  set as ECS, just on Kubernetes. Set **`compute_enabled = true`** to switch it
  into the full PaaS — that installs the cluster operators (`eks/compute.tf`:
  KEDA + KEDA HTTP add-on, CloudNativePG + Barman Cloud, External Secrets, a
  `gvisor` RuntimeClass) and grants the Drop API the in-cluster RBAC to drive
  them. See the [compute prerequisites](#compute-plane-prerequisites-eks-only)
  below.

So: **need container apps or managed databases → `eks/` with `compute_enabled =
true`.** Otherwise either runtime works and ECS is the lighter pick.

---

## Prerequisites

Before running any `terraform`/`tofu` command you need the following to already
exist. Terraform here **consumes** them; it does not create them.

1. **An S3 bucket for Terraform state.**
   Each config's `backend.tf` names a bucket (the `bucket = "..."` line) and a
   distinct `key` (the state path). Create the bucket once, up front, and turn on
   versioning so you can recover a clobbered state:

   ```sh
   aws s3api create-bucket \
     --bucket drop-tfstate \
     --region us-east-1
   aws s3api put-bucket-versioning \
     --bucket drop-tfstate \
     --versioning-configuration Status=Enabled
   ```

   Use the same bucket name in every `backend.tf` (the `key` differs per config).

2. **An existing VPC with private subnets.**
   You pass the VPC ID and the private subnet IDs in as variables (see each
   config's `variables.tf` / `*.tfvars`). Workloads run in the private subnets;
   the configs do not provision a VPC.

3. **A Route53 hosted zone** for the domain Drop will be served on.
   `foundation` looks the zone up (by name or zone ID) and creates records under
   it, so the zone must already be delegated and resolvable.

4. **The Drop image pushed to ECR.**
   The image is built from `infra/Dockerfile`, which copies the pre-built esbuild
   bundles from `dist/` — so you build the bundles first, then the image:

   ```sh
   # from the repo root
   node build.mjs
   docker build -f infra/Dockerfile -t <account>.dkr.ecr.<region>.amazonaws.com/drop:<tag> .

   # log in and push
   aws ecr get-login-password --region <region> \
     | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
   docker push <account>.dkr.ecr.<region>.amazonaws.com/drop:<tag>
   ```

   The single image carries both roles (`api`, `edge`); the runtime config
   overrides the command per role. If the ECR repo itself is managed by
   `foundation`, apply `foundation` first so the repo exists, then build & push,
   then apply `eks`/`ecs` referencing the `<tag>`.

5. **Tooling:** Terraform **>= 1.10** *or* OpenTofu **>= 1.10**, plus the AWS CLI
   configured with credentials for the target account. (The version floor matters
   for state locking — see below.)

---

## State locking: S3-native, no DynamoDB

These configs use **S3-native locking** (`use_lockfile = true` in `backend.tf`).
On Terraform >= 1.10 and OpenTofu >= 1.10 this **replaces the old DynamoDB lock
table** — you do **not** need to create or reference a DynamoDB table anywhere.

How it works: when a run starts, Terraform writes a small `<key>.tflock` object
next to your state in the same bucket using an S3 *conditional write*
(`If-None-Match`). If the lock object already exists, the write fails and the run
refuses to start — that's the lock. When the run finishes, the `.tflock` object is
deleted. So locking is just an extra object in the state bucket; there is no
second service to provision, pay for, or keep IAM-permissioned.

If a run is killed mid-flight and leaves a stale lock, clear it with:

```sh
terraform force-unlock <LOCK_ID>   # the LOCK_ID is printed in the error
```

---

## Apply order

`foundation` exports outputs that `eks`/`ecs` read through a
`terraform_remote_state` data source. So the order is fixed:

```
1. foundation     <-- must exist first
2. eks  OR  ecs   <-- reads foundation's remote state
```

Never apply `eks`/`ecs` before `foundation` has been applied at least once —
their remote-state lookup will find nothing and the plan will fail.

To tear down, reverse it: destroy `eks`/`ecs` first, then `foundation`.

---

## Per-config workflow

Each config is initialized and applied on its own. Run these from inside the
config directory (e.g. `cd foundation`). Substitute `tofu` for `terraform` if you
use OpenTofu.

### 1. Initialize the backend

`backend.tf` pins the bucket, key, region, and `use_lockfile = true`. If a config
ships a partial backend (values left out so they can vary per environment), pass
them with `-backend-config`:

```sh
# from infra/terraform/foundation
terraform init \
  -backend-config="bucket=drop-tfstate" \
  -backend-config="key=drop/foundation.tfstate" \
  -backend-config="region=us-east-1"
```

Repeat per config, changing only the `key`:

```sh
# eks
terraform init -backend-config="key=drop/eks.tfstate"   ...
# ecs
terraform init -backend-config="key=drop/ecs.tfstate"   ...
```

If `backend.tf` already hard-codes these values, a plain `terraform init` is
enough.

### 2. Plan and apply with tfvars

Pass environment-specific inputs (VPC ID, subnet IDs, hosted zone, image tag,
etc.) via a `*.tfvars` file:

```sh
terraform plan  -var-file=prod.tfvars
terraform apply -var-file=prod.tfvars
```

### Full sequence (foundation → eks)

```sh
# --- foundation ---
cd infra/terraform/foundation
terraform init -backend-config="key=drop/foundation.tfstate"
terraform apply -var-file=prod.tfvars

# build & push the image now that the ECR repo exists (see Prerequisites)

# --- eks ---
cd ../eks
terraform init -backend-config="key=drop/eks.tfstate"
terraform apply -var-file=prod.tfvars
```

Swap `eks` for `ecs` to deploy on Fargate instead.

To bring `eks` up as the **full PaaS** instead of static-only, set
`compute_enabled = true` in your tfvars (plus `image_registry` and
`blocked_egress_cidrs`) — see the next section.

---

## Compute-plane prerequisites (EKS only)

Setting `compute_enabled = true` is what turns the EKS deploy from a static-site
host into the full Drop PaaS. When it's on, the `eks/` config additionally:

1. **Installs the cluster operators** (`eks/compute.tf`), mirroring the verified
   local stack (`infra/local/compute-up.sh`):
   - **KEDA** + the **KEDA HTTP add-on** — scale-to-zero + HTTP routing for apps;
   - **CloudNativePG** + the **Barman Cloud Plugin** — managed Postgres + backups;
   - **External Secrets Operator** — only used by the `aws` secret backend;
   - a **`gvisor` RuntimeClass** — sandbox for untrusted tenant images. NOTE: the
     `runsc` handler must also be installed on the nodes (a gVisor-enabled node
     group / DaemonSet); the config only registers the class.
2. **Turns on the Drop chart's `compute.enabled`**, which grants the API
   ServiceAccount the in-cluster RBAC (`infra/helm/drop/templates/rbac.yaml`) and
   sets `DROP_KUBECONFIG=in-cluster` so the API drives the cluster via its pod SA.

Two extra variables are **required** when `compute_enabled = true`:

| Variable               | What it is |
| ---------------------- | ---------- |
| `image_registry`       | Registry for **tenant app images**, e.g. `<acct>.dkr.ecr.<region>.amazonaws.com/drop-apps`. Keep this **separate** from the `drop` platform-image repo. |
| `blocked_egress_cidrs` | Your cluster's pod + service CIDRs (e.g. `10.0.0.0/8,172.20.0.0/16`), excluded from the tenant HTTPS egress allowlist so tenant pods can't reach in-cluster services. |

The `barman_plugin` step shells out to `kubectl apply` (the plugin's documented
install path), so the apply environment needs **`kubectl` on PATH with credentials
for the new cluster**. Everything else is pure Terraform.

> **Not live-applied here.** The compute layer is mirrored from the verified local
> stack but has not been `terraform apply`-tested against a real EKS cluster in this
> repo. The in-cluster auth code and the Helm chart rendering *are* verified
> (`bun test`, `helm template`). Treat the operator versions as a starting point and
> reconcile against your cluster's Kubernetes version before applying.

---

## One AWS account, many states

A single AWS account can hold **foundation + eks + ecs at once** without conflict,
because each config writes to a **different state key** in the same bucket:

```
s3://drop-tfstate/
  drop/foundation.tfstate   (+ drop/foundation.tfstate.tflock while locked)
  drop/eks.tfstate          (+ .tflock while locked)
  drop/ecs.tfstate          (+ .tflock while locked)
```

Separate keys mean:

- separate, independently-lockable state — running `eks` never blocks `foundation`;
- you can `apply`/`destroy` one runtime without touching the other;
- the shared layer (`foundation`) is owned in exactly one place and consumed by
  the rest via remote state.

To run multiple isolated environments (e.g. `staging` and `prod`) in the same
account, keep the same config but vary the `key` prefix per environment
(`staging/foundation.tfstate`, `prod/foundation.tfstate`) and the matching
`*.tfvars`.
