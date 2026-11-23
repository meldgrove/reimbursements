CREATE TABLE "portal_session" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(12) NOT NULL,
	"user_id" integer,
	"id_token" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portal_session_kind_check" CHECK ("portal_session"."kind" in ('admin', 'participant'))
);
--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_user_id_fk_auth_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_session_expires_at_idx" ON "portal_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "portal_session_user_id_idx" ON "portal_session" USING btree ("user_id");