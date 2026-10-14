# Rankwarden — production deployment plan

Status: **decided and built; not yet deployed.** The choices below were agreed on
2026-10-07, and everything the repository needs for them now exists and has been run on a
local Kubernetes cluster. What remains is the deployment itself, which waits for the
commercial launch. The procedure is in [deploy/README.md](deploy/README.md).

Prices were read from the providers' pricing pages on 2026-10-07 and will drift; re-check
before buying.

This covers the ingestion service in this repository and its database, and leaves room for
the two applications that follow it: a backend that reads the database and calls this
service's sync endpoints, and a public front end that talks only to that backend.

---

## 1. Decisions

| Decision      | Choice                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| Hosting       | **DigitalOcean**, region **FRA1** (Frankfurt)                                    |
| Orchestration | **DigitalOcean Kubernetes (DOKS)**, standard control plane (free)                |
| Nodes         | 2 × Basic 2 vCPU / 4 GB, autoscaling 2–3                                         |
| Database      | **MongoDB 8.3 self-hosted in the cluster**, one StatefulSet on a 20 GiB volume   |
| Backups       | Daily `mongodump` to a DigitalOcean Spaces bucket, kept 14 days                  |
| Images        | GitHub Container Registry                                                        |
| Deploys       | Helm, driven by `deploy/scripts/deploy.sh`; a schema Job runs before the service |
| This service  | **One replica, `Recreate` strategy, no autoscaler, no public hostname**          |
| Season purge  | **Real**, not a dry run: a finished, archived season leaves the live collections |
| Public entry  | Decided with the front end (§3.3)                                                |

Estimated cost at launch: **about $55 a month** (§3.4).

---

## 2. What was measured

Sizing rests on measurements from this repository, not on guesses.

### 2.1 The application under load

The built app was run for 8.5 minutes and sampled every 5 seconds, through boot, a full PvP
sweep (332 brackets in 54 s), a profile-enrichment pass (3,951 requests) and a Mythic+ pass
(1,001 pages).

| Metric           | Value                                                |
| ---------------- | ---------------------------------------------------- |
| Memory, steady   | ~195 MB average, 157–235 MB                          |
| Memory, peak     | **398 MB**, in the first minute (boot + first sweep) |
| CPU, average     | 0.09 core                                            |
| CPU, 95th / peak | 0.21 / **0.40** core                                 |

A sweep and the start of enrichment in a container on the local cluster, on Node 24,
peaked at 220 MB.

The service is I/O-bound: it waits on Blizzard, Raider.io and MongoDB far more than it
computes. These came from short runs on a development machine; re-check with real pod
metrics after a week (§5.3).

### 2.2 The database

Development database, with the archive holding one region:

| Collection        | Documents | On disk | Indexes |
| ----------------- | --------- | ------- | ------- |
| `archive_entries` | 2,046,023 | 128 MB  | 102 MB  |
| `characters`      | 178,587   | 51 MB   | 26 MB   |
| `mplus_runs`      | 40,032    | 23 MB   | 7 MB    |
| five `*_ratings`  | 288,993   | 15 MB   | 23 MB   |
| everything else   | ~38,000   | ~20 MB  | ~5 MB   |
| **Total**         | 2.59 M    | 235 MB  | 163 MB  |

Projection with all four regions archived: `SKILLS.md` puts the full PvP archive at
~19.7 M rows. At the measured ~112 bytes per row on disk and in indexes that is about
**2.3 GB**, and the whole database lands around **4–6 GB** once the Mythic+ archive and
raid data fill in. The collections queried constantly (`characters`, ratings, live Mythic+)
need under 150 MB of index in memory; the archive is large but cold.

A compressed backup of a freshly swept database (577,000 documents) was 16 MB.

---

## 3. Hosting

### 3.1 Why DigitalOcean

- **Managed Kubernetes with a free control plane.** You pay for nodes only.
- **What the public site will need is in one place:** a load balancer with a static public
  IP, DNS hosting, block storage for the database and object storage for its backups.
- **Frankfurt** keeps the database and the future site close to European users. Blizzard
  and Raider.io are reached over the public internet from anywhere.

Nothing in the charts is DigitalOcean-specific beyond the storage class name and the
backup endpoint, both of which are values.

### 3.2 Database: self-hosted, and what that costs in work

