from django.conf import settings
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path(f'{settings.DJANGO_ADMIN_PATH}/', admin.site.urls),  # hidden path from the environment
    path('api/v1/auth/', include('users.urls')),
    path('api/v1/admin/', include('cafes.admin_urls')),
    path('api/v1/dashboard/', include('menu.urls')),
    path('api/v1/dashboard/', include('cafes.urls')),
    path('api/v1/menu/', include('menu.public_urls')),
]

handler404 = 'core.views.json_not_found'  # Global Convention 2: JSON, not Django's HTML page
