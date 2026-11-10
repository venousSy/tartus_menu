"""
python manage.py expire_subscriptions: the nightly subscription expiry (use_cases.md UC-ADMIN-012).

Deactivates every active cafe whose last paid day (subscription_expires_on) has passed and writes a
BillingEvent 'expired' for each. The backup service runs it every night at 21:10 UTC, which is 00:10
in the business time zone (backend/crontab). Safe to run again: a second run finds nothing to do.
"""

from django.core.management.base import BaseCommand

from cafes import services


class Command(BaseCommand):
    help = 'Deactivate the cafes whose paid subscription time is over.'

    def handle(self, *args, **options):
        slugs = services.expire_due_subscriptions()
        if slugs:
            self.stdout.write(f"Expired {len(slugs)}: {', '.join(slugs)}.")
        else:
            self.stdout.write('No subscription expired.')
