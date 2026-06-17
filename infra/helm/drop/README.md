# Drop Helm chart

Deploys the **api** + **edge** as Deployments behind one Ingress. File bytes are
stored in S3; all metadata lives in an **external Postgres** (the chart does not
bundle a database). One image (`infra/Dockerfile`) with both bundles; the command
is overridden per Deployment (`node dist/api.js` / `node dist/edge.js`).

The API runs schema migrations on boot under a Postgres advisory lock, so a
multi-replica rollout is safe (one pod migrates, the rest wait then serve). The
edge connects read-only and never migrates.

## Prereqs
- An image pushed to your registry (ECR): `podman build -f infra/Dockerfile -t <repo>/drop:<tag> . && podman push …`
- A wildcard TLS cert for `*.<baseDomain>` (ACM via ingress annotations, or a TLS Secret).
- An IAM role (IRSA) with read/write on the S3 bucket, referenced from `serviceAccount.annotations`.
- A managed **Postgres** (RDS / CloudSQL / company DB) reachable from the cluster.
- A Secret with `DROP_GOOGLE_CLIENT_SECRET`, `DROP_SESSION_SECRET`, and
  `DROP_DATABASE_URL` (e.g. via External Secrets), or set `secret.create=true`.
- A Google **Web application** OAuth client whose redirect URI is `https://<apiHost>/auth/callback`.

## Install
```bash
helm upgrade --install drop infra/helm/drop \
  --namespace drop --create-namespace \
  --set image.repository=<acct>.dkr.ecr.<region>.amazonaws.com/drop \
  --set image.tag=0.1.0 \
  --set baseDomain=drop.company.com --set apiHost=api.drop.company.com \
  --set config.s3Bucket=drop-sites --set config.s3Region=<region> \
  --set config.allowedDomains=paytm.com \
  --set googleClientId=<id>.apps.googleusercontent.com \
  --set secret.existingSecret=drop-secrets \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::<acct>:role/drop-s3 \
  --set ingress.className=alb \
  --set ingress.annotations."alb\.ingress\.kubernetes\.io/certificate-arn"=<acm-arn>
```
Then point DNS: `api.<baseDomain>` and `*.<baseDomain>` → the ingress/ALB.

## Notes
- **Edge cache:** a per-pod **`emptyDir`** (ephemeral node-local disk) — asset bytes on
  disk, memory holds only the version pointer. It's just a cache (S3 is source of truth),
  so it needs no persistence or sharing and scales to any replica count; a restarted pod
  re-warms from S3. Tune with `edge.diskCache.sizeBytes` (LRU cap) / `sizeLimit` (disk cap).
- **Autoscaling:** set `api.autoscaling.enabled` / `edge.autoscaling.enabled` (HPA on CPU).
- See `values.yaml` for all knobs; `helm lint` / `helm template` to preview.
