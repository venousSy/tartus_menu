# Production image for the Django API (system_design.md §5, service "backend").
# Slim (Debian) instead of Alpine: psycopg2-binary and Pillow install from ready-made wheels, no compiler needed.
FROM python:3.14-slim

# No .pyc files, logs go straight to Docker, no pip cache or version check in the image.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

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
