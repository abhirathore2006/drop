# Drop Helm chart

Deploys the **api** + **edge** as Deployments behind one Ingress, backed by S3.
No database. One image (`infra/Dockerfile`) with both bundles; the command is
overridden per Deployment (`node dist/api.js` / `node dist/edge.js`).

## Prereqs
- An image pushed to your registry (ECR): `podman build -f infra/Dockerfile -t <repo>/drop:<tag> . && podman push …`
- A wildcard TLS cert for `*.<baseDomain>` (ACM via ingress annotations, or a TLS Secret).
- An IAM role (IRSA) with read/write on the S3 bucket, referenced from `serviceAccount.annotations`.
- A Secret with `DROP_GOOGLE_CLIENT_SECRET` + `DROP_SESSION_SECRET` (e.g. via External Secrets),
  or set `secret.create=true`.
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
- **Edge cache:** `edge.diskCache` is on by default as a per-pod `emptyDir` (asset bytes
  on disk; memory holds only the version pointer). Use `type=pvc` only with
  `edge.replicaCount=1` or a ReadWriteMany class — for multiple replicas keep `emptyDir`.
- **Autoscaling:** set `api.autoscaling.enabled` / `edge.autoscaling.enabled` (HPA on CPU).
- See `values.yaml` for all knobs; `helm lint` / `helm template` to preview.
