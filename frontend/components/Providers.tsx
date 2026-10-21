"use client";

import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";
import { Shell } from "./Shell";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <Shell>{children}</Shell>
    </I18nProvider>
  );
}
