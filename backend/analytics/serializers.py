from rest_framework import serializers


class MenuViewSerializer(serializers.Serializer):
    """Body of POST /api/v1/menu/{slug}/views/ (UC-GUEST-004): { "table": 1-200 or null }; no body means null."""

    # The range of cafe_tables.table_number (A4). Whether the cafe has that table is the service's question (A3).
    table = serializers.IntegerField(min_value=1, max_value=200, allow_null=True, default=None)


class PeriodSerializer(serializers.Serializer):
    """Query of the analytics reads (UC-OWNER-015, UC-OWNER-016): ?days=7, 30 or 90; 7 without it."""

    # ChoiceField turns the query text "30" into the choice 30; anything else is a 400 (A1).
    days = serializers.ChoiceField(choices=[7, 30, 90], default=7)


class DayCountSerializer(serializers.Serializer):
    date = serializers.DateField()  # a calendar day in the business time zone
    count = serializers.IntegerField()


class HourCountSerializer(serializers.Serializer):
    hour = serializers.IntegerField()  # hour of the day, 0-23, in the business time zone
    count = serializers.IntegerField()


class TableCountSerializer(serializers.Serializer):
    table_number = serializers.IntegerField()  # 0 = no table
    count = serializers.IntegerField()


class AnalyticsSummarySerializer(serializers.Serializer):
    """Answer of analytics/summary/ (UC-OWNER-015)."""

    days = serializers.IntegerField()
    total = serializers.IntegerField()
    by_day = DayCountSerializer(many=True)  # exactly `days` entries, oldest first


class AnalyticsDetailSerializer(serializers.Serializer):
    """Answer of analytics/detail/ (UC-OWNER-016)."""

    days = serializers.IntegerField()
    total = serializers.IntegerField()
    by_hour = HourCountSerializer(many=True)  # always 24 entries
    by_table = TableCountSerializer(many=True)  # only tables with opens, the most opened first
