CREATE TABLE "telegram_entities" (
	"id" bigint PRIMARY KEY NOT NULL,
	"entity_kind" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_entity_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_id" bigint NOT NULL,
	"entity_kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"username" text,
	"active_usernames" text[],
	"display_name" text,
	"bio" text,
	"photo_file_unique_id" text,
	"is_premium" boolean,
	"member_count" integer,
	"is_bot" boolean,
	"source" text NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "telegram_migration_edges" (
	"from_entity_id" bigint NOT NULL,
	"to_entity_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_username_bindings" (
	"username" text NOT NULL,
	"entity_id" bigint NOT NULL,
	"bound_from" timestamp with time zone NOT NULL,
	"bound_to" timestamp with time zone,
	"is_collectible" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_entity_snapshots" ADD CONSTRAINT "telegram_entity_snapshots_entity_id_telegram_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."telegram_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_entity_snapshots_entity_observed_idx" ON "telegram_entity_snapshots" USING btree ("entity_id","observed_at");--> statement-breakpoint
CREATE INDEX "telegram_entity_snapshots_username_idx" ON "telegram_entity_snapshots" USING btree ("username");--> statement-breakpoint
CREATE INDEX "telegram_entity_snapshots_photo_idx" ON "telegram_entity_snapshots" USING btree ("photo_file_unique_id");--> statement-breakpoint
CREATE INDEX "telegram_migration_edges_from_idx" ON "telegram_migration_edges" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "telegram_migration_edges_to_idx" ON "telegram_migration_edges" USING btree ("to_entity_id");--> statement-breakpoint
CREATE INDEX "telegram_username_bindings_username_idx" ON "telegram_username_bindings" USING btree ("username","bound_from");--> statement-breakpoint
CREATE INDEX "telegram_username_bindings_entity_idx" ON "telegram_username_bindings" USING btree ("entity_id");