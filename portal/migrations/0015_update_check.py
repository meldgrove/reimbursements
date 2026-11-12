from django.db import migrations, models

# Automatic updates: the worker's last check for new releases and its last call of the
# deploy link, in one row.


class Migration(migrations.Migration):
    dependencies = [("portal", "0014_archive")]

    operations = [
        migrations.CreateModel(
            name="UpdateCheck",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("checked_at", models.DateTimeField(null=True)),
                ("succeeded_at", models.DateTimeField(null=True)),
                ("available_version", models.CharField(blank=True, max_length=32)),
                ("available_url", models.URLField(blank=True, max_length=300)),
                ("target_version", models.CharField(blank=True, max_length=32)),
                ("requested_at", models.DateTimeField(null=True)),
                ("request_failure", models.CharField(blank=True, max_length=32)),
            ],
        ),
    ]
