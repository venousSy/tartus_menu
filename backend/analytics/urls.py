"""
Owner dashboard analytics (system_design.md section 3.3).
core/urls.py includes this file under /api/v1/dashboard/analytics/; the public counter is in public_urls.py.
"""

from django.urls import path

from .views import AnalyticsDetailView, AnalyticsSummaryView

# Namespace for reverse(): reverse('analytics:summary') -> /api/v1/dashboard/analytics/summary/
app_name = 'analytics'

urlpatterns = [
    path('summary/', AnalyticsSummaryView.as_view(), name='summary'),  # UC-OWNER-015
    path('detail/', AnalyticsDetailView.as_view(), name='detail'),  # UC-OWNER-016
]
