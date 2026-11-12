# Deployment runbook (one VPS)

How to put the Docker Compose stack (`compose.yaml`, system_design.md §5) on a fresh server, and how to update it.
The commands assume Ubuntu 24.04 LTS and are run from the repository folder on the server.
After the first setup, GitHub Actions deploys every merge into `main` (section 11), and the `backup`
service dumps the database every night (section 12).

## 1. Before you start

- A VPS with ports 80 and 443 open to the internet.
- A DNS `A` record for the site's host name (for example `menu.domain.com`) pointing to the VPS.
- A Cloudflare R2 bucket, an API token for it, and a public custom domain for the bucket.
- A second, private R2 bucket for database backups, with its own API token (section 12.1).
- The two images on GitHub Container Registry, public: see section 11.1 (checked once, after the first
  merge into `main`).

## 2. Install Docker and Certbot

Install Docker Engine with the Compose plugin as described in the official guide
(https://docs.docker.com/engine/install/ubuntu/). Then install Certbot on the host
(it is not a container, decision D2 of step 12):

```bash
sudo apt install certbot
sudo mkdir -p /var/www/certbot
```

## 3. Get the code and write `.env`

```bash
git clone https://github.com/venousSy/tartus_menu.git
cd tartus_menu
cp .env.example .env
chmod 600 .env
```

Fill in every value of `.env` (the comments in the file explain each one). For the four secrets
(`DJANGO_SECRET_KEY`, `DB_MIGRATE_PASSWORD`, `DB_PASSWORD`, `FRONTEND_REVALIDATE_SECRET`) use a new random
value each (the two database roles are explained in section 16):

```bash
openssl rand -hex 32
```

`DJANGO_ADMIN_PATH` must be a long random word, never `admin`. Keep it private: it is the address of the
Django admin site.

## 4. First certificate

Nginx needs a certificate before it can start, so the first one is taken with Certbot's own small web
server while port 80 is still free:

```bash
sudo certbot certonly --standalone -d menu.domain.com
```

## 5. Start the stack and prepare the database

```bash
docker compose pull
docker compose up -d
docker compose logs migrate
```

`pull` downloads the images that CI built from the newest commit on `main` (tag `latest`).
`up` first runs the one-shot `migrate` service and starts the website only after it succeeded. That service
runs three commands as the owner role (section 16), at every `up`, and all are safe to repeat: `migrate`
(creates or updates the tables), `createcachetable` (the table for the login rate-limit counters) and
`create_app_role` (the role the website connects as, with its rights). Its log must end with
`The role ... may read and write rows in ...`.

## 6. Create the subscription plans

A new database has no plans, and cafes cannot be created without one. This creates Basic (5 categories,
20 items, no images or branding) and Pro (unlimited, images and branding), the example of
system_design.md §6:

```bash
docker compose exec backend python manage.py create_plans
```

Choose other Basic limits with `--basic-max-categories N` and `--basic-max-items N`. The command is safe
to run again: a plan that already exists is left unchanged.

After an update that adds a plan feature (for example detailed analytics), the new flag is off on every
existing plan, Pro included. Switch the feature flags to their standard values once; the limits stay as they are:

```bash
docker compose exec backend python manage.py create_plans --sync-flags
```

## 7. Create the Super Admin

```bash
docker compose exec backend python manage.py createsuperuser
```

It asks for an email and a password, and gives the account the `SYSTEM_ADMIN` role. Sign in at
`https://menu.domain.com/login`.

## 8. Check

```bash
curl -I https://menu.domain.com/login
curl -I -X POST https://menu.domain.com/internal/revalidate
curl https://menu.domain.com/health
docker compose ps
```

The first answers `200` with a `Strict-Transport-Security` header, the second `404` (the revalidation
endpoint is reachable only inside the Docker network), the third `{"status":"ok"}` (Nginx, Next.js, Django
and PostgreSQL all answer; system_design.md §3.7). `docker compose ps` shows `backend` and `frontend` as
`healthy`.

## 9. Automatic certificate renewal

Let's Encrypt certificates last 90 days. The `certbot` package installs a timer that renews them. Switch the
renewal to the webroot method, which works while Nginx is running, and reload Nginx after each renewal:

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d menu.domain.com --force-renewal \
  --deploy-hook "docker compose -f $PWD/compose.yaml exec nginx nginx -s reload"
sudo certbot renew --dry-run
```

Certbot remembers these options for every later renewal.

## 10. Update to a new version

Normally nothing to do: CI deploys every merge into `main` (section 11). By hand, for example while
automatic deploys are off:

```bash
git pull --ff-only
docker compose pull
docker compose up -d
```

`up` runs the new migrations by itself (the `migrate` service, section 5) before it starts the new website.

To go back to an earlier version, run the images of that commit (CI keeps every image tagged with its
commit SHA; the server keeps images it used in the last 7 days):

```bash
IMAGE_TAG=<commit sha> docker compose up -d
```

## 11. Automatic deploys from GitHub

The workflow `.github/workflows/ci-cd.yml` tests every pull request. After a merge into `main` it also
builds both images, pushes them to GitHub Container Registry, and runs the update of section 10 over SSH.
The deploy job runs only when the repository variable `DEPLOY_ENABLED` is `true`.

### 11.1 Check that the images are public (once)

The first merge into `main` creates the packages `tartus-menu-backend` and `tartus-menu-frontend`. They
are normally public already: the image label `org.opencontainers.image.source` links them to this public
repository. Check it on a machine that is not logged in to `ghcr.io`:

```bash
docker manifest inspect ghcr.io/venoussy/tartus-menu-backend:latest
docker manifest inspect ghcr.io/venoussy/tartus-menu-frontend:latest
```

Both must print a manifest, not "unauthorized". If one is private, open your GitHub profile, then
Packages, then that package, then Package settings, and choose "Change visibility" to Public. Without
this, `docker compose pull` on the server fails with "unauthorized". The images hold no secrets: every
secret comes from `.env` at run time.

### 11.2 A deploy user and key

On the VPS, a user that may run Docker and owns the repository folder (members of the `docker` group can
control every container, so keep this user for deploys only):

```bash
sudo adduser --disabled-password deploy
sudo usermod -aG docker deploy
```

Clone the repository as this user (section 3). On your own computer, make a key pair used only for deploys
(no passphrase, because CI cannot type one) and allow it on the VPS:

```bash
ssh-keygen -t ed25519 -f tartus_deploy -N "" -C "github-actions deploy"
ssh-copy-id -i tartus_deploy.pub deploy@menu.domain.com
```

Read the server's own host key. Compare its fingerprint with the one the VPS shows for
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, so you know the key really is your server's:

```bash
ssh-keyscan -t ed25519 menu.domain.com > tartus_known_hosts
ssh-keygen -lf tartus_known_hosts
```

### 11.3 Secrets and the switch

Save the five values as repository secrets (GitHub: Settings, Secrets and variables, Actions), or with the
GitHub CLI from the folder that holds the two files:

```bash
gh secret set VPS_HOST --body "menu.domain.com"
gh secret set VPS_USER --body "deploy"
gh secret set VPS_APP_DIR --body "/home/deploy/tartus_menu"
gh secret set VPS_SSH_KEY < tartus_deploy
gh secret set VPS_KNOWN_HOSTS < tartus_known_hosts
gh variable set DEPLOY_ENABLED --body "true"
```

Then delete the private key file `tartus_deploy` from your computer; GitHub keeps the only copy it needs.
The next merge into `main` deploys. Set `DEPLOY_ENABLED` to anything else to stop automatic deploys.

## 12. Database backups

The `backup` service runs four jobs every night (`backend/crontab`, times in UTC):
02:00 `backup_database` (pg_dump, gzip, encrypt with `age`, upload as `backups/YYYY-MM-DD.sql.gz.age`),
02:30 `flushexpiredtokens` (removes expired login tokens),
03:00 `prune_menu_views` (deletes analytics counters older than 400 days) and
21:10 `expire_subscriptions` (00:10 in Damascus: deactivates the cafes whose last paid day has passed; to run it
by hand: `docker compose exec backup python manage.py expire_subscriptions`). If this job stops, no cafe is
deactivated; the admin pages then show such cafes as "Overdue".

A dump holds every cafe's data and the password hashes. It is encrypted for your `age` public key before
it leaves the server, and only the private key, which never goes on the server, can read it. A leaked
backup token or a stolen dump then shows nothing.

### 12.1 The encryption key, the backup bucket and its token (once)

First the key pair, on **your own computer**, not on the server. Install `age` (https://age-encryption.org;
Windows: `winget install FiloSottile.age`), then:

```bash
age-keygen -o tartus-backup-key.txt
```

It prints `Public key: age1...`. Keep `tartus-backup-key.txt` (the private key) somewhere safe outside
the server, for example in a password manager, plus one offline copy. Without it no backup can ever be
restored.

Then, in the Cloudflare dashboard, under R2:

1. Create a bucket, for example `tartus-backups`. Give it **no** custom domain and no public access.
2. Create an R2 API token with "Object Read & Write" permission for **this bucket only**.
3. Put the bucket name, the token's key ID and secret, and the `age1...` public key into `.env`
   (`R2_BACKUP_BUCKET_NAME`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`,
   `BACKUP_AGE_PUBLIC_KEY`), then run `docker compose up -d`.

