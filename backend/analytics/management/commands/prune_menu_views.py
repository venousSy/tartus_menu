"""
python manage.py prune_menu_views: delete old menu open counters (system_design.md §5, "Scheduled Jobs").

Counters older than 400 days are removed, so the table stays small. The backup service runs it every
night (backend/crontab). Safe to run again: a second run finds nothing to delete.
"""

from django.core.management.base import BaseCommand

from analytics import services


class Command(BaseCommand):
    help = 'Delete menu open counters older than 400 days.'

    def handle(self, *args, **options):
        self.stdout.write(f'Deleted {services.prune_old_views()} old menu view counters.')
