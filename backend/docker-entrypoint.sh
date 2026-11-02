#!/bin/sh
# Runs every time the backend container starts, before its main command (Gunicorn).
set -e

# Copy the Django admin's CSS and JS into STATIC_ROOT. In Docker Compose this is a volume that Nginx
# serves at /static/. Doing it at start (not at build) keeps the volume in step with the running image.
python manage.py collectstatic --noinput

# Replace this shell with the main command, so Gunicorn receives Docker's stop signal directly.
exec "$@"
