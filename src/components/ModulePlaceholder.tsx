import type { IconName } from "@/lib/navigation";
import { Icon } from "./icons";

interface ModulePlaceholderProps {
  title: string;
  description: string;
  icon?: IconName;
}

export function ModulePlaceholder({
  title,
  description,
  icon = "orders",
}: ModulePlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-input-border bg-surface px-6 py-20 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-muted text-fg-muted">
        <Icon name={icon} className="h-7 w-7" />
      </div>
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-fg-muted">{description}</p>
      <span className="mt-5 inline-flex items-center rounded-full bg-warning-bg px-3 py-1 text-xs font-medium text-warning-fg">
        Módulo em desenvolvimento
      </span>
    </div>
  );
}
