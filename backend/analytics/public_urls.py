"""
The public menu open counter (system_design.md section 3.4), no authentication.
core/urls.py includes this file under /api/v1/menu/, next to menu.public_urls.
"""

from django.urls import path

from .views import MenuViewCountView

# Namespace for reverse(): reverse('public_analytics:view', kwargs={'slug': ...}) -> /api/v1/menu/<slug>/views/
app_name = 'public_analytics'

urlpatterns = [
    path('<slug:slug>/views/', MenuViewCountView.as_view(), name='view'),  # UC-GUEST-004
]
