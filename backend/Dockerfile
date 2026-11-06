# Production image for the Django API (system_design.md §5, service "backend").
# Slim (Debian) instead of Alpine: psycopg2-binary and Pillow install from ready-made wheels, no compiler needed.
FROM python:3.14-slim

# No .pyc files, logs go straight to Docker, no pip cache or version check in the image.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Tools for the "backup" service, which runs this same image with another command (step 14):
# - pg_dump 16 from the official PostgreSQL apt repository. Debian's own client is 17, and a version 17
#   dump does not restore cleanly into the version 16 server.
# - age from Debian's own (signed) repository: encrypts every dump for the owner's public key.
# - supercronic, a cron made for containers (runs as a normal user, logs to stdout). The download is
#   checked against the SHA-256 that GitHub shows for the release file.
ARG SUPERCRONIC_VERSION=v0.2.51
# Set by Docker BuildKit: amd64 or arm64.
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 age \
    && case "$TARGETARCH" in \
        amd64) sum=cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123 ;; \
        arm64) sum=4ae22576a78223d8ccdf5f3b3660a5cbb5288416bf0ca96afc4a36d195932b94 ;; \
        *) echo "No supercronic checksum for architecture '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /usr/local/bin/supercronic \
        "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
    && echo "$sum  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod +x /usr/local/bin/supercronic \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first: this layer is rebuilt only when requirements.txt changes, not on every code change.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Run as a normal user. It owns STATIC_ROOT, so collectstatic can write there (and into the volume mounted on it).
RUN useradd --system --no-create-home app \
    && mkdir -p /app/staticfiles \
    && chown app /app/staticfiles
USER app

EXPOSE 8000

# Started with sh, so the script needs no executable bit (Windows checkouts do not keep it).
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
# 3 workers fit a small VPS. Nginx already logs every request, so Gunicorn keeps only its error log.
CMD ["gunicorn", "core.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3"]
