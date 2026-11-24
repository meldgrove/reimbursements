-- The operator name and the legal page move into Admin > General (PORTAL_OPERATOR and
-- PORTAL_LEGAL_URL up to 0.5.0), and the app remembers which variables of earlier
-- versions' environment it has copied into the settings (services/environment-import.ts).
-- The columns have defaults, so 0.4 and 0.5.0 still run after a rollback.
CREATE TABLE "portal_environmentimport" (
	"variable" varchar(64) PRIMARY KEY NOT NULL,
	"copied" boolean NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_appsettings" ADD COLUMN "operator" varchar(200) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_appsettings" ADD COLUMN "legal_url" varchar(500) DEFAULT '' NOT NULL;