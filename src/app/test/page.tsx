"use client";
import { RunList } from "@/components/RunList";
import { useI18n } from "@/lib/client/i18n";
export default function TestPage() {
  const { t } = useI18n();
  return <RunList context="test" title={t("weeklyTest")} pick={(p) => p.test?.exercises ?? []} />;
}
