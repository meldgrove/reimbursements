import django.core.validators
from django.db import migrations, models

# The Appearance tab: the accent color, and the favicon moved from the General tab.


class Migration(migrations.Migration):
    dependencies = [("portal", "0016_remove_update_check")]

    operations = [
        migrations.CreateModel(
            name="Appearance",
            fields=[],
            options={
                "verbose_name": "Appearance",
                "verbose_name_plural": "Appearance",
                "proxy": True,
                "indexes": [],
                "constraints": [],
            },
            bases=("portal.appsettings",),
        ),
        migrations.AddField(
            model_name="appsettings",
            name="accent_color",
            field=models.CharField(
                blank=True,
                help_text="Such as #0f766e. Leave empty for the standard teal. Dark mode lightens it as needed so it stays readable.",
                max_length=7,
                validators=[
                    django.core.validators.RegexValidator(
                        "\\A#[0-9a-f]{6}\\Z", "Enter a hex code such as #0f766e."
                    )
                ],
                verbose_name="Accent color",
            ),
        ),
    ]
