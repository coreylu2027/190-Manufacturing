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
  await supabase.from("notifications").update(values).eq("id", notificationId);
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
      data: input.data ?? {},
      email_status: emailConfigured ? "pending" : "skipped",
    })
    .select("id")
    .single();

  if (insertError || !notification) {
    return { stored: false, email: "skipped", error: insertError?.message ?? "Notification was not stored" };
  }
  if (!emailConfigured) return { stored: true, email: "skipped" };

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
