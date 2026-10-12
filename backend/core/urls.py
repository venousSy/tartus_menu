from django.contrib import admin
from django.urls import path

urlpatterns = [
    path('admin/', admin.site.urls),
    # API endpoints will be registered here later (e.g. path('api/v1/', include(...)))
]
