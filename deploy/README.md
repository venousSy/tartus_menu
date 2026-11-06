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

Fill in every value of `.env` (the comments in the file explain each one). For the three secrets
(`DJANGO_SECRET_KEY`, `DB_PASSWORD`, `FRONTEND_REVALIDATE_SECRET`) use a new random value each:

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
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py createcachetable
```

`pull` downloads the images that CI built from the newest commit on `main` (tag `latest`).
`createcachetable` creates the table for the login rate-limit counters. Both commands are safe to run again.

## 6. Create the subscription plans

A new database has no plans, and cafes cannot be created without one. This creates Basic (5 categories,
20 items, no images or branding) and Pro (unlimited, images and branding), the example of
system_design.md §6:

```bash
docker compose exec backend python manage.py create_plans
```

Choose other Basic limits with `--basic-max-categories N` and `--basic-max-items N`. The command is safe
to run again: a plan that already exists is left unchanged.

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
```

The first answers `200` with a `Strict-Transport-Security` header, the second `404` (the revalidation
endpoint is reachable only inside the Docker network).

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
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py createcachetable
```

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

The `backup` service runs two jobs every night (`backend/crontab`, times in UTC):
02:00 `backup_database` (pg_dump, gzip, encrypt with `age`, upload as `backups/YYYY-MM-DD.sql.gz.age`) and
02:30 `flushexpiredtokens` (removes expired login tokens).

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
`DB_USER` and `DB_NAME` values of your `.env` (here the defaults `postgres` and `tartus_db`):

```bash
docker compose stop nginx frontend backend backup
docker compose exec db psql -U postgres -d postgres -c "DROP DATABASE tartus_db WITH (FORCE)"
docker compose exec db psql -U postgres -d postgres -c "CREATE DATABASE tartus_db"
gunzip -c 2026-11-03.sql.gz | docker compose exec -T db psql -U postgres -d tartus_db -v ON_ERROR_STOP=1 -q -o /dev/null
docker compose up -d
```

Everything written after that dump's night is lost; uploaded images stay in the images bucket.

## Useful commands

```bash
docker compose ps                  # state of every service
docker compose logs -f backend     # follow Django's log (also: frontend, nginx, db)
docker compose restart nginx       # after editing deploy/nginx/default.conf.template
```