Running MongoDB in the cluster instead of buying DigitalOcean's managed plan saves about
$30 a month. In exchange, three things become this repository's responsibility. All three
are built:

- **Durability.** One StatefulSet on one DigitalOcean block-storage volume. The volume
  survives pod restarts and node replacement. There is **no second copy**: a node failure
  means the database is unavailable for the minutes it takes Kubernetes to re-attach the
  volume elsewhere, and the service's readiness answers 503 for that time.
- **Backups.** A CronJob dumps the database every night and uploads the archive to a Spaces
  bucket, outside the cluster. A restore was tested. Worst case, a day of data is lost;
  live data refills within an hour, and the archive for seasons Blizzard still serves can
  be fetched again. **Seasons Blizzard no longer serves cannot**, which is why the backup
  is not optional.
- **Access.** Authentication is on; five users with separate rights (see
  [deploy/README.md](deploy/README.md)); a network policy admits only labelled pods and the
  `backend` namespace.

Standalone rather than a replica set, because the application uses no transactions or
change streams. If the site's availability ever needs the database to survive a node
failure without a gap, that is the point to move to a three-member replica set or to the
managed plan. That is a change of connection string, not of application code.

### 3.3 Public domains and the public entry

No host hands out a production domain; that part works the same everywhere:

1. **Register a domain** at a registrar (Cloudflare Registrar or Namecheap; a `.com` is
   about $10–15 a year).
2. **Point its DNS** at the load balancer's public IP. DigitalOcean hosts DNS zones for
   free; Cloudflare is the alternative and adds a free CDN and DDoS protection in front of
   the site.
3. **TLS certificates** are issued and renewed inside the cluster by cert-manager using
   Let's Encrypt, at no cost.

| Hostname             | Goes to                | Public |
| -------------------- | ---------------------- | ------ |
| `example.com`, `www` | front end              | yes    |
| `api.example.com`    | backend                | yes    |
| _none_               | Rankwarden (this repo) | **no** |

**Nothing for the public entry is built yet, on purpose.** This service needs none, and
the choice of controller belongs to the front end's deployment. One thing is already
settled: **not ingress-nginx.** It was the default answer for years and was retired in
March 2026, with no further security fixes. Use a Gateway API implementation instead
(DOKS runs Cilium, which has one — check that it is enabled on the cluster; Envoy Gateway is a
common alternative).

### 3.4 Cost

| Item                                      | Monthly  |
| ----------------------------------------- | -------- |
| DOKS control plane                        | $0       |
| 2 × Basic node, 2 vCPU / 4 GB             | $48      |
| Block storage for the database, 20 GiB    | ~$2      |
| Spaces bucket for backups                 | ~$5      |
| Container registry (GHCR)                 | $0       |
| **Total at launch**                       | **~$55** |
| Later: load balancer, for the public site | +$12     |
| Later: domain                             | +~$1     |

The node and load-balancer prices were read from DigitalOcean's pages; block storage and
Spaces are from memory of their list prices and should be checked.

Capacity: the database requests 1 GiB of memory (limit 2 GiB) and the service 384 MiB
(limit 768 MiB), which leaves most of the second node free. A backend and a front end at
two replicas each should still fit; the node pool grows to three if they do not.

---

## 4. Architecture

```
                      Internet
                         |
              (later) Load Balancer + Gateway
                         |
   ┌──────────── DOKS cluster, FRA1 ─────────────────────────────┐
   |   ns: frontend (later)     ns: backend (later)              |
   |   front end ─────────────▶ backend                          |
   |                             |        |                      |
   |                        sync |        | read-only            |
   |   ns: rankwarden            ▼        ▼                      |
   |   ┌───────────────────────────┐   ┌──────────────────────┐  |
   |   | rankwarden  (1 replica)   |──▶| mongodb (StatefulSet)|  |
   |   | schema Job  (per release) |──▶|  20 GiB volume       |  |
   |   └────────────┬──────────────┘   └──────────┬───────────┘  |
   └────────────────┼─────────────────────────────┼──────────────┘
                    ▼                             ▼
          Blizzard, Raider.io            Spaces bucket (backups)
```

- **Rankwarden has no ingress.** It is a `ClusterIP` service, reachable in-cluster as
  `http://rankwarden.rankwarden.svc.cluster.local:3000`.
