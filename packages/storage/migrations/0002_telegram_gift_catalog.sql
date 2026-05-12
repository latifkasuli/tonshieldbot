CREATE TABLE "telegram_gift_catalog" (
	"gift_id" text PRIMARY KEY NOT NULL,
	"publisher_chat_id" bigint,
	"publisher_chat_username" text,
	"publisher_chat_title" text,
	"publisher_chat_type" text,
	"star_count" integer NOT NULL,
	"upgrade_star_count" integer,
	"total_count" integer,
	"remaining_count" integer,
	"sticker_file_unique_id" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE INDEX "telegram_gift_catalog_publisher_chat_idx" ON "telegram_gift_catalog" USING btree ("publisher_chat_id");--> statement-breakpoint
CREATE INDEX "telegram_gift_catalog_last_refreshed_idx" ON "telegram_gift_catalog" USING btree ("last_refreshed_at");