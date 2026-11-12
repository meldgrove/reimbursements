from django.db import migrations

# Automatic updates moved to the updater service in compose.yaml (docs/updates.md); the
# worker no longer records its checks.


class Migration(migrations.Migration):
    dependencies = [("portal", "0015_update_check")]

    operations = [migrations.DeleteModel(name="UpdateCheck")]
