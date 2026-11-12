"""
Tells PostgreSQL which cafe the current code works for (system_design.md §7.1, Row-Level Security).

The six tenant tables have a policy: a row is visible, and may be written, only when its cafe_id
equals the database setting app.cafe_id, or when app.rls_bypass is 'on'. With neither, PostgreSQL
shows no rows. So a service that forgets a cafe filter still cannot touch another cafe's rows.

Both settings are set with set_config(name, value, true): local to the transaction. They end with
it, so a value can never stay on a connection that the next request reuses.

Rules for callers:
- Open a scope in the service layer only, and read and write tenant tables only inside one.
- Return evaluated data (a list, a loaded object), never a lazy queryset on a tenant table:
  a queryset that runs after the scope has ended sees no rows.
"""

from contextlib import contextmanager
from functools import wraps

from django.db import connection, transaction

_READ = "SELECT current_setting('app.cafe_id', true), current_setting('app.rls_bypass', true)"
_SET = "SELECT set_config('app.cafe_id', %s, true), set_config('app.rls_bypass', %s, true)"


@contextmanager
def _scope(cafe_id, bypass):
    # Inside another transaction (a service that calls a service, or a test) this block is only a
    # savepoint, and the outer transaction lives on: its settings are put back at the end.
    nested = connection.in_atomic_block
    with transaction.atomic():
        with connection.cursor() as cursor:
            if nested:
                cursor.execute(_READ)
                before = cursor.fetchone()
            cursor.execute(_SET, [cafe_id, bypass])
        yield
        # Reached only without an error. After an error the savepoint is rolled back, and
        # PostgreSQL itself restores the settings to what they were before it.
        if nested:
            with connection.cursor() as cursor:
                cursor.execute(_SET, [before[0] or '', before[1] or ''])


def tenant(cafe):
    """`with tenant(cafe):` a transaction in which only the rows of this cafe exist."""
    return _scope(str(cafe.pk), 'off')


def all_tenants():
    """
    `with all_tenants():` a transaction that sees every cafe's rows. Only for code that works across
    cafes by design: the Super Admin's services, the nightly commands, and the QR link lookup, which
    finds a table by its token before any cafe is known. Also usable as a decorator: @all_tenants().
    """
    return _scope('', 'on')


def in_tenant(service):
    """
    Decorator for a service whose first argument is the cafe: the whole call runs in tenant(cafe).
    Not for a service that uploads a file: the upload would then run inside the transaction.
    """
    @wraps(service)
    def wrapper(cafe, *args, **kwargs):
        with tenant(cafe):
            return service(cafe, *args, **kwargs)
    return wrapper
