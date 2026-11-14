"""SQLite: короткие транзакции, неизменные версии и исходные результаты поиска."""

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pydantic import TypeAdapter

from app.api.models import Message, Procurement, ProcurementSummary, VersionInfo
from app.config import CalculationSnapshot, SourceConfig
from app.models import Edit, ParsedTZ, Report, ResearchRun

MESSAGES = TypeAdapter(Message)
EDITS = TypeAdapter(list[Edit])


def now():
    return datetime.now(UTC)


def new_id(prefix):
    return f"{prefix}_{uuid4().hex}"


class Repo:
    def __init__(self, db_path: Path):
        self.path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS procurements (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, filename TEXT, tz_text TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'new', parsed_json TEXT, snapshot_json TEXT,
                    sources_json TEXT, agent_busy INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS messages (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                    procurement_id TEXT NOT NULL REFERENCES procurements(id), body TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS messages_proc ON messages(procurement_id, seq);
                CREATE TABLE IF NOT EXISTS research_runs (
                    id TEXT PRIMARY KEY, procurement_id TEXT NOT NULL REFERENCES procurements(id),
                    active INTEGER NOT NULL, body TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS edits (
                    id TEXT PRIMARY KEY, procurement_id TEXT NOT NULL REFERENCES procurements(id),
                    seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(procurement_id, seq)
                );
                CREATE TABLE IF NOT EXISTS report_versions (
                    procurement_id TEXT NOT NULL REFERENCES procurements(id), version INTEGER,
                    body TEXT NOT NULL, run_ids TEXT NOT NULL, edits_json TEXT NOT NULL,
                    PRIMARY KEY(procurement_id, version)
                );
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, procurement_id TEXT NOT NULL
                    REFERENCES procurements(id), kind TEXT NOT NULL, payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued'
                );
                PRAGMA user_version=1;
            """)
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def create_procurement(self, title, filename, tz_text, messages=()):
        pid, at = new_id("p"), now().isoformat()
        with self.connect() as db:
            db.execute(
                "INSERT INTO procurements(id,title,created_at,updated_at,filename,tz_text) "
                "VALUES(?,?,?,?,?,?)",
                (pid, title, at, at, filename, tz_text),
            )
            for message in messages:
                self._message(db, pid, message)
        return pid

    def state(self, pid):
        with self.connect() as db:
            row = db.execute("SELECT * FROM procurements WHERE id=?", (pid,)).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["parsed"] = (
            ParsedTZ.model_validate_json(row["parsed_json"]) if row["parsed_json"] else None
        )
        data["snapshot"] = (
            CalculationSnapshot.model_validate_json(row["snapshot_json"])
            if row["snapshot_json"]
            else None
        )
        data["sources"] = TypeAdapter(list[SourceConfig]).validate_json(row["sources_json"] or "[]")
        return data

    def get_procurement(self, pid):
        data = self.state(pid)
        if data is None:
            return None
        report = self.get_report(pid)
        fields = {k: data[k] for k in ("id", "title", "created_at", "updated_at", "status")}
        return Procurement(
            **fields,
            filename=data["filename"],
            agent_busy=bool(data["agent_busy"]),
            messages=self.list_messages(pid),
            latest_version=report.version if report else None,
            total=report.total if report else None,
            total_justified=report.total_justified if report else None,
            positions_total=len(data["parsed"].positions) if data["parsed"] else 0,
            positions_unjustified=sum(p.status != "ok" for p in report.positions) if report else 0,
        )

    def list_procurements(self):
        with self.connect() as db:
            ids = [r[0] for r in db.execute("SELECT id FROM procurements ORDER BY created_at DESC")]
        return [
            ProcurementSummary.model_validate(
                self.get_procurement(pid).model_dump(include=set(ProcurementSummary.model_fields))
            )
            for pid in ids
        ]

    @staticmethod
    def _message(db, pid, message):
        db.execute(
            "INSERT INTO messages(id,procurement_id,body) VALUES(?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            (message.id, pid, message.model_dump_json()),
        )

    def save_message(self, pid, message):
        with self.connect() as db:
            self._message(db, pid, message)

    def list_messages(self, pid):
        with self.connect() as db:
            return [
                MESSAGES.validate_json(r[0])
                for r in db.execute(
                    "SELECT body FROM messages WHERE procurement_id=? ORDER BY seq", (pid,)
                )
            ]

    def update(self, pid, **fields):
        allowed = {"title", "status", "agent_busy", "parsed_json", "snapshot_json", "sources_json"}
        if not fields or fields.keys() - allowed:
            raise ValueError("Неизвестные поля закупки")
        fields["updated_at"] = now().isoformat()
        with self.connect() as db:
            db.execute(
                "UPDATE procurements SET " + ",".join(f"{k}=?" for k in fields) + " WHERE id=?",
                (*fields.values(), pid),
            )

    def get_report(self, pid, version=None):
        with self.connect() as db:
            if version is None:
                row = db.execute(
                    "SELECT body FROM report_versions WHERE procurement_id=? "
                    "ORDER BY version DESC LIMIT 1",
                    (pid,),
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT body FROM report_versions WHERE procurement_id=? AND version=?",
                    (pid, version),
                ).fetchone()
        return Report.model_validate_json(row[0]) if row else None

    def list_versions(self, pid):
        with self.connect() as db:
            reports = [
                Report.model_validate_json(r[0])
                for r in db.execute(
                    "SELECT body FROM report_versions WHERE procurement_id=? ORDER BY version",
                    (pid,),
                )
            ]
        return [
            VersionInfo.model_validate(r.model_dump(include=set(VersionInfo.model_fields)))
            for r in reports
        ]

    def runs(self, pid):
        with self.connect() as db:
            return [
                ResearchRun.model_validate_json(r[0])
                for r in db.execute(
                    "SELECT body FROM research_runs WHERE procurement_id=? "
                    "AND active=1 ORDER BY rowid",
                    (pid,),
                )
            ]

    def edits(self, pid):
        with self.connect() as db:
            return [
                TypeAdapter(Edit).validate_json(r[0])
                for r in db.execute(
                    "SELECT body FROM edits WHERE procurement_id=? ORDER BY seq", (pid,)
                )
            ]

    def commit_state(self, pid, *, edits, runs, report=None, messages=()):
        """Правки, набор результатов, версия и карточки фиксируются одной транзакцией."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if report is not None:
                version = db.execute(
                    "SELECT COALESCE(MAX(version),0)+1 FROM report_versions WHERE procurement_id=?",
                    (pid,),
                ).fetchone()[0]
                if report.version != version or report.procurement_id != pid:
                    raise ValueError("Версия отчёта устарела или относится к другой закупке")
            for edit in edits:
                existing = db.execute(
                    "SELECT procurement_id,body FROM edits WHERE id=?", (edit.id,)
                ).fetchone()
                if existing:
                    previous = TypeAdapter(Edit).validate_json(existing["body"])
                    if existing["procurement_id"] != pid or previous.model_dump(
                        exclude={"status"}
                    ) != edit.model_dump(exclude={"status"}):
                        raise ValueError("Содержимое существующей правки неизменно")
                db.execute(
                    "INSERT INTO edits(id,procurement_id,seq,body) VALUES(?,?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET body=excluded.body",
                    (edit.id, pid, edit.seq, TypeAdapter(Edit).dump_json(edit).decode()),
                )
            db.execute("UPDATE research_runs SET active=0 WHERE procurement_id=?", (pid,))
            for run in runs:
                if run.procurement_id != pid:
                    raise ValueError("Результаты поиска относятся к другой закупке")
                existing = db.execute(
                    "SELECT body FROM research_runs WHERE id=?", (run.id,)
                ).fetchone()
                if existing and existing[0] != run.model_dump_json():
                    raise ValueError("Исходные результаты поиска неизменны; нужен новый ID")
                db.execute(
                    "INSERT INTO research_runs(id,procurement_id,active,body) VALUES(?,?,1,?) "
                    "ON CONFLICT(id) DO UPDATE SET active=1",
                    (run.id, pid, run.model_dump_json()),
                )
            if report is not None:
                db.execute(
                    "INSERT INTO report_versions VALUES(?,?,?,?,?)",
                    (
                        pid,
                        report.version,
                        report.model_dump_json(),
                        json.dumps([r.id for r in runs]),
                        EDITS.dump_json(edits).decode(),
                    ),
                )
            for message in messages:
                self._message(db, pid, message)
            db.execute("UPDATE procurements SET updated_at=? WHERE id=?", (now().isoformat(), pid))

    def get_setting(self, key):
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_settings(self, values):
        with self.connect() as db:
            for key, value in values.items():
                db.execute(
                    "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) "
                    "DO UPDATE SET value=excluded.value",
                    (key, value),
                )

    def enqueue(self, pid, kind, payload, message=None):
        with self.connect() as db:
            if message:
                self._message(db, pid, message)
            db.execute(
                "INSERT INTO jobs(procurement_id,kind,payload) VALUES(?,?,?)",
                (pid, kind, json.dumps(payload, ensure_ascii=False)),
            )

    def next_job(self, pid):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM jobs WHERE procurement_id=? AND status='queued' "
                "ORDER BY seq LIMIT 1",
                (pid,),
            ).fetchone()
            if row:
                db.execute("UPDATE jobs SET status='running' WHERE seq=?", (row["seq"],))
        return dict(row) | {"payload": json.loads(row["payload"])} if row else None

    def finish_job(self, seq):
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='done' WHERE seq=?", (seq,))

    def recover(self):
        """Прерванные операции не повторяем: уже выполненные инструменты могли сохраниться."""
        with self.connect() as db:
            interrupted = [
                r[0]
                for r in db.execute(
                    "SELECT id FROM procurements WHERE status='running' OR agent_busy=1 "
                    "UNION SELECT procurement_id FROM jobs WHERE status='running'"
                )
            ]
            db.execute("UPDATE jobs SET status='done' WHERE status='running'")
            for pid in interrupted:
                ready = db.execute(
                    "SELECT 1 FROM report_versions WHERE procurement_id=?", (pid,)
                ).fetchone()
                db.execute(
                    "UPDATE procurements SET status=?, agent_busy=0 WHERE id=?",
                    ("ready" if ready else "failed", pid),
                )
            queued = [
                r[0]
                for r in db.execute(
                    "SELECT DISTINCT procurement_id FROM jobs WHERE status='queued'"
                )
            ]
        return interrupted, queued
