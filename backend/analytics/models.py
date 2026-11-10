from django.db import models

from cafes.models import Cafe


class MenuViewCount(models.Model):
    """
    How many times a cafe's menu was opened in one hour from one table (use_cases.md UC-GUEST-004).

    A counter, not a log: one row per (cafe, hour, table), and each open adds 1 to its row. Nothing
    about the visitor is stored, so the numbers are "menu opens", not "visitors".
    """

    NO_TABLE = 0  # opened without a table number, or with one that is not an active table of the cafe

    cafe = models.ForeignKey(Cafe, on_delete=models.CASCADE, related_name='menu_view_counts')
    hour = models.DateTimeField()  # the start of the hour, UTC
    table_number = models.PositiveSmallIntegerField(default=NO_TABLE)  # 1..200, or NO_TABLE
    count = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = 'menu_view_counts'
        constraints = [
            # One row per counter. Its index (cafe, hour, ...) also serves every read: a cafe's period.
            models.UniqueConstraint(fields=['cafe', 'hour', 'table_number'], name='unique_menu_view_counter'),
            # system_design.md 2.2: 0..200 (CHECK), the table range of cafe_tables plus "no table".
            models.CheckConstraint(condition=models.Q(table_number__lte=200), name='menu_view_table_number_range'),
        ]

    def __str__(self):
        # cafe_id, not cafe.slug: no extra query for the related object.
        return f'Cafe {self.cafe_id}, {self.hour:%Y-%m-%d %H}:00, table {self.table_number}: {self.count}'
