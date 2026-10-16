ALTER TABLE "users" ADD COLUMN "stripe_ended_subscription_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_event_at" timestamp with time zone;