- **A NetworkPolicy admits only the `backend` namespace.** Required, not optional:
  `POST /characters/sync` and the health endpoints have no authentication (`SKILLS.md`
  §13), so the network is the only thing protecting them.
- **A second NetworkPolicy does the same for the database**, admitting labelled pods in
  its own namespace and the `backend` namespace.

---

## 5. Running this service as a singleton

### 5.1 Why it must be one instance

Every scheduler runs on in-process timers, the job priorities live in an in-memory
coordinator, and the Blizzard hourly budget is counted in memory. Two instances would both
sweep, both enrich, and together spend twice the Blizzard quota with neither aware of the
other.

### 5.2 How Kubernetes is told

| Setting                         | Value          | Reason                                                                                                              |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `replicas`                      | `1`            | Hard-coded in the chart; there is no value to change it.                                                            |
| `strategy.type`                 | **`Recreate`** | The default, `RollingUpdate`, starts the new pod before stopping the old one, so two would run during every deploy. |
| HorizontalPodAutoscaler         | none           | Must never be attached.                                                                                             |
| PodDisruptionBudget             | none           | With one replica it would only block node maintenance.                                                              |
| `terminationGracePeriodSeconds` | `60`           | An idle service stops in under a second; a job in flight is cut short and resumes on the next start.                |

Measured on the local cluster across a rollout, sampled five times a second: never more
than one running container, and a brief moment with none.

**Known limit.** `Recreate` prevents overlap during deploys, which is the realistic case.
It does not cover a node that loses contact with the control plane while its pod keeps
running. If that ever matters, the fix is a lease document in MongoDB that the service
must hold to run its jobs. Not built.

**Restart cost.** The Blizzard budget is forgotten on restart (`SKILLS.md` §4.0), so the
first hour after a deploy can overspend slightly. Avoid deploying several times within an
hour during an archive backfill. The Raider.io window is persisted and survives restarts.

### 5.3 CPU and memory

| Resource | Request | Limit   | Reasoning                                                                                      |
| -------- | ------- | ------- | ---------------------------------------------------------------------------------------------- |
| CPU      | `150m`  | _none_  | Average 0.09 core, peak 0.40. No CPU limit: throttling an I/O-bound process only adds latency. |
| Memory   | `384Mi` | `768Mi` | Steady ~200 MB, peak 398 MB. The limit is about twice the observed peak.                       |

`NODE_OPTIONS=--max-old-space-size=512` keeps Node's own heap limit below the container
limit, so a leak shows up as a readable JavaScript out-of-memory error instead of a silent
kill.

After a week in production, compare against `kubectl top pod` and adjust. A full
four-region archive backfill and the raid jobs were not running during the measurement.

### 5.4 Health probes

| Probe     | Endpoint            | Notes                                                                                |
| --------- | ------------------- | ------------------------------------------------------------------------------------ |
| startup   | `GET /health`       | Up to 2 minutes, to cover boot.                                                      |
| liveness  | `GET /health`       | Touches no dependency, so a slow database can never get a healthy process killed.    |
| readiness | `GET /health/ready` | 503 only when MongoDB is unreachable; a Blizzard outage reports `degraded` with 200. |

---

## 6. Database structure and configuration

### 6.1 Schema before application

The service no longer builds its own database structure in production.

1. **`npm run db:schema`** creates every collection in `src/database/collections.ts`,
   builds every index declared in the `*.indexes.ts` files, drops retired ones, and
   verifies the result. Safe to run repeatedly.
2. **A Kubernetes Job runs it before the service on every release**, as a Helm
   `pre-install` / `pre-upgrade` hook, with a database user allowed to change structure.
   If it fails, the release stops and the running version stays up.
3. **The service starts with `DB_SCHEMA_MODE=verify`**: it compares what exists with what
   is declared, changes nothing, and refuses to start if something is missing. Its
   database user is not allowed to create or drop an index. Development and tests keep
   `ensure`, which builds the structure at startup as before.

### 6.2 Environment variables

