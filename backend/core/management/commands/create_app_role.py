"""
python manage.py create_app_role: creates or updates the database role the web application uses
(system_design.md §7.1, "Database roles").

Run it as the owner role, the one that owns the tables and runs the migrations. The app role's
name and password come from the environment (DB_APP_USER, DB_APP_PASSWORD), never from a file in
the repository. Safe to run again: it sets the password and the rights anew each time, so it also
repairs them after a restore (a dump holds no rights) and applies a changed password.

The app role may read and write rows, nothing more. It is not a superuser, cannot skip Row-Level
Security and owns no table, so it cannot switch a policy off.
"""

import os

from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from psycopg import sql

ROW_RIGHTS = sql.SQL('SELECT, INSERT, UPDATE, DELETE')


class Command(BaseCommand):
    help = 'Create or update the database role of the web application (DB_APP_USER, DB_APP_PASSWORD).'

    def handle(self, *args, **options):
        name = os.getenv('DB_APP_USER', '')
        password = os.getenv('DB_APP_PASSWORD', '')
        if not name or not password:
            raise CommandError('Set DB_APP_USER and DB_APP_PASSWORD (the role and password of the web application).')
        database = connection.settings_dict
        if name == database['USER']:
            raise CommandError('DB_APP_USER must not be the role this command runs as (the owner role).')

        role = sql.Identifier(name)
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1 FROM pg_roles WHERE rolname = %s', [name])
            verb = sql.SQL('ALTER' if cursor.fetchone() else 'CREATE')
            # CREATE ROLE takes no query parameters, so psycopg's sql module quotes the name and the
            # password. Never build such a statement with an f-string.
            statements = [
                sql.SQL('{} ROLE {} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD {}')
                .format(verb, role, sql.Literal(password)),
                sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(database['NAME']), role),
                sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(role),
                # The tables and sequences (the id counters) that exist now ...
                sql.SQL('GRANT {} ON ALL TABLES IN SCHEMA public TO {}').format(ROW_RIGHTS, role),
                sql.SQL('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {}').format(role),
                # ... and those that later migrations of this owner role create.
                sql.SQL('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT {} ON TABLES TO {}').format(ROW_RIGHTS, role),
                sql.SQL('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {}').format(role),
            ]
            for statement in statements:
                cursor.execute(statement)
        self.stdout.write(f'The role {name} may read and write rows in {database["NAME"]}.')
