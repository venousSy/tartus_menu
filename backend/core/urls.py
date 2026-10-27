from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/v1/auth/', include('users.urls')),
    path('api/v1/dashboard/', include('menu.urls')),
    path('api/v1/dashboard/', include('cafes.urls')),
    path('api/v1/menu/', include('menu.public_urls')),
]
