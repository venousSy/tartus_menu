"""
python manage.py create_plans: create the Basic and Pro subscription plans on a new database
(deploy/README.md §6). Cafes cannot be created without a plan.

Safe to run again: a plan that already exists is left unchanged, because its limits may have been
changed on purpose. The defaults are the example values of system_design.md §6.

--sync-flags also sets the feature flags (allows_...) of existing plans to the values below. Use it
after an update that added a flag: a new flag starts as False on every existing plan, Pro included.
The limits (max_...) are never touched.
"""

import argparse

from django.core.management.base import BaseCommand
from django.db import transaction

from cafes.models import SubscriptionPlan

FEATURE_FLAGS = ('allows_images', 'allows_branding', 'allows_detailed_analytics')


def positive_int(value):
    """argparse type: a whole number >= 1 (a limit of 0 would forbid every category or item)."""
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f'{value!r} is not a whole number.')
    if number < 1:
        raise argparse.ArgumentTypeError('must be 1 or more.')
    return number


class Command(BaseCommand):
    help = 'Create the Basic and Pro subscription plans if they do not exist yet.'

    def add_arguments(self, parser):
        parser.add_argument('--basic-max-categories', type=positive_int, default=5,
                            help='Category limit of the Basic plan (default 5).')
        parser.add_argument('--basic-max-items', type=positive_int, default=20,
                            help='Item limit of the Basic plan (default 20).')
        parser.add_argument('--sync-flags', action='store_true',
                            help='Also set the feature flags of existing plans to their standard values.')

    def handle(self, *args, **options):
        # Pro: no limits (NULL = unlimited) and every feature flag on.
        plans = {
            SubscriptionPlan.Name.BASIC: {
                'max_categories': options['basic_max_categories'],
                'max_items': options['basic_max_items'],
                **dict.fromkeys(FEATURE_FLAGS, False),
            },
            SubscriptionPlan.Name.PRO: {
                'max_categories': None,
                'max_items': None,
                **dict.fromkeys(FEATURE_FLAGS, True),
            },
        }
        with transaction.atomic():
            for name, values in plans.items():
                plan, created = SubscriptionPlan.objects.get_or_create(name=name, defaults=values)
                state = 'created' if created else 'already exists, left unchanged'
                if not created and options['sync_flags']:
                    changed = [flag for flag in FEATURE_FLAGS if getattr(plan, flag) != values[flag]]
                    for flag in changed:
                        setattr(plan, flag, values[flag])
                    plan.save(update_fields=changed)  # an empty list saves nothing
                    state = f"flags updated ({', '.join(changed)})" if changed else 'flags already up to date'
                self.stdout.write(f'{plan}: {state}.')
