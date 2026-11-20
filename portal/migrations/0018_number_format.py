from django.db import migrations, models

# The number format of the General settings: European (decimal comma) unless chosen.


class Migration(migrations.Migration):
    dependencies = [("portal", "0017_appearance")]

    operations = [
        migrations.AddField(
            model_name="appsettings",
            name="number_format",
            field=models.CharField(
                choices=[("european", "1.234,56 (European)"), ("us", "1,234.56 (US)")],
                default="european",
                help_text="The decimal separator of amounts everywhere, including the admin area and the claim PDF. Participants may type amounts with either separator.",
                max_length=8,
                verbose_name="Number format",
            ),
        ),
    ]
