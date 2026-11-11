from django.urls import include, path

from portal.admin import site

urlpatterns = [
    path("admin/", site.urls),
    path("oidc/", include("mozilla_django_oidc.urls")),
    path("", include("portal.urls")),
]
