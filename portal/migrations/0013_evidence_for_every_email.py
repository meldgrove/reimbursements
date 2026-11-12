from django.db import migrations, models

# Evidence names its email by provider message ID or by the tagged record ID, so it can
# belong to a Finance delivery attempt or a confirmation. Confirmations are reconciled like
# attempts. Unmatched confirmation evidence recorded until now applies on the next
# maintenance run.


class Migration(migrations.Migration):
    dependencies = [("portal", "0012_standard_form_texts_follow_language")]

    operations = [
        migrations.RemoveField(model_name="deliveryevent", name="attempt"),
        migrations.AddField(
            model_name="confirmation",
            name="last_checked_at",
            field=models.DateTimeField(blank=True, db_index=True, null=True),
        ),
    ]
