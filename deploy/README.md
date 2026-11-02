# Deployment runbook (one VPS)

How to put the Docker Compose stack (`compose.yaml`, system_design.md §5) on a fresh server, and how to update it.
The commands assume Ubuntu 24.04 LTS and are run from the repository folder on the server.
Steps 13 (CI/CD) and 14 (daily backup and `flushexpiredtokens`) will automate parts of this later.

## 1. Before you start

- A VPS with ports 80 and 443 open to the internet.
- A DNS `A` record for the site's host name (for example `menu.domain.com`) pointing to the VPS.
- A Cloudflare R2 bucket, an API token for it, and a public custom domain for the bucket.

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
docker compose up -d --build
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py createcachetable
```

`createcachetable` creates the table for the login rate-limit counters. Both commands are safe to run again.

## 6. Create the subscription plans

A new database has no plans, and cafes cannot be created without one. The values below are the example
of system_design.md §6; choose your own limits (`None` means unlimited):

```bash
docker compose exec backend python manage.py shell -c "
from cafes.models import SubscriptionPlan as P
P.objects.get_or_create(name='basic', defaults={'max_categories': 5, 'max_items': 20})
P.objects.get_or_create(name='pro', defaults={'allows_images': True, 'allows_branding': True})
"
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

```bash
git pull
docker compose up -d --build
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py createcachetable
```

## Useful commands

```bash
docker compose ps                  # state of every service
docker compose logs -f backend     # follow Django's log (also: frontend, nginx, db)
docker compose restart nginx       # after editing deploy/nginx/default.conf.template
```