| Kind       | Where                  | Which                                                                              |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------- |
| Secret     | Kubernetes `Secret`    | `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `RAIDER_IO_API_KEY`, `MONGODB_URI` |
| Non-secret | Kubernetes `ConfigMap` | the other 80, from `deploy/helm/rankwarden/env/production.env`                     |

The file is committed, so every production setting is reviewable. Three guards stand
around it: CI validates it with the service's own rules, a unit test rejects a variable
name the service does not read or one it forgot to set, and the chart refuses to render if
a credential appears in it.

Values that deliberately differ from development:

| Variable               | Production | Why                                                                                                                 |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | production | Also makes every `/admin/*` route return 404.                                                                       |
| `DB_SCHEMA_MODE`       | verify     | §6.1.                                                                                                               |
| `SEASON_PURGE_DRY_RUN` | false      | As decided: a finished season is removed once its successor has started and its archive is complete.                |
| `ARCHIVE_MIN_SEASON`   | 27         | Blizzard serves 27 and later. 22–26 answer 403, which is not treated as permanent, so they would be retried hourly. |
| `MPLUS_*_ENABLED`      | true       | As run in development.                                                                                              |
| `RAID_*_ENABLED`       | false      | **Open** (§8): the raid jobs have only run in the test suite.                                                       |

---

## 7. What was built

| Item                        | Where                                                               |
| --------------------------- | ------------------------------------------------------------------- |
| Schema command, verify mode | `src/database/schema/`, `src/schema.main.ts`                        |
| Config check command        | `src/config-check.main.ts`                                          |
| Container image             | `Dockerfile`, `.dockerignore` — Node 24, non-root, 322 MB           |
| Database chart              | `deploy/helm/mongodb/` — StatefulSet, users, network policy, backup |
| Service chart               | `deploy/helm/rankwarden/` — singleton, schema Job, network policy   |
| Production settings         | `deploy/helm/rankwarden/env/production.env`                         |
| Scripts                     | `deploy/scripts/` — provision, secrets, deploy                      |
| Pipelines                   | `.github/workflows/` — CI, release, manual deploy                   |
| Procedure                   | `deploy/README.md`                                                  |

What was and was not verified is listed at the end of `deploy/README.md`. In short:
everything inside the cluster was exercised on a local one; the three things that need a
real account — creating the DigitalOcean cluster, the GitHub workflows, pulling from the
registry — have never run.

---

## 8. Still open

1. **Raid jobs in production.** `RAID_CATALOGUE_ENABLED` and `RAID_RANKINGS_ENABLED` are
   off in `production.env`, matching development. Turn them on there when wanted.
2. **Starting data.** Start empty, which proves the whole pipeline and refills live data
   within the hour while the archive backfills over a day or two; or restore a dump of the
   development database to keep the archive already fetched. Starting empty is also the
   safe choice for the purge: it acts on the first check after a start, and a restored
   database may hold finished seasons it would retire at once (`deploy/README.md`, step 4).
3. **Domain name**, and whether Cloudflare sits in front. Needed only with the front end.
4. **Access to the private package from CI.** One of two settings has to be made before
   the workflows can install dependencies (`deploy/README.md`, step 1).

---

## 9. Rollout, when the time comes

| Phase | What                                                                       | Done when                                                |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1     | Tag a version; the Release workflow publishes the image                    | The image is in GHCR                                     |
| 2     | `provision-digitalocean.sh`; create the Spaces bucket and its key          | `kubectl get nodes` shows two ready nodes                |
| 3     | `create-secrets.sh`, then `deploy.sh <tag>`                                | The pod is `Ready`; `/health/ready` reports MongoDB `ok` |
| 4     | Watch the first day: sweep, enrichment, archive backfill, the first backup | Readiness stays `ok`; a backup archive is in the bucket  |
| 5     | After a week, check memory and CPU against §5.3 and adjust                 | Resource settings confirmed                              |
| 6     | Later, with the backend and front end: gateway, certificates, domain       | The site is reachable on the domain over HTTPS           |

---

## Sources

- [DigitalOcean Kubernetes pricing](https://www.digitalocean.com/pricing/kubernetes)
- [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- [DigitalOcean Managed Databases pricing](https://www.digitalocean.com/pricing/managed-databases)
- [MongoDB Atlas pricing](https://www.mongodb.com/pricing)
- [Ingress NGINX retirement](https://kubernetes.dev/blog/2025/11/12/ingress-nginx-retirement)
- [Ingress NGINX: statement from the Kubernetes Steering and Security Response Committees](https://www.kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)
- [Hetzner 2026 price increase](https://findstack.com/resources/hetzner-price-increase-2026)
