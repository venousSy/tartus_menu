from urllib.parse import urlsplit

from django.conf import settings
from django.conf.urls.static import static
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

if not settings.USE_S3:
    # Development: uploaded images from backend/media/ (settings.MEDIA_URL). static() adds the route
    # only when DEBUG is True, and needs the path part of the absolute MEDIA_URL.
    urlpatterns += static(urlsplit(settings.MEDIA_URL).path, document_root=settings.MEDIA_ROOT)

handler404 = 'core.views.json_not_found'  # Global Convention 2: JSON, not Django's HTML page