### 12.2 Keep 30 days (once)

In the backup bucket's settings, add an object lifecycle rule: prefix `backups/`, delete objects
30 days after they were uploaded (system_design.md §5). R2 then removes old dumps by itself.

### 12.3 Check that backups work

Run one backup now, then read the service's log, where every nightly run also appears:

```bash
docker compose exec backup python manage.py backup_database
docker compose logs --tail 20 backup
```

The first command prints `Uploaded backups/<date>.sql.gz.age (<size> bytes).`; the new file is listed in
the bucket in the Cloudflare dashboard. A failed run says why in the log (for example a wrong token, or
a missing `BACKUP_AGE_PUBLIC_KEY`: the command never uploads an unencrypted dump).

### 12.4 Restore drill (every month)

A backup is only proven once it has been restored. Download a recent dump from the bucket in the
Cloudflare dashboard and decrypt it **on your own computer**, where the private key is:

```bash
age --decrypt -i tartus-backup-key.txt -o 2026-11-03.sql.gz 2026-11-03.sql.gz.age
```

Copy the decrypted `2026-11-03.sql.gz` to the server and restore it into a throwaway PostgreSQL 16, not
into the live database. Delete the decrypted file from both machines afterwards:

```bash
docker run -d --name restore-check -e POSTGRES_PASSWORD=restore-check postgres:16-alpine
sleep 5
gunzip -c 2026-11-03.sql.gz | docker exec -i restore-check psql -U postgres -v ON_ERROR_STOP=1 -q -o /dev/null
docker exec restore-check psql -U postgres -c "select count(*) from cafes" -c "select count(*) from menu_items"
docker rm -f restore-check
```

