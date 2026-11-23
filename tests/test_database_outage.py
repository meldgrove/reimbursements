"""The worker outlives a PostgreSQL restart: lost connections wait, real errors stay errors."""

import logging
import socket
import time
from types import SimpleNamespace

import psycopg
import pytest
from django.core.management import call_command
from django.db import (
    IntegrityError,
    InterfaceError,
    OperationalError,
    ProgrammingError,
    close_old_connections,
    connection,
    connections,
)

from portal import database
from portal.job_kinds import KINDS, RENDER
from portal.jobs import Interrupted, run_one
from portal.management.commands import run_jobs
from portal.management.commands.run_jobs import Command
from portal.models import Claim, Form, Job
from tests.test_jobs import queued_upload


def django_error(django_class, cause):
    """A database error as Django raises it: wrapped around the driver's error."""
    try:
        try:
            raise cause
        except Exception as driver_error:
            raise django_class(*driver_error.args) from driver_error
    except django_class as exc:
        return exc


def lost():
    return django_error(OperationalError, psycopg.errors.AdminShutdown("terminating connection"))


@pytest.mark.parametrize(
    "cause",
    [
        psycopg.errors.AdminShutdown("terminating connection due to administrator command"),
        psycopg.errors.CrashShutdown("terminating connection because of crash"),
        psycopg.errors.CannotConnectNow("the database system is starting up"),
        psycopg.errors.ConnectionFailure("connection failure"),
        psycopg.OperationalError("connection failed: Connection refused"),
        psycopg.OperationalError("the connection is closed"),
    ],
    ids=lambda cause: type(cause).__name__ + ":" + str(cause)[:20],
)
def test_errors_of_a_restarting_database_mean_a_lost_connection(cause):
    assert database.connection_lost(django_error(OperationalError, cause))


@pytest.mark.parametrize(
    "error",
    [
        django_error(OperationalError, psycopg.errors.QueryCanceled("statement timeout")),
        django_error(OperationalError, psycopg.errors.DeadlockDetected("deadlock detected")),
        django_error(OperationalError, psycopg.errors.TooManyConnections("too many clients")),
        django_error(IntegrityError, psycopg.errors.UniqueViolation("duplicate key")),
        django_error(ProgrammingError, psycopg.errors.UndefinedTable("no such relation")),
        django_error(InterfaceError, psycopg.InterfaceError("the cursor is closed")),
        django_error(OperationalError, ValueError("SQLite: database is locked")),
        psycopg.errors.AdminShutdown("not wrapped by Django"),
        RuntimeError("not a database error"),
    ],
    ids=lambda error: type(error).__name__ + ":" + str(error)[:20],
)
def test_real_errors_are_not_a_lost_connection(error):
    assert not database.connection_lost(error)


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def errors(caplog):
    return [record.getMessage() for record in caplog.records if record.levelno >= logging.ERROR]


def test_a_short_outage_backs_off_and_only_warns(caplog):
    clock = Clock()
    outage = database.Outage(clock)
    waits = []
    for _ in range(7):
        waits.append(outage.lost(lost()))
        clock.now += waits[-1]
    assert waits == [1, 2, 4, 8, 16, 30, 30]
    assert clock.now < database.REPORT_AFTER_SECONDS
    assert not errors(caplog)
    assert "database_unavailable seconds=0 error=AdminShutdown retry_in=1" in caplog.messages
    outage.ended()
    assert "database_available seconds=91" in caplog.messages
    assert outage.lost(lost()) == 1


def test_an_outage_of_several_minutes_is_reported_once(caplog):
    clock = Clock()
    outage = database.Outage(clock)
    while clock.now < 2 * database.REPORT_AFTER_SECONDS:
        clock.now += outage.lost(lost())
    assert errors(caplog) == ["database_unreachable seconds=301 error=AdminShutdown"]
    outage.ended()
    caplog.clear()
    while clock.now < 4 * database.REPORT_AFTER_SECONDS:
        clock.now += outage.lost(lost())
    assert len(errors(caplog)) == 1


@pytest.mark.django_db
def test_a_job_that_loses_its_connection_runs_again_once_the_database_is_back(
    accepted, monkeypatch
):
    job = Job.objects.get(kind="render")
    runs = []

    def run(job, lease):
        runs.append(job.attempts)
        if len(runs) == 1:
            raise lost()
        lease.finish()

    monkeypatch.setattr(RENDER, "run", run)
    with pytest.raises(Interrupted) as interruption:
        run_one()
    job.refresh_from_db()
    assert job.state == "running"
    queued = job.run_after
    interruption.value.lease.abandon()
    job.refresh_from_db()
    accepted.refresh_from_db()
    assert (job.state, job.error_code, job.run_after) == ("pending", "worker_interrupted", queued)
    assert (job.lease_token, accepted.state) == (None, Claim.State.RECEIVED)
    assert run_one()
    job.refresh_from_db()
    assert (runs, job.state) == ([1, 2], "done")


@pytest.mark.django_db
def test_an_email_that_loses_its_connection_is_never_sent_twice(accepted, monkeypatch):
    Job.objects.exclude(kind="confirm").delete()
    job = Job.objects.get()

    def run(job, lease):
        raise lost()

    monkeypatch.setattr(KINDS["confirm"], "run", run)
    with pytest.raises(Interrupted) as interruption:
        run_one()
    interruption.value.lease.abandon()
    job.refresh_from_db()
    assert (job.state, job.error_code) == ("failed", "send_unknown")
    assert accepted.confirmation.state == "send_unknown"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "error",
    [
        django_error(OperationalError, psycopg.errors.QueryCanceled("statement timeout")),
        django_error(IntegrityError, psycopg.errors.UniqueViolation("duplicate key")),
    ],
    ids=["timeout", "integrity"],
)
def test_real_database_errors_still_fail_the_job(accepted, monkeypatch, caplog, error):
    job = Job.objects.get(kind="render")

    def run(job, lease):
        raise error

    monkeypatch.setattr(RENDER, "run", run)
    assert run_one()
    job.refresh_from_db()
    assert (job.state, job.error_code) == ("failed", "processing_error")
    assert errors(caplog) == [f"job_failed job={job.pk} kind=render"]


