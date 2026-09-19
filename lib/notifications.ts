import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

interface CreateNotificationInput {
  recipientId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  emailSubject?: string;
}

export interface NotificationDeliveryResult {
  stored: boolean;
  email: "sent" | "failed" | "skipped";
  error?: string;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function updateEmailDelivery(
  notificationId: string,
  values: Record<string, string | null>,
) {
  const supabase = createAdminClient();
  if (!supabase) return;
  let update = supabase.from("notifications").update(values).eq("id", notificationId);
  // A simultaneous webhook attempt may fail after another delivery succeeded.
  if (values.email_status !== "sent") update = update.neq("email_status", "sent");
  const { error } = await update;
  if (error) throw new Error(error.message);
}

export async function createNotification(input: CreateNotificationInput): Promise<NotificationDeliveryResult> {
  const supabase = createAdminClient();
  if (!supabase) return { stored: false, email: "skipped", error: "Supabase admin client is not configured" };

  const resendApiKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.NOTIFICATION_EMAIL_FROM;
  const emailConfigured = Boolean(resendApiKey && emailFrom);
  const { data: notification, error: insertError } = await supabase
    .from("notifications")
    .insert({
      recipient_id: input.recipientId,
      type: input.type,
      title: input.title,
      message: input.message,
      data: { ...input.data, ...(input.emailSubject ? { emailSubject: input.emailSubject } : {}) },
      email_status: emailConfigured ? "pending" : "skipped",
    })
    .select("id")
    .single();

  if (insertError || !notification) {
    return { stored: false, email: "skipped", error: insertError?.message ?? "Notification was not stored" };
  }
  if (!emailConfigured) return { stored: true, email: "skipped" };

  return deliverStoredNotificationEmail(notification.id);
}

// Both application-created alerts and database-created alerts share delivery.
export async function deliverStoredNotificationEmail(notificationId: string): Promise<NotificationDeliveryResult> {
  const supabase = createAdminClient();
  if (!supabase) return { stored: false, email: "skipped", error: "Supabase admin client is not configured" };
  const { data: notification, error } = await supabase.from("notifications")
    .select("id, recipient_id, title, message, data, email_status, created_at")
    .eq("id", notificationId).maybeSingle();
  if (error || !notification) return { stored: false, email: "failed", error: error?.message ?? "Notification not found" };
  if (notification.email_status === "sent" || notification.email_status === "skipped") {
    return { stored: true, email: notification.email_status };
  }
  // Resend retains idempotency keys for 24 hours. Do not automatically resend
  // an older uncertain delivery after that protection expires.
  if (Date.now() - new Date(notification.created_at).getTime() > 23 * 60 * 60 * 1000) {
    return { stored: true, email: "failed", error: "Delivery requires manual review after 23 hours" };
  }
  const resendApiKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.NOTIFICATION_EMAIL_FROM;
  if (!resendApiKey || !emailFrom) return { stored: true, email: "failed", error: "Notification email is not configured" };
  const input = {
    recipientId: notification.recipient_id,
    title: notification.title,
    message: notification.message,
    emailSubject: typeof notification.data?.emailSubject === "string" ? notification.data.emailSubject : notification.title,
  };
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", input.recipientId)
    .maybeSingle();
  if (profileError || !profile?.email) {
    const error = profileError?.message ?? "Recipient has no email address";
    await updateEmailDelivery(notification.id, { email_status: "failed", email_error: error.slice(0, 500) });
    return { stored: true, email: "failed", error };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `notification-${notification.id}`,
        "User-Agent": "FRC190-Manufacturing/1.0",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [profile.email],
        subject: input.emailSubject ?? input.title,
        text: `${input.title}\n\n${input.message}`,
        html: `<h2>${escapeHtml(input.title)}</h2><p>${escapeHtml(input.message)}</p>`,
      }),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !result.id) {
      const error = result.message ?? `Email provider returned ${response.status}`;
      await updateEmailDelivery(notification.id, { email_status: "failed", email_error: error.slice(0, 500) });
      return { stored: true, email: "failed", error };
    }

    await updateEmailDelivery(notification.id, {
      email_status: "sent",
      email_sent_at: new Date().toISOString(),
      email_provider_id: result.id,
      email_error: null,
    });
    return { stored: true, email: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed";
    await updateEmailDelivery(notification.id, { email_status: "failed", email_error: message.slice(0, 500) });
    return { stored: true, email: "failed", error: message };
  }
}

export async function deliverObsoletionEmails(requirementId: number, version: number) {
  const supabase = createAdminClient();
  if (!supabase) return;
  const { data, error } = await supabase.from("notifications").select("id")
    .eq("type", "production_requirement_obsolete")
    .contains("data", { requirementId, obsoletionVersion: version });
  if (error) throw new Error(error.message);
  for (const notification of data ?? []) {
    const result = await deliverStoredNotificationEmail(notification.id);
    if (result.email === "failed") console.error("Obsoletion email delivery failed", result.error);
  }
}