`ON_ERROR_STOP=1` stops at the first error, so a clean run means the whole dump is usable. `-o /dev/null`
hides the normal query results of the restore; errors are still shown.

### 12.5 Restore after a disaster

Only when the live data is lost or broken. This replaces the whole database with the dump. Decrypt the
dump on your own computer first, as in 12.4, and copy the `.sql.gz` to the server. Use the
`DB_MIGRATE_USER` (the owner role) and `DB_NAME` values of your `.env` (here the defaults `postgres` and
`tartus_db`):

```bash
docker compose stop nginx frontend backend backup
docker compose exec db psql -U postgres -d postgres -c "DROP DATABASE tartus_db WITH (FORCE)"
docker compose exec db psql -U postgres -d postgres -c "CREATE DATABASE tartus_db"
gunzip -c 2026-11-03.sql.gz | docker compose exec -T db psql -U postgres -d tartus_db -v ON_ERROR_STOP=1 -q -o /dev/null
docker compose up -d
```

The dump brings the tables back with their Row-Level Security policies, but without any rights: a dump
holds none. The last line gives the app role its rights again (the `migrate` service runs `create_app_role`).

Everything written after that dump's night is lost; uploaded images stay in the images bucket.

## 13. Uptime monitoring (once)

Learn about an outage before a cafe owner calls. Create a free account at an external monitor (for example
UptimeRobot or Better Stack) and add two checks, each every 5 minutes, that alert you by email or Telegram:

1. **HTTP check** on `https://menu.domain.com/health`: it must answer `200`. This covers Nginx, the
   certificate, Next.js, Django and PostgreSQL in one request (system_design.md §3.7).
2. **Keyword check** on one real menu, for example `https://menu.domain.com/menu/<slug>`: the page must
   contain the cafe's name. This also covers the cached customer page.

The monitor runs outside the VPS, so it still alerts when the whole server is down. When it alerts, start
with `docker compose ps` and `docker compose logs --tail 50 backend frontend nginx`.

## 14. Error tracking (optional, once)

See the real error and its stack trace when a page or the API answers 500, without searching the logs
(system_design.md §5 "Error Tracking"):

1. Create a free account at Sentry (sentry.io) or GlitchTip (glitchtip.com), and one project of the platform
   "Django" (the Next.js server sends to the same project).
