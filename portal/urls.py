from django.urls import path

from portal import views

urlpatterns = [
    path("", views.index, name="index"),
    path("datenschutz/", views.privacy, name="privacy"),
    path("favicon/<slug:digest>/", views.favicon, name="favicon"),
    path("theme/<slug:digest>.css", views.theme_stylesheet, name="theme"),
    path("f/<slug:form_slug>/", views.form_page, name="form_page"),
    path("f/<slug:form_slug>/uploads/", views.upload, name="upload"),
    path(
        "f/<slug:form_slug>/uploads/<uuid:upload_id>/status/",
        views.upload_status,
        name="upload_status",
    ),
    path(
        "f/<slug:form_slug>/uploads/<uuid:upload_id>/",
        views.upload_remove,
        name="upload_remove",
    ),
    path("f/<slug:form_slug>/submit/", views.submit, name="submit"),
    path("f/<slug:form_slug>/validate/", views.validate_claim, name="validate_claim"),
    path("received/<uuid:claim_id>/", views.received, name="received"),
    path("webhooks/mailersend/", views.mailersend_webhook, name="mailersend_webhook"),
    path("-/healthz", views.healthz, name="healthz"),
    path("-/readyz", views.readyz, name="readyz"),
]
