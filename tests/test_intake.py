import json
import re
from decimal import Decimal

import pytest

from portal.intake import (
    AMOUNT_PATTERN,
    IntakeError,
    limits,
    message,
    mileage_amount,
    parse_amount,
)
from portal.services import claim_validation

pytestmark = pytest.mark.django_db


def rendered_configuration(client, form):
    page = client.get(f"/f/{form.slug}/").content.decode()
    script = re.search(r'<script id="portal-configuration"[^>]*>(.*?)</script>', page, re.S)
    return page, json.loads(script[1])


def test_client_and_server_share_one_set_of_limits(client, form, settings):
    settings.MAX_FILES_PER_EXPENSE = 2
    settings.MAX_SUBMISSION_BYTES = 20_000_000
    page, config = rendered_configuration(client, form)
    assert config["limits"]["files_per_expense"] == 2
    assert config["limits"] == {
        key: value for key, value in vars(limits()).items() if not key.startswith("_")
    }
    assert config["messages"]["submission_too_large"].endswith("höchstens 20 MB groß sein.")
    assert "20 MB insgesamt" in page and "Bis zu 2 Dateien." in page
    assert f'pattern="{AMOUNT_PATTERN}"' in page
    assert message("files_per_expense") == "Jede Position benötigt 1 bis 2 Belegdateien."


def test_amounts_are_euros_with_at_most_two_cent_digits(client, form):
    _, config = rendered_configuration(client, form)
    assert "currency_precision" not in config and config["mileage_rate"] == "0.30"
    assert parse_amount("12,5") == Decimal("12.5")
    assert parse_amount("1250") == 1250
    for value in ["12,505", "1.250,00", "0", "-3", "12 EUR"]:
        with pytest.raises(ValueError):
            parse_amount(value)


def test_mileage_is_distance_times_rate_rounded_half_up():
    assert mileage_amount(123, False, Decimal("0.30")) == Decimal("36.90")
    assert mileage_amount(123, True, Decimal("0.30")) == Decimal("73.80")
    assert mileage_amount(1, False, Decimal("0.005")) == Decimal("0.01")


def test_server_rejects_rows_beyond_the_configured_file_limit(prepared, settings):
    settings.MAX_FILES_PER_EXPENSE = 1
    data = prepared["data"]
    data["expenses"][0]["uploads"].append(str(data["signature"]))
    result = claim_validation.submission(data, prepared["form"])
    with pytest.raises(IntakeError) as error:
        result.require_valid()
    assert "1 bis 1 Belegdateien" in str(error.value.errors)
