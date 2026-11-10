"use client";
import { RunList } from "@/components/RunList";
import { useI18n } from "@/lib/client/i18n";
export default function ReviewPage() {
  const { t } = useI18n();
  return <RunList context="review" title={t("reviews")} pick={(p) => p.maintenance?.reviews ?? []} />;
}