2. Copy the project's DSN (it looks like `https://<key>@<host>/<number>`) into `.env` as `SENTRY_DSN`, then run
   `docker compose up -d`. Each report names the running image version (`IMAGE_TAG`) as its release.
3. Set the project's alert to email you on a new issue.

The reports contain no passwords, cookies, tokens, request bodies or visitor addresses. To stop sending,
empty `SENTRY_DSN` and run `docker compose up -d` again.

## 15. Password reset email (optional, once)

Lets an owner who forgot the password get a reset link by email ("Forgot password?" on the login page,
use_cases.md UC-AUTH-006). Without it the page tells the owner to contact support, and you send a link from
the cafe's admin page (UC-ADMIN-010). The provider is Resend (resend.com); any SMTP server with STARTTLS on
port 587 works with the same five settings.

1. Create a Resend account and add your domain (Domains → Add domain), for example `menu.domain.com`.
2. Resend shows DNS records for that domain. Add all of them at your DNS provider, then press "Verify":
   - **SPF** (a TXT record and an MX record): tells mail servers that Resend may send for your domain.
   - **DKIM** (a TXT record): a public key; Resend signs every email, and the receiver checks the signature.
3. Add one more TXT record yourself, named `_dmarc.<your domain>`, with the value `v=DMARC1; p=none;`.
   **DMARC** tells receivers what to do with mail that fails SPF and DKIM. `p=none` only reports; once real
   emails arrive well, change it to `p=quarantine`. Without these three records the email lands in spam.
4. Create an API key with the permission "Sending access" only, limited to that domain.
5. Fill `.env` and run `docker compose up -d`:

   ```bash
   EMAIL_HOST=smtp.resend.com
   EMAIL_PORT=587
   EMAIL_HOST_USER=resend
   EMAIL_HOST_PASSWORD=<the API key>
   DEFAULT_FROM_EMAIL=Tartus Menu <no-reply@menu.domain.com>
   ```

   The address in `DEFAULT_FROM_EMAIL` must be on the verified domain.
6. Check: open `https://menu.domain.com/login`, click "Forgot password?" and enter the email address of a test
   cafe's owner. The email must arrive within a minute, and its link must open the new-password page. If
   nothing arrives, look at Resend's "Emails" page and at `docker compose logs backend | grep "reset email"`.

Limits to know: an owner gets an email only if the account's email address is a real mailbox, so enter real
addresses when you create cafes. One address gets at most one email per 5 minutes, and one visitor may ask
5 times per hour. A Super Admin never gets a reset email; reset that password on the server:
`docker compose exec backend python manage.py changepassword <email>`.

## 16. The two database roles (Row-Level Security)

A database role is a database user. The stack uses two (system_design.md §7.1):

| Role | In `.env` | What it may do | Who uses it |
|---|---|---|---|
| Owner role | `DB_MIGRATE_USER`, `DB_MIGRATE_PASSWORD` | Everything: it owns the tables | The `migrate` service (section 5) and the `backup` service (the nightly dump and jobs) |
| App role | `DB_USER`, `DB_PASSWORD` | Only read and write rows | The `backend` service: every request of the website |

Why two: the six tables that hold cafe data have a Row-Level Security policy. PostgreSQL shows the app
role only the rows of the cafe a request works for, even if the code forgets a filter. A role that owns the
tables could switch that policy off, and PostgreSQL never applies policies to a superuser, so the website
must not run as the owner role. The backup must: `pg_dump` refuses to dump tables whose policy would hide
rows from it.

- **Change the app role's password:** change `DB_PASSWORD` in `.env` and run `docker compose up -d`. The
  `migrate` service sets the new password, then the backend restarts with it.
- **Check it:** `docker compose exec db psql -U postgres -d tartus_db -c "\du"` lists both roles; the app
  role has no attributes (not "Superuser", not "Bypass RLS").
- **Read cafe data by hand:** connect as the owner role, as above. As the app role, a query on a table
  such as `menu_items` returns no rows: no cafe is set for your session.
- The owner role's name cannot be changed after the first start: PostgreSQL creates it only once, when
  the `pgdata` volume is empty.

## Useful commands

```bash
docker compose ps                  # state of every service (backend and frontend show "healthy")
docker compose logs -f backend     # follow Django's log (also: frontend, nginx, db)
docker compose restart nginx       # after editing deploy/nginx/default.conf.template
```