def scripted(*outcomes):
    """`Command.work` that raises or returns each outcome in turn."""
    outcomes, calls = list(outcomes), []

    def work(self):
        calls.append(len(calls))
        outcome = outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    return work, calls


def worker_sleeps(monkeypatch, then=None):
    """Record the worker's sleeps instead of sleeping; `then(count)` after each."""
    sleeps = []

    def record(seconds):
        sleeps.append(seconds)
        if then:
            then(len(sleeps))

    monkeypatch.setattr(run_jobs, "time", SimpleNamespace(sleep=record, monotonic=time.monotonic))
    return sleeps


def raising_from(exception, cause):
    try:
        raise exception from cause
    except type(exception) as exc:
        return exc


def test_worker_waits_out_a_lost_connection_with_backoff(monkeypatch, caplog):
    work, calls = scripted(lost(), lost(), lost(), True)
    monkeypatch.setattr(Command, "work", work)
    sleeps = worker_sleeps(monkeypatch)
    call_command("run_jobs", once=True)
    assert (len(calls), sleeps) == (4, [1, 2, 4])
    assert not errors(caplog)
    assert "database_available seconds=0" in caplog.messages


def test_worker_hands_on_an_interrupted_job_before_the_next_one(monkeypatch):
    abandoned = []
    lease = SimpleNamespace(job=SimpleNamespace(pk=1))
    # The database is still away at the first try to hand the job on.
    attempts = iter([lost(), None])

    def abandon():
        abandoned.append(len(calls))
        if failure := next(attempts):
            raise failure

    lease.abandon = abandon
    work, calls = scripted(raising_from(Interrupted(lease), lost()), True)
    monkeypatch.setattr(Command, "work", work)
    sleeps = worker_sleeps(monkeypatch)
    call_command("run_jobs", once=True)
    assert (abandoned, len(calls), sleeps) == ([1, 1], 2, [1, 2])


def test_worker_still_stops_on_a_real_database_error(monkeypatch):
    error = django_error(OperationalError, psycopg.errors.DiskFull("could not extend file"))
    work, _ = scripted(error)
    monkeypatch.setattr(Command, "work", work)
    with pytest.raises(OperationalError):
        call_command("run_jobs", once=True)


def postgresql_only():
    if connection.vendor != "postgresql":
        pytest.skip("Terminating a connection requires PostgreSQL.")


def terminate(pid):
    """What PostgreSQL does to every session when it shuts down for a restart."""
    admin = connections.create_connection("default")
    try:
        with admin.cursor() as cursor:
            cursor.execute("SELECT pg_terminate_backend(%s)", [pid])
            for _ in range(100):
                cursor.execute("SELECT 1 FROM pg_stat_activity WHERE pid = %s", [pid])
                if not cursor.fetchone():
                    return
                time.sleep(0.05)
        raise AssertionError(f"backend {pid} still running")
    finally:
        admin.close()


def backend_pid():
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        return cursor.fetchone()[0]


def closed_port():
    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        return unused.getsockname()[1]


@pytest.mark.django_db(transaction=True)
def test_worker_carries_on_across_a_database_restart(prepared, uploaded_file, monkeypatch, caplog):
    postgresql_only()
    upload, job = queued_upload(prepared, uploaded_file)
    validate, settings_dict = KINDS["validate"], connection.settings_dict
    host, port = settings_dict["HOST"], settings_dict["PORT"]
    real_run, runs = validate.run, []

    def run_during_restart(job, lease):
        runs.append(job.attempts)
        if len(runs) == 1:
            # PostgreSQL ends the session, then refuses connections while it starts again.
            terminate(backend_pid())
            settings_dict["HOST"], settings_dict["PORT"] = "127.0.0.1", closed_port()
            upload.refresh_from_db()
        real_run(job, lease)

    def started_again(count):
        if count == 3:
            settings_dict["HOST"], settings_dict["PORT"] = host, port

    monkeypatch.setattr(validate, "run", run_during_restart)
    sleeps = worker_sleeps(monkeypatch, started_again)
    monkeypatch.setitem(settings_dict, "HOST", host)
    monkeypatch.setitem(settings_dict, "PORT", port)
    call_command("run_jobs", once=True)

    job.refresh_from_db()
    upload.refresh_from_db()
    assert (runs, sleeps) == ([1, 2], [1, 2, 4])
    assert (job.state, job.attempts, upload.state) == ("done", 2, "ready")
    assert not errors(caplog)
    # Error and wait of each warning: the ended session, then two refused connections.
    warnings = [record.args[1:] for record in caplog.records if record.levelno == logging.WARNING]
    assert warnings == [("AdminShutdown", 1), ("OperationalError", 2), ("OperationalError", 4)]


@pytest.mark.django_db(transaction=True)
def test_a_kept_connection_is_checked_after_a_restart(form):
    """Web requests and the worker keep connections for a minute (CONN_MAX_AGE)."""
    postgresql_only()
    terminate(backend_pid())
    # What every request and every round of the worker starts with.
    close_old_connections()
    assert Form.objects.get() == form
