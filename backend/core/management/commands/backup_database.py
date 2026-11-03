"""
python manage.py backup_database: the daily database backup (system_design.md §5, "Scheduled Jobs").

pg_dump (plain SQL) -> gzip -> the private R2 backup bucket, as backups/YYYY-MM-DD.sql.gz (UTC date).
The backup service runs it every night at 02:00 UTC (backend/crontab). Copies older than 30 days are
deleted by a lifecycle rule on the bucket, not by this command.
"""

import gzip
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

REQUIRED_SETTINGS = (
    'R2_BACKUP_BUCKET_NAME',
    'R2_BACKUP_ACCESS_KEY_ID',
    'R2_BACKUP_SECRET_ACCESS_KEY',
    'R2_BACKUP_ENDPOINT_URL',
)


class Command(BaseCommand):
    help = 'Dump the database, gzip it and upload it to the R2 backup bucket.'

    def handle(self, *args, **options):
        missing = [name for name in REQUIRED_SETTINGS if not getattr(settings, name)]
        if missing:
            raise CommandError(f"Backup not configured, missing: {', '.join(missing)}.")

        key = f"backups/{datetime.now(timezone.utc):%Y-%m-%d}.sql.gz"
        # The whole dump is written to a temporary file first: a failed pg_dump then never replaces
        # the day's backup with a half file.
        with tempfile.TemporaryFile() as dump_file:
            dump_database(settings.DATABASES['default'], dump_file)
            size = dump_file.tell()
            dump_file.seek(0)
            upload(dump_file, key)
        self.stdout.write(f'Uploaded {key} ({size} bytes).')


def dump_database(db, target):
    """Write a gzipped plain-SQL dump of `db` (a DATABASES entry) into the open binary file `target`."""
    command = [
        'pg_dump',
        '--host', db['HOST'],
        '--port', str(db['PORT']),
        '--username', db['USER'],
        '--dbname', db['NAME'],
        # Restorable into any database user (the restore may run as another role).
        '--no-owner',
        '--no-privileges',
    ]
    # The password goes in the environment, not on the command line, where other processes could read it.
    env = {**os.environ, 'PGPASSWORD': db['PASSWORD']}
    with tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, env=env)
        except FileNotFoundError as error:
            raise CommandError('pg_dump is not installed (it is in the backend Docker image).') from error
        with process:
            with gzip.GzipFile(fileobj=target, mode='wb') as compressed:
                shutil.copyfileobj(process.stdout, compressed)
        if process.returncode != 0:
            errors.seek(0)
            message = errors.read().decode(errors='replace').strip()
            raise CommandError(f'pg_dump failed (exit {process.returncode}): {message}')


def upload(dump_file, key):
    """Upload the open dump file to the backup bucket under `key`."""
    client = boto3.client(
        's3',
        endpoint_url=settings.R2_BACKUP_ENDPOINT_URL,
        aws_access_key_id=settings.R2_BACKUP_ACCESS_KEY_ID,
        aws_secret_access_key=settings.R2_BACKUP_SECRET_ACCESS_KEY,
        region_name='auto',  # Cloudflare R2 uses the region name "auto"
    )
    try:
        client.upload_fileobj(
            dump_file, settings.R2_BACKUP_BUCKET_NAME, key,
            ExtraArgs={'ContentType': 'application/gzip'},
        )
    except (BotoCoreError, ClientError) as error:
        raise CommandError(f'Upload of {key} failed: {error}') from error